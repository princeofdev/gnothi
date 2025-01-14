import enum, pdb, re, threading, time, datetime, traceback
from typing import Optional, List, Any, Dict, Union
from pydantic import BaseModel, UUID4
import pytz
from uuid import uuid4
import dateutil
import pandas as pd
import logging
logger = logging.getLogger(__name__)

from database import Base, fa_users_db, session
from utils import vars

from sqlalchemy import text as satext, Column, Integer, Enum, Float, ForeignKey, Boolean, JSON, Date, Unicode, \
    func, TIMESTAMP, select, or_, and_
from psycopg2.extras import Json as jsonb
from sqlalchemy.ext.hybrid import hybrid_property
from sqlalchemy.orm import relationship, backref, object_session, column_property
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy_utils.types import EmailType
from sqlalchemy_utils.types.encrypted.encrypted_type import StringEncryptedType, FernetEngine


from fastapi_sqlalchemy import db  # an object to provide global access to a database session
from fastapi_users import models as fu_models
from fastapi_users.db import SQLAlchemyBaseUserTable, SQLAlchemyUserDatabase


# Schemas naming convention: SOModel for "schema out model", SIModel for "schema in"
class SOut(BaseModel):
    class Config:
        orm_mode = True


# https://dev.to/zchtodd/sqlalchemy-cascading-deletes-8hk
parent_cascade = dict(cascade="all, delete", passive_deletes=True)
child_cascade = dict(ondelete="cascade")

# Note: using sa.Unicode for all Text/Varchar columns to be consistent with sqlalchemy_utils examples. Also keeping all
# text fields unlimited (no varchar(max_length)) as Postgres doesn't incur penalty, unlike MySQL, and we don't know
# how long str will be after encryption.
def Encrypt(Col=Unicode, array=False, **args):
    enc = StringEncryptedType(Col, vars.FLASK_KEY, FernetEngine)
    if array: enc = ARRAY(enc)
    return Column(enc, **args)

# TODO should all date-cols be index=True? (eg sorting, filtering)
def DateCol(default=True, update=False, **kwargs):
    args = {}
    # Using utcnow here caused double utc (add more hours), why? Just using now() for now,
    # and assuming you're DB server is set on UTC
    if default: args['server_default'] = satext("now()")
    if update: args['onupdate'] = satext("now()")
    return Column(TIMESTAMP(timezone=True), index=True, **args, **kwargs)

def IDCol():
    return Column(UUID(as_uuid=True), primary_key=True, server_default=satext("uuid_generate_v4()"))

def FKCol(fk, **kwargs):
    return Column(UUID(as_uuid=True), ForeignKey(fk, **child_cascade), **kwargs)



