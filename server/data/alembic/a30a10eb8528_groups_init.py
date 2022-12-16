"""groups_init

Revision ID: a30a10eb8528
Revises: 
Create Date: 2021-03-26 19:04:10.477286

"""
import pdb
from alembic import op, context
import sqlalchemy as sa
import sqlalchemy.orm as orm
from sqlalchemy.dialects import postgresql
from sqlalchemy_utils.types.encrypted.encrypted_type import StringEncryptedType, FernetEngine
from common.database import Base
import common.models as M

# revision identifiers, used by Alembic.
revision = 'a30a10eb8528'
down_revision = None
branch_labels = None
depends_on = None

from common.seed import seed_data, GROUP_ID


def migrate_users(bind, sess):
    bind.execute(f"""
    insert into auth_old (id, email, hashed_password, updated_at)
    select id, email, hashed_password, updated_at from users;
    """)

    op.add_column('users', sa.Column('cognito_id', sa.Unicode(), nullable=True))
    op.add_column('users', sa.Column('username', sa.Unicode(), nullable=True))
    op.add_column('users', sa.Column('n_tokens', sa.Integer(), server_default="0", nullable=True))
    op.drop_column('users', 'is_active')
    op.drop_column('users', 'hashed_password')
    op.drop_column('users', 'is_verified')
    op.drop_column('users', 'paid')
    op.create_index(op.f('ix_users_cognito_id'), 'users', ['cognito_id'], unique=True)
    op.create_index(op.f('ix_users_username'), 'users', ['username'], unique=True)
    # op.alter_column('users', 'is_superuser', existing_type=sa.BOOLEAN(), nullable=True)
    op.add_column('users', sa.Column('affiliate', sa.Unicode(), nullable=True))
    op.create_foreign_key(None, 'users', 'codes', ['affiliate'], ['code'])
    
    
def migrate_shares(bind, sess):
    op.add_column('shares', sa.Column('username', sa.Boolean(), server_default='true', nullable=True))
    # add email after dropping it first
    op.add_column('shares', sa.Column('first_name', sa.Boolean(), server_default='false', nullable=True))
    op.add_column('shares', sa.Column('last_name', sa.Boolean(), server_default='false', nullable=True))
    op.add_column('shares', sa.Column('bio', sa.Boolean(), server_default='false', nullable=True))
    op.add_column('shares', sa.Column('people', sa.Boolean(), server_default='false', nullable=True))
    op.add_column('shares', sa.Column('gender', sa.Boolean(), server_default='false', nullable=True))
    op.add_column('shares', sa.Column('orientation', sa.Boolean(), server_default='false', nullable=True))
    op.add_column('shares', sa.Column('birthday', sa.Boolean(), server_default='false', nullable=True))
    op.add_column('shares', sa.Column('timezone', sa.Boolean(), server_default='false', nullable=True))
    op.add_column('shares', sa.Column('created_at', sa.TIMESTAMP(timezone=True), index=True, server_default='now()'))

    bind.execute(f"""
    with shares_ as (
        select u.id as obj_id, s.id as share_id  
        from users u 
        inner join shares s 
            on lower(s.email)=lower(u.email)
    )
    insert into shares_users (share_id, obj_id)
    select s.share_id, s.obj_id from shares_ s
    """)
    
    op.drop_index('ix_shares_email', table_name='shares')
    op.drop_index('ix_shares_last_seen', table_name='shares')
    op.drop_column('shares', 'email')
    op.drop_column('shares', 'last_seen')
    op.drop_column('shares', 'new_entries')
    op.drop_column('shares', 'profile')
    op.add_column('shares', sa.Column('email', sa.Boolean(), server_default='false', nullable=True))


def migrate_tags(bind, sess):
    op.add_column('tags', sa.Column('sort', sa.Integer(), server_default='0', nullable=False))
    op.add_column('tags', sa.Column('ai', sa.Boolean(), server_default='true'))
    bind.execute(f"""
    with tags_ as (
        select id,
            row_number() over (partition by user_id order by created_at asc) rank
        from tags
    )
    update tags set ai=true, sort=tags_.rank from tags_ where tags.id=tags_.id
    """)
    bind.execute("update tags set ai=true")


def migrate_entries(bind, sess):
    op.add_column('entries', sa.Column('n_notes', sa.Integer(), server_default='0', nullable=True))
    bind.execute("""
    update entries e set n_notes=(select count(*) from notes where entry_id=e.id)
    """)


def upgrade():
    bind = op.get_bind()
    session = orm.Session(bind=bind)
    Base.metadata.create_all(bind=bind)
    
    migrate_users(bind, session)
    migrate_shares(bind, session)
    migrate_entries(bind, session)
    migrate_tags(bind, session)

    op.drop_table('profile_matches')
    op.add_column('jobs', sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(None, 'jobs', 'users', ['user_id'], ['id'], ondelete='cascade')

    seed_data(session, M)

def downgrade():
    pass