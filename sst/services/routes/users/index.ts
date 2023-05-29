import {Routes} from '@gnothi/schemas'
import {FnContext, Route} from '../types'
import {users} from '../../data/schemas/users'
import {and, eq} from 'drizzle-orm'
import {DB} from '../../data/db'
import {entriesUpsertResponse} from '../entries'

const r = Routes.routes

export const users_everything_request = new Route(r.users_everything_request, async (req, context) => {
  const promises: Promise<any>[] = [
    'users_list_request',

    'tags_list_request',
    // 'entries_list_request', // now this is kicked off client-side with filters
    'fields_list_request',
    'fields_entries_list_request',

    // Not yet implemented, ease up on the networking until they're back
    // 'groups_mine_list_request',
    // 'notifs_groups_list_request',
    // 'notifs_notes_list_request',
    // 'shares_ingress_list_request',
    // 'shares_egress_list_request',

  ].map(async (event) => {
    await context.handleReq({event, data: {}}, context)
  })
  // mark as logged in
  promises.push(context.db.drizzle.update(users)
    .set({updated_at: new Date()})
    .where(eq(users.id, context.uid)))
  await Promise.all(promises)

  return [context.user] // required to pass on to background (next step)
})

// After the user is returned to the client, we see if their entries are in need of an AI migration. Eg, any entries
// which got stuck in processing; or deliberately when I change the models and invalidate all entries in the DB. Doing
// it per user on load saves me from running over the full database, for users who may not be returning (AI is expensive)
export const users_everything_response = new Route(r.users_everything_response, async (req, context) => {
  for (let i = 0; i < 500; i++) {
    const stuckEntry = await context.m.entries.getStuckEntry(req.id)
    if (!stuckEntry) {break}
    console.log(`Fixing: stuck ${i}`)
    // Detatch the context from whomever triggered this. That's because user.id might be referenced (eg, in fetching tags
    // in entriesUpsertResponse) and we don't want to send anything via websocket.
    const detachedContext = new FnContext({
      db: context.db,
      user: {id: stuckEntry.user_id},
      handleRes: context.handleRes,
      handleReq: context.handleReq
    });

    await entriesUpsertResponse(stuckEntry, detachedContext);
  }
  return []
})

export const users_list_request = new Route(r.users_list_request,async function(req, context) {
  // main user always comes first
  const users =  [context.user]

  // TODO fetch shares
  // const users = await DB.selectFrom("users")
  //   .where("id", "=", context.user.id)
  //   .executeTakeFirst()
  return users
})

export const users_timezone_put_request = new Route(r.users_timezone_put_request, async (req, context) => {
  const res = await context.db.drizzle.update(users)
    .set(req) // validated / limited via zod
    .where(eq(users.id, context.uid))
    .returning()
  return res.map(DB.removeNull)
})

export const users_acknowledge_request = new Route(r.users_acknowledge_request, async function(req, context) {
  const {uid, db} = context
  await db.drizzle.update(users).set({
    accept_terms_conditions: new Date(),
    accept_privacy_policy: new Date(),
    accept_disclaimer: new Date(),
  }).where(eq(users.id, uid))
  return []
})