class User(Base, SQLAlchemyBaseUserTable):
    __tablename__ = 'users'

    created_at = DateCol()
    updated_at = DateCol(update=True)

    first_name = Encrypt()
    last_name = Encrypt()
    gender = Encrypt()
    orientation = Encrypt()
    birthday = Column(Date)  # TODO encrypt (how to store/migrate dates?)
    timezone = Column(Unicode)
    bio = Encrypt()
    is_cool = Column(Boolean, server_default='false')
    therapist = Column(Boolean, server_default='false')
    paid = Column(Boolean)

    ai_ran = Column(Boolean, server_default='false')
    last_books = DateCol(default=False)
    last_influencers = DateCol(default=False)

    habitica_user_id = Encrypt()
    habitica_api_token = Encrypt()

    entries = relationship("Entry", order_by='Entry.created_at.desc()', **parent_cascade)
    field_entries = relationship("FieldEntry", order_by='FieldEntry.created_at.desc()', **parent_cascade)
    fields = relationship("Field", order_by='Field.created_at.asc()', **parent_cascade)
    people = relationship("Person", order_by='Person.name.asc()', **parent_cascade)
    shares = relationship("Share", **parent_cascade)
    tags = relationship("Tag", order_by='Tag.name.asc()', **parent_cascade)

    @staticmethod
    def snoop(viewer, as_id=None):
        as_user, snooping = None, False
        if as_id and viewer.id != as_id:
            snooping = True
            as_user = db.session.query(User) \
                .join(Share) \
                .filter(Share.email == viewer.email, Share.user_id == as_id) \
                .first()
        if as_user:
            as_user.share_data = db.session.query(Share) \
                .filter_by(user_id=as_id, email=viewer.email) \
                .first()
        else:
            as_user = viewer
        return as_user, snooping

    @property
    def shared_with_me(self):
        # 9cc44d55: sqlalchemy join. Can't figure out sa select diff cols from join tables
        return db.session.execute("""
        select s.*, u.* from users u
        inner join shares s on s.email=:email and u.id=s.user_id
        """, {'email': self.email}).fetchall()

    def profile_to_text(self):
        txt = ''
        if self.gender:
            txt += f"I am {self.gender}. "
        if self.orientation and not re.match("straight", self.orientation, re.IGNORECASE):
            txt += f"I am {self.orientation}. "
        if self.bio:
            txt += self.bio
        for p in self.people:
            whose = "" if "'" in p.relation.split(' ')[0] else "my "
            txt += f"{p.name} is {whose}{p.relation}. "
            if p.bio: txt += p.bio
            # if p.issues: txt += f" {p.name} has these issues: {p.issues} "
        txt = re.sub(r'\s+', ' ', txt)
        # print(txt)
        return txt

    @staticmethod
    def last_checkin(sess):
        return sess.execute(f"""
        select extract(
            epoch FROM (now() - max(updated_at))
        ) / 60 as mins
        from users limit 1 
        """).fetchone().mins or 99

    @staticmethod
    def tz(sess, user_id):
        return sess.execute(satext(f"""
        select coalesce(timezone, 'America/Los_Angeles') as tz
        from users where id=:user_id
        """), dict(user_id=user_id)).fetchone().tz

class FU_User(fu_models.BaseUser): pass
class FU_UserCreate(fu_models.BaseUserCreate): pass
class FU_UserUpdate(FU_User, fu_models.BaseUserUpdate): pass
class FU_UserDB(FU_User, fu_models.BaseUserDB): pass
user_db = SQLAlchemyUserDatabase(FU_UserDB, fa_users_db, User.__table__)


class SITimezone(BaseModel):
    timezone: Optional[str] = None


class SIHabitica(BaseModel):
    habitica_user_id: Optional[str] = None
    habitica_api_token: Optional[str] = None


class SIProfile(SITimezone):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    orientation: Optional[str] = None
    gender: Optional[str] = None
    birthday: Optional[Any] = None
    bio: Optional[str] = None
    therapist: Optional[bool] = False


class SOProfile(SIProfile, SOut):
    pass


class SOSharedWithMe(SOProfile):
    id: UUID4
    email: str
    new_entries: Optional[int]
    last_seen: Optional[datetime.datetime]

    profile: Optional[bool]
    books: Optional[bool]
    fields_: Optional[bool]

    class Config:
        fields = {'fields_': 'fields'}


class SOUser(FU_User, fu_models.BaseUserDB):
    timezone: Optional[Any] = None
    habitica_user_id: Optional[str] = None
    habitica_api_token: Optional[str] = None
    is_cool: Optional[bool] = False
    shared_with_me: Optional[List[SOSharedWithMe]]
    paid: Optional[bool] = False


class Entry(Base):
    __tablename__ = 'entries'

    id = IDCol()
    created_at = DateCol()
    updated_at = DateCol(update=True)

    # Title optional, otherwise generated from text. topic-modeled, or BERT summary, etc?
    title = Encrypt()
    text = Encrypt(Unicode, nullable=False)
    no_ai = Column(Boolean, server_default='false')
    ai_ran = Column(Boolean, server_default='false')

    # Generated
    title_summary = Encrypt()
    text_summary = Encrypt()
    sentiment = Encrypt()

    user_id = FKCol('users.id', index=True)
    entry_tags_ = relationship("EntryTag", **parent_cascade)

    # share_tags = relationship("EntryTag", secondary="shares_tags")

    @property
    def entry_tags(self):
        return {t.tag_id: True for t in self.entry_tags_}

    @staticmethod
    def snoop(
        viewer_email: str,
        target_id: str,
        snooping: bool = False,
        entry_id: str = None,
        order_by=None,
        tags: List[str] = None,
        days: int = None,
        for_ai: bool = False
    ):
        if not snooping:
            q = db.session.query(Entry).filter(Entry.user_id == target_id)
        if snooping:
            q = db.session.query(Entry)\
                .join(EntryTag, Entry.id == EntryTag.entry_id)\
                .join(ShareTag, EntryTag.tag_id == ShareTag.tag_id)\
                .join(Share, ShareTag.share_id == Share.id)\
                .filter(Share.email == viewer_email, Share.user_id == target_id)
            # TODO use ORM partial thus far for this query command, not raw sql
            sql = f"""
            update shares set last_seen=now(), new_entries=0
            where email=:email and user_id=:uid
            """
            db.session.execute(satext(sql), dict(email=viewer_email, uid=target_id))
            db.session.commit()

        if entry_id:
            q = q.filter(Entry.id == entry_id)

        if for_ai:
            q = q.filter(Entry.no_ai.isnot(True))

        if tags:
            if not snooping:
                # already joined otherwise
                q = q.join(EntryTag, Tag)
            q = q.filter(EntryTag.tag_id.in_(tags))

        if days:
            now = datetime.datetime.utcnow()
            x_days = now - datetime.timedelta(days=days)
            # build a beginning-to-end story
            q = q.filter(Entry.created_at > x_days)
            order_by = Entry.created_at.asc()

        if order_by is None:
            order_by = Entry.created_at.desc()
        return q.order_by(order_by)

    def run_models(self):
        self.ai_ran = False
        if self.no_ai:
            self.title_summary = self.text_summary = self.sentiment = None
            return

        # Run summarization/sentiment in background thread, so (a) user can get back to business;
        # (b) if AI server offline, wait till online
        self.title_summary = "🕒 AI is generating a title"
        self.text_summary = "🕒 AI is generating a summary"
        # not used in nlp, but some other meta stuff
        data_in = dict(args=[str(self.id)])
        Job.create_job(method='entries', data_in=data_in)


    def update_snoopers(self):
        """Updates snoopers with n_new_entries since last_seen"""
        sql = """
        with news as (
          select s.id, count(e.id) ct 
          from shares s 
          inner join shares_tags st on st.share_id=s.id
          inner join entries_tags et on et.tag_id=st.tag_id
          inner join entries e on e.id=et.entry_id
          where e.user_id=:uid 
            and e.created_at > s.last_seen
          group by s.id
        )
        update shares s set new_entries=n.ct from news n where n.id=s.id
        """
        db.session.execute(satext(sql), {'uid': self.user_id})
        db.session.commit()


class SEntry(BaseModel):
    title: Optional[str] = None
    text: str
    no_ai: Optional[bool] = False


class SIEntry(SEntry):
    tags: dict
    created_at: Optional[str] = None


class SOEntry(SEntry, SOut):
    id: UUID4
    created_at: datetime.datetime
    ai_ran: Optional[bool] = None
    title_summary: Optional[str] = None
    text_summary: Optional[str] = None
    sentiment: Optional[str] = None
    entry_tags: Dict


class NoteTypes(enum.Enum):
    label = "label"
    note = "note"
    resource = "resource"


class Note(Base):
    __tablename__ = 'notes'
    id = IDCol()
    created_at = DateCol()
    entry_id = FKCol('entries.id', index=True)
    user_id = FKCol('users.id', index=True)
    type = Column(Enum(NoteTypes), nullable=False)
    text = Encrypt(Unicode, nullable=False)
    private = Column(Boolean, server_default='false')

    @staticmethod
    def snoop(
        viewer_id: UUID4,
        target_id: UUID4,
        entry_id: UUID4,
    ):
        # TODO use .join(ShareTag) for non-private permissions?
        return db.session.query(Note)\
            .join(Entry)\
            .filter(
                Note.entry_id == entry_id,
                or_(
                    # My own private note
                    and_(Note.private.is_(True), Note.user_id == viewer_id),
                    # Or this user can view it
                    and_(Note.private.is_(False), Entry.user_id.in_((viewer_id, target_id)))
                ))\
            .order_by(Note.created_at.asc())


class SINote(BaseModel):
    type: NoteTypes
    text: str
    private: bool


class SONote(SOut, SINote):
    id: UUID4
    user_id: UUID4
    created_at: datetime.datetime


class FieldType(enum.Enum):
    # medication changes / substance intake
    # exercise, sleep, diet, weight
    number = "number"

    # happiness score
    fivestar = "fivestar"

    # periods
    check = "check"

    # moods (happy, sad, anxious, wired, bored, ..)
    option = "option"

    # think of more
    # weather_api?
    # text entries?


class DefaultValueTypes(enum.Enum):
    value = "value"  # which includes None
    average = "average"
    ffill = "ffill"


class Field(Base):
    """Entries that change over time. Uses:
    * Charts
    * Effects of sentiment, topics on entries
    * Global trends (exercise -> 73% happiness)
    """
    __tablename__ = 'fields'

    id = IDCol()

    type = Column(Enum(FieldType))
    name = Encrypt()
    # Start entries/graphs/correlations here
    created_at = DateCol()
    # Don't actually delete fields, unless it's the same day. Instead
    # stop entries/graphs/correlations here
    excluded_at = DateCol(default=False)
    default_value = Column(Enum(DefaultValueTypes), server_default="value")
    default_value_value = Column(Float)
    # option{single_or_multi, options:[], ..}
    # number{float_or_int, ..}
    attributes = Column(JSON)
    # Used if pulling from external service
    service = Column(Unicode)
    service_id = Column(Unicode)

    user_id = FKCol('users.id', index=True)

    # Populated via ml.influencers.
    influencer_score = Column(Float, server_default='0')
    next_pred = Column(Float, server_default='0')
    avg = Column(Float, server_default="0")

    @staticmethod
    def update_avg(fid):
        db.session.execute(satext("""
        update fields set avg=(
            select avg(value) from field_entries2 fe
            where fe.field_id=:fid and fe.value is not null
        ) where id=:fid
        """), dict(fid=fid))
        db.session.commit()

    @staticmethod
    def get_history(fid):
        FE = FieldEntry
        return db.session.query(FE)\
            .with_entities(FE.value, FE.created_at)\
            .filter(FE.field_id == fid, FE.value.isnot(None), FE.created_at.isnot(None))\
            .order_by(FE.created_at.asc())\
            .all()


class SIFieldExclude(BaseModel):
    excluded_at: Optional[datetime.datetime] = None


class SIField(SIFieldExclude):
    type: FieldType
    name: str
    default_value: DefaultValueTypes
    default_value_value: Optional[float] = None


class SOFieldHistory(SOut):
    value: float
    created_at: datetime.datetime


# TODO can't get __root__ setup working
class SOField(SOut):
    id: UUID4
    type: FieldType
    name: str
    created_at: Optional[datetime.datetime] = None
    excluded_at: Optional[datetime.datetime] = None
    default_value: Optional[DefaultValueTypes] = DefaultValueTypes.value
    default_value_value: Optional[float] = None
    service: Optional[str] = None
    service_id: Optional[str] = None
    avg: Optional[float] = 0.
    influencer_score: Optional[float] = 0.
    next_pred: Optional[float] = 0.

# class SOFields(SOut):
#     __root__: Dict[UUID4, SOField]
SOFields = Dict[UUID4, SOField]


class FieldEntryOld(Base):
    """
    This is a broken table. Didn't have the right constraints and resulted in
    tons of duplicates which needed cleaning up (#20). Will remove this eventually
    and rename field_entries2 & its constraints.
    """
    __tablename__ = 'field_entries'
    id = IDCol()
    value = Column(Float)
    created_at = DateCol()
    user_id = FKCol('users.id', index=True)
    field_id = FKCol('fields.id')


at_tz = "at time zone :tz"
tz_read = f"coalesce(:day ::timestamp {at_tz}, now() {at_tz})"
tz_write = f"coalesce(:day ::timestamp {at_tz}, now())"
class FieldEntry(Base):
    __tablename__ = 'field_entries2'
    # day & field_id may be queries independently, so compound primary-key not enough - index too
    field_id = FKCol('fields.id', primary_key=True, index=True)
    day = Column(Date, primary_key=True, index=True)

    created_at = DateCol()
    value = Column(Float)  # Later consider more storage options than float
    user_id = FKCol('users.id', index=True)

    # remove these after duplicates bug handled
    dupes = Column(JSONB)
    dupe = Column(Integer, server_default="0")

    @staticmethod
    def get_day_entries(sess, user_id, day=None):
        user_id = str(user_id)
        tz = User.tz(sess, user_id)
        res = sess.execute(satext(f"""
        select fe.* from field_entries2 fe
        where fe.user_id=:user_id
        and date({tz_read})=
            --use created_at rather than day in case they switch timezones
            date(fe.created_at {at_tz})
        """), dict(user_id=user_id, day=day, tz=tz))
        return res.fetchall()

    @staticmethod
    def upsert(sess, user_id, field_id, value, day:str=None):
        """
        Create a field-entry, but if one exists for the specified day update it instead.
        """
        # Timezone-handling is very complicated. Defer as much to Postgres (rather than Python) to keep
        # to one system as much as possible. Below says "if they said a day (like '2020-11-19'), convert that
        # to a timestamp at UTC; then convert that to their own timezone". timestamptz cast first is important, see
        # https://stackoverflow.com/a/25123558/362790
        tz = User.tz(sess, user_id)
        res = sess.execute(satext(f"""
        insert into field_entries2 (user_id, field_id, value, day, created_at)
        values (:user_id, :field_id, :value, date({tz_read}), {tz_write})
        on conflict (field_id, day) do update set value=:value, dupes=null, dupe=0
        returning *
        """), dict(
            field_id=field_id,
            value=float(value),
            user_id=user_id,
            day=day,
            tz=tz
        ))
        sess.commit()
        return res.fetchone()


class SIFieldEntry(BaseModel):
    value: float


class SIFieldEntryPick(BaseModel):
    value: float
    day: str


class Person(Base):
    __tablename__ = 'people'
    id = IDCol()
    name = Encrypt()
    relation = Encrypt()
    issues = Encrypt()
    bio = Encrypt()

    user_id = FKCol('users.id', index=True)


class SIPerson(BaseModel):
    name: Optional[str] = None
    relation: Optional[str] = None
    issues: Optional[str] = None
    bio: Optional[str] = None


class SOPerson(SIPerson, SOut):
    id: UUID4
    pass


class Share(Base):
    __tablename__ = 'shares'
    id = IDCol()
    user_id = FKCol('users.id', index=True)
    email = Column(EmailType, index=True)  # TODO encrypt?

    fields = Column(Boolean)
    books = Column(Boolean)
    profile = Column(Boolean)

    share_tags = relationship("ShareTag", **parent_cascade)
    tags_ = relationship("Tag", secondary="shares_tags")

    last_seen = DateCol()
    new_entries = Column(Integer, server_default=satext("0"))

    @property
    def tags(self):
        return {t.tag_id: True for t in self.share_tags}


class SIShare(BaseModel):
    email: str
    fields_: Optional[bool] = False
    books: Optional[bool] = False
    profile: Optional[bool] = False
    tags: Optional[dict] = {}

    class Config:
        fields = {'fields_': 'fields'}


class SOShare(SIShare):
    id: UUID4
    user_id: UUID4

    class Config:
        fields = {'fields_': 'fields'}
        orm_mode = True


class Tag(Base):
    __tablename__ = 'tags'
    id = IDCol()
    user_id = FKCol('users.id', index=True)
    name = Encrypt(Unicode, nullable=False)
    created_at = DateCol()
    # Save user's selected tags between sessions
    selected = Column(Boolean, server_default="true")
    main = Column(Boolean, server_default="false")

    shares = relationship("Share", secondary="shares_tags")

    @staticmethod
    def snoop(from_email, to_id, snooping=False):
        if snooping:
            q = db.session.query(Tag)\
                .with_entities(Tag.id, Tag.user_id, Tag.name, Tag.created_at, Tag.main, ShareTag.selected)\
                .join(ShareTag, Share)\
                .filter(Share.email == from_email, Share.user_id == to_id)
        else:
            q = db.session.query(Tag).filter_by(user_id=to_id)
        return q.order_by(Tag.main.desc(), Tag.created_at.asc(), Tag.name.asc())


class SITag(BaseModel):
    name: str
    selected: Optional[bool] = False


class SOTag(SITag, SOut):
    id: UUID4
    user_id: UUID4
    name: str
    selected: Optional[bool] = False
    main: Optional[bool] = False


class EntryTag(Base):
    __tablename__ = 'entries_tags'
    entry_id = FKCol('entries.id', primary_key=True)
    tag_id = FKCol('tags.id', primary_key=True)


class ShareTag(Base):
    __tablename__ = 'shares_tags'
    share_id = FKCol('shares.id', primary_key=True)
    tag_id = FKCol('tags.id', primary_key=True)
    selected = Column(Boolean, server_default="true")

    tag = relationship(Tag, backref=backref("tags"))
    share = relationship(Share, backref=backref("shares"))


class Book(Base):
    __tablename__ = 'books'
    id = Column(Integer, primary_key=True)
    title = Column(Unicode, nullable=False)
    text = Column(Unicode, nullable=False)
    author = Column(Unicode)
    topic = Column(Unicode)

    thumbs = Column(Integer, server_default=satext("0"))
    amazon = Column(Unicode)


class Shelves(enum.Enum):
    ai = "ai"
    cosine = "cosine"
    like = "like"
    already_read = "already_read"
    dislike = "dislike"
    remove = "remove"
    recommend = "recommend"


class Bookshelf(Base):
    __tablename__ = 'bookshelf'
    created_at = DateCol()
    updated_at = DateCol(update=True)

    book_id = Column(Integer, primary_key=True)  # no FK, books change often
    user_id = FKCol('users.id', primary_key=True)
    shelf = Column(Enum(Shelves), nullable=False)
    score = Column(Float)  # only for ai-recs

    @staticmethod
    def update_books(user_id):
        with db():
            # every x thumbs, update book recommendations
            sql = """
            select count(*)%8=0 as ct from bookshelf 
            where user_id=:uid and shelf not in ('ai', 'cosine')
            """
            should_update = db.session.execute(satext(sql), {'uid':user_id}).fetchone().ct
            if should_update:
                Job.create_job(method='books', data_in={'args': [str(user_id)]})

    @staticmethod
    def upsert(user_id, book_id, shelf):
        db.session.execute(satext("""
        insert into bookshelf(book_id, user_id, shelf)  
        values (:book_id, :user_id, :shelf)
        on conflict (book_id, user_id) do update set shelf=:shelf
        """), dict(user_id=user_id, book_id=int(book_id), shelf=shelf))

        dir = dict(ai=0, cosine=0, like=1, already_read=1, dislike=-1, remove=0, recommend=1)[shelf]
        db.session.execute(satext("""
        update books set thumbs=thumbs+:dir where id=:bid
        """), dict(dir=dir, bid=book_id))

        db.session.commit()
        threading.Thread(target=Bookshelf.update_books, args=(user_id,)).start()

    @staticmethod
    def get_shelf(user_id, shelf):
        books = db.session.execute(satext(f"""
        select b.id, b.title, b.text, b.author, b.topic, b.amazon
        from books b 
        inner join bookshelf bs on bs.book_id=b.id 
            and bs.user_id=:uid and bs.shelf=:shelf
        order by bs.score asc
        """), dict(uid=user_id, shelf=shelf)).fetchall()
        print(len(books))
        return books
        # return [dict(b) for b in books]

    @staticmethod
    def books_with_scores(sess, uid):
        """
        Get all thumbs for books. This is used by gpu/books.py for predicting recommendations, and the thumbs
        push up-votes closer; down-votes further. Weight this-user's thumbs very high (of course), but also factor
        in other user's thumbs to a small degree - like a rating system.
        """
        shelf_to_score = """
        case when shelf in ('like', 'already_read', 'recommend') then 1
        when shelf in ('dislike') then -1
        else 0 end
        """
        sql = f"""
        -- could use books.thumbs, but it's missing data from before I added it. Maybe switch to it eventually
        with shelf_to_score as (
            select book_id, avg({shelf_to_score}) as score
            from bookshelf where shelf not in ('ai', 'cosine')
            -- where user_id!=%(uid)s -- meh, I'll just double-count the user's score & modify math downstream, makes this sql easier
            group by book_id
        ), books_ as (
            select b.*, 
                s.score as global_score,
                s.score is not null as any_rated
            from books b
            left outer join shelf_to_score s on b.id=s.book_id
        )
        select b.*,
            {shelf_to_score} as user_score, 
            (shelf is not null and shelf not in ('ai', 'cosine')) as user_rated
        from books_ b
        left outer join bookshelf s on b.id=s.book_id and s.user_id=%(uid)s
        -- sort id asc since that's how we mapped to numpy vectors in first place (order_values)
        order by b.id asc
        """
        return pd.read_sql(sql, sess.bind, params={'uid': uid})\
            .set_index('id', drop=False)

    @staticmethod
    def top_books():
        sql = f"""
        with books_ as (
            select b.id, count(s.shelf) ct from books b
            inner join bookshelf s on b.id=s.book_id
            where s.shelf in ('like', 'already_read') and amazon is not null
            group by b.id
        )
        select b.title, b.author, b.topic, b.amazon from books b
        inner join books_ b_ on b_.id=b.id
        order by b_.ct desc limit 10
        """
        return db.session.execute(sql).fetchall()


class MachineTypes(enum.Enum):
    gpu = "gpu"
    server = "server"


class Job(Base):
    __tablename__ = 'jobs'
    id = IDCol()
    created_at = DateCol()
    updated_at = DateCol(update=True)
    method = Column(Unicode, index=True, nullable=False)
    state = Column(Unicode, server_default="new", index=True)
    run_on = Column(Enum(MachineTypes), server_default="gpu", index=True)
    # FK of Machine.id (but don't use FK, since we delete Machines w/o invalidating jobs)
    machine_id = Column(Unicode, index=True)
    data_in = Column(JSONB)
    data_out = Column(JSONB)

    @staticmethod
    def create_job(method, data_in={}, **kwargs):
        """
        Ensures certain jobs only created once at a time. Never manually add Job() call this instead
        """
        with session() as sess:
            arg0 = data_in.get('args', [None])[0]
            if type(arg0) != str: arg0 = None

            # For entries, profiles: set ai_ran=False to queue them into the next batch
            if method in ('entries', 'profiles') and arg0:
                table = dict(entries='entries', profiles='users')[method]
                sess.execute(satext(f"""
                update {table} set ai_ran=False where id=:id;
                """), dict(id=arg0))
                sess.commit()

            exists = sess.execute(satext("""
            select 1 from jobs
            -- maybe if we're mid-job, things have changed; so don't incl. working? rethink 
            --where method=:method and state in ('new', 'working') and
            where method=:method and state='new' and
            case
                when method='influencers' then true
                when method='books' and data_in->'args'->>0=:arg0 then true
                when method='entries' and data_in->'args'->>0=:arg0 then true
                when method='profiles' and data_in->'args'->>0=:arg0 then true
                when method='habitica' then true
                else false
            end
            """), dict(method=method, arg0=arg0)).fetchone()
            if exists: return False

            j = Job(method=method, data_in=data_in, **kwargs)
            sess.add(j)
            sess.commit()
            sess.refresh(j)
            return str(j.id)

    @staticmethod
    def place_in_queue(jid):
        return db.session.execute(satext(f"""
        select (
            (select count(*) from jobs where state in ('working', 'new') and created_at < (select created_at from jobs where id=:jid))
            / greatest((select count(*) from machines where status in ('on', 'pending')), 1)
        ) as ct
        """), dict(jid=jid)).fetchone().ct

    @staticmethod
    def wrap_job(jid, method, fn):
        logger.info(f"Run job {method}")
        try:
            start = time.time()
            res = fn()
            sql = "update jobs set state='done', data_out=:data where id=:jid"
            logger.info(f"Job {method} complete {time.time() - start}")
        except Exception as err:
            err = str(traceback.format_exc())  # str(err)
            res = dict(error=err)
            sql = "update jobs set state='error', data_out=:data where id=:jid"
            logger.error(f"Job {method} error {time.time() - start} {err}")
        with session() as sess:
            sess.execute(satext(sql), dict(data=jsonb(res), jid=str(jid)))
            sess.commit()

    @staticmethod
    def take_job(sess, sql_frag):
        job = sess.execute(satext(f"""
        update jobs set state='working', machine_id=:machine 
        where id = (
            select id from jobs 
            where state='new' and {sql_frag}
            order by created_at asc
            for update skip locked
            limit 1
        )
        returning id, method
        """), dict(machine=vars.MACHINE)).fetchone()
        sess.commit()
        return job

    @staticmethod
    def prune():
        with session() as sess:
            """prune completed or stuck jobs. Completed jobs aren't too useful for admins; error is."""
            sess.execute(f"""
            delete from jobs 
            where updated_at < now() - interval '10 minutes' 
                and state in ('working', 'done') 
            """)
            sess.commit()

    # ea063dfa: last_job()


class Machine(Base):
    """
    List of running machines (gpu, server)
    """
    __tablename__ = 'machines'
    id = Column(Unicode, primary_key=True)  # socket.hostname()
    #type = Column(Enum(MachineTypes), server_default="gpu")
    status = Column(Unicode)
    created_at = DateCol()
    updated_at = DateCol(update=True)

    @staticmethod
    def gpu_status(sess):
        res = sess.execute(f"""
        select status from machines
        -- prefer 'on' over others, to show online if so
        order by case 
            when status='on' then 1
            when status='pending' then 2
            else 3
        end asc
        limit 1
        """).fetchone()
        return res.status if res else "off"

    @staticmethod
    def notify_online(sess, id, status='on'):
        # missing vals get server_default
        sess.execute(satext(f"""
        insert into machines (id, status) values (:id, :status)
        on conflict(id) do update set status=:status, updated_at=now()
        """), dict(id=id, status=status))
        sess.commit()

    @staticmethod
    def prune():
        with session() as sess:
            """prune machines which haven't removed themselves properly"""
            sess.execute(f"""
            delete from machines where updated_at < now() - interval '5 minutes' 
            """)
            sess.commit()

    @staticmethod
    def job_ct_on_machine(sess, id):
        return sess.execute(satext(f"""
        select count(*) ct from jobs where state='working'
            and machine_id=:id
            -- check time in case broken/stale
            and created_at > now() - interval '2 minutes'
        """), dict(id=id)).fetchone().ct


class SILimitEntries(BaseModel):
    days: int
    tags: List[str] = None


class SIQuestion(SILimitEntries):
    question: str


class SISummarize(SILimitEntries):
    words: int


class SIThemes(SILimitEntries):
    algo: Optional[str] = 'agglomorative'


###
# Cache models, storing data for use after machine learning runs
###

class CacheEntry(Base):
    __tablename__ = 'cache_entries'
    entry_id = FKCol('entries.id', primary_key=True)
    paras = Encrypt(array=True)
    clean = Encrypt(array=True)
    vectors = Column(ARRAY(Float, dimensions=2))

    @staticmethod
    def get_paras(entries_q, profile_id=None):
        CE, CU = CacheEntry, CacheUser
        entries = entries_q.join(CE, CE.entry_id == Entry.id) \
            .filter(func.array_length(CE.paras,1)>0) \
            .with_entities(CE.paras).all()
        paras = [p for e in entries for p in e.paras if e.paras]

        if profile_id:
            profile = db.session.query(CU) \
                .filter(func.array_length(CU.paras,1)>0, CU.user_id == profile_id) \
                .with_entities(CU.paras) \
                .first()
            if profile:
                paras = profile.paras + paras

        return paras


class CacheUser(Base):
    __tablename__ = 'cache_users'
    user_id = FKCol('users.id', primary_key=True)
    paras = Encrypt(array=True)
    clean = Encrypt(array=True)
    vectors = Column(ARRAY(Float, dimensions=2))


class ProfileMatch(Base):
    __tablename__ = 'profile_matches'
    user_id = FKCol('users.id', primary_key=True)
    match_id = FKCol('users.id', primary_key=True)
    score = Column(Float, nullable=False)


class Influencer(Base):
    __tablename__ = 'influencers'
    field_id = FKCol('fields.id', primary_key=True)
    influencer_id = FKCol('fields.id', primary_key=True)
    score = Column(Float, nullable=False)


class ModelHypers(Base):
    __tablename__ = 'model_hypers'
    id = IDCol()
    model = Column(Unicode, nullable=False, index=True)
    model_version = Column(Integer, nullable=False, index=True)
    user_id = FKCol('users.id')
    created_at = DateCol()
    score = Column(Float, nullable=False)
    hypers = Column(JSONB, nullable=False)
    meta = Column(JSONB)  # for xgboost it's {n_rows, n_cols}



def await_row(sess, sql, args={}, wait=.5, timeout=None):
    i = 0
    while True:
        res = sess.execute(satext(sql), args).fetchone()
        if res: return res
        time.sleep(wait)
        if timeout and wait * i >= timeout:
            return None
        i += 1
