import {GetSecretValueCommand, SecretsManagerClient} from "@aws-sdk/client-secrets-manager";

import {dbname, DB, urlToInfo} from "../../db"
import {Config} from 'sst/node/config'

import {users} from '../../schemas/users'
import {entries, Entry} from '../../schemas/entries'
import {notes, Note} from '../../schemas/notes'
import {fields, Field} from '../../schemas/fields'
import {people, Person} from '../../schemas/people'
import {tags, Tag} from '../../schemas/tags'
import {eq, and, or, sql} from "drizzle-orm";
import {URL} from 'url'
import {exec as execCallback} from "child_process";
import {promisify} from "util";
import {readFileSync} from "fs";
import { Fernet } from 'fernet-nodejs';
import {expect, it} from "vitest"
import * as dotenv from 'dotenv'
import * as _ from 'lodash'
import {addUserToCognito, randomPassword} from './cognito'

dotenv.config({ path: `services/data/migrate/v0/.env.${process.env.SST_STAGE}` })
console.log(`Migrating for ${process.env.SST_STAGE}`)
const migrateOnlyTheseEmails = process.env.MIGRATE_EMAILS?.split(",") || []


const exec = promisify(execCallback);

if (!(process.env.FLASK_KEY && process.env.DB_URL_PROD)) {
  throw new Error("FLASK_KEY or DB_URL_PROD not imported correctly for migrate_v0")
}

const fernetKey = Fernet.deriveKey(process.env.FLASK_KEY)
const fernet = new Fernet(fernetKey)
function decrypt (token: string): string {
  if (!token?.length) { return token }
  return fernet.decrypt(token)
}

// Note: when working with old DB, only pull columns needed (don't `select *`) since we'll be streaming all the data
// and need the RAM wiggle-room

export async function decryptColumns(db: DB) {
  // Have as separate functions so we can reclaim the RAM in between without getting funky with TypeScript
  await decryptUsers(db)
  await decryptEntries(db)
  await decryptNotes(db)
  await decryptFields(db)
  await decryptTags(db)
  await decryptPeople(db)
}

function decryptRow(row: object & {id: string}) {
  // NOTE this will only work if rows are keyed by id (not double-primarykey, no id, etc).
  const {id, ...rest} = row
  // decrypt every value in this object
  const decrypted = _.mapValues(rest, decrypt)
  const clean = DB.removeNull(decrypted)
  if (_.isEmpty(clean)) {return null}
  return clean
}

export async function decryptUsers(db: DB) {
  const rows = await db.drizzle.select({
    id: users.id,
    email: users.email,
    first_name: users.first_name,
    last_name: users.last_name,
    gender: users.gender,
    orientation: users.orientation,
    bio: users.bio,
    habitica_user_id: users.habitica_user_id,
    habitica_api_token: users.habitica_api_token
  }).from(users)
  for (let row of rows) {
    const {email, ...rest} = row
    const decrypted = decryptRow(rest) || {}
    // if (!decrypted) {return} // DON'T do this, we need at least to conver them to cognito
    if (migrateOnlyTheseEmails === "everyone-i-confirm") {
      throw new Error("You are officially migrating everyone! Make sure you run through the checks, then come delete this error.")
    }
    if (migrateOnlyTheseEmails.includes(email)) {
      decrypted.cognito_id = await addUserToCognito(row)
    } else {
      decrypted.cognito_id = randomPassword()
    }
    await db.drizzle.update(users).set(decrypted).where(eq(users.id, row.id))
  }
}

export async function decryptEntries(db: DB) {
  const rows = await db.drizzle.select({
    id: entries.id,
    title: entries.title,
    text: entries.text,
  }).from(entries)
  for (let row of rows) {
    const decrypted = decryptRow(row)
    if (!decrypted) {continue}
    await db.drizzle.update(entries).set(decrypted).where(eq(entries.id, row.id))
  }
}

export async function decryptNotes(db: DB) {
  const rows = await db.drizzle.select({
    id: notes.id,
    text: notes.text,
  }).from(notes)
  for (let row of rows) {
    const decrypted = decryptRow(row)
    if (!decrypted) {continue}
    await db.drizzle.update(notes).set(decrypted).where(eq(notes.id, row.id))
  }
}

// FIXME fields2?

export async function decryptFields(db: DB) {
  const rows = await db.drizzle.select({
    id: fields.id,
    name: fields.name,
  }).from(fields)
  for (let row of rows) {
    const decrypted = decryptRow(row)
    if (!decrypted) {continue}
    await db.drizzle.update(fields).set(decrypted).where(eq(fields.id, row.id))
  }
}

export async function decryptPeople(db: DB) {
  const rows = await db.drizzle.select({
    id: people.id,
    name: people.name,
    relation: people.relation,
    issues: people.issues,
    bio: people.bio,
  }).from(people)
  for (let row of rows) {
    const decrypted = decryptRow(row)
    if (!decrypted) {continue}
    await db.drizzle.update(people).set(decrypted).where(eq(people.id, row.id))
  }
}

export async function decryptTags(db: DB) {
  const rows = await db.drizzle.select({
    id: tags.id,
    name: tags.name,
  }).from(tags)
  for (let row of rows) {
    const decrypted = decryptRow(row)
    if (!decrypted) {continue}
    await db.drizzle.update(tags).set(decrypted).where(eq(tags.id, row.id))
  }
}

function killConnections(dbname: string) {
  return `SELECT pg_terminate_backend(pg_stat_activity.pid)
    FROM pg_stat_activity
    WHERE pg_stat_activity.datname='${dbname}'
      AND pid <> pg_backend_pid();`
}

it("v0:migrate", async () => {
  async function migrateFn(args: {wipe?: boolean, first?: boolean, rest?: boolean}) {
    const args_ = JSON.stringify(args)
    await exec([
      `aws lambda invoke --function-name ${Config.FN_DB_MIGRATE}`,
      `--cli-binary-format raw-in-base64-out`,
      `--payload '${args_}'`,
      `/dev/null`
    ].join(" "))
  }

  await migrateFn({wipe: true, first: true})

  if (process.env.SKIP_DUMP === "false") {
    const db0i = urlToInfo(process.env.DB_URL_PROD as any);
    await exec([
      `PGPASSWORD='${db0i.host.password}'`,
      "pg_dump  --exclude-table=cache_users --exclude-table=cache_entries",
      "-U", db0i.host.username,
      "-h", db0i.host.host,
      "-d", db0i.database,
      ">", process.env.DUMP_PATH
    ].join(' '))
  }

  // @ts-ignore
  const localhost = "postgresql://postgres:password@localhost:5432"
  const intermediate = "intermediate"

  // Delete / re-create intermediate database
  const db1_pg = new DB({connectionUrl: `${localhost}/postgres`})
  await db1_pg.connect()
  await db1_pg.pg.query(killConnections(intermediate))
  await db1_pg.pg.query(`drop database if exists ${intermediate}`)
  await db1_pg.pg.query(`create database ${intermediate}`)

  const db1 = new DB({connectionUrl: `${localhost}/${intermediate}`})
  await db1.connect()
  const db1i = db1.info
  console.log({db1i})
  await exec([
    `PGPASSWORD='${db1i.host.password}' psql`,
    "-U", db1i.host.username,
    "-h", db1i.host.host,
    "-d", db1i.database,
    "<", process.env.DUMP_PATH
  ].join(' '))
  // These two were performed on the live database 5/19/2023. Needed there so I can run drizzle-kit generate
  // for original database structure, in order ot create a diff for new schemas
  // await db1.pg.query("ALTER TABLE users ADD COLUMN cognito_id VARCHAR;")
  // await db1.pg.query("CREATE INDEX ix_users_cognito_id ON users (cognito_id);")
  await decryptColumns(db1)

  // Prepare the new database
  await migrateFn({wipe: true, first: true})

  // no arguments means it will use our target database, from logic inisde DB.connect()
  const db2 = new DB({})
  await db2.connect()
  const db2i = db2.info
  console.log({db2i})

  await exec([
    `PGPASSWORD='${db1i.host.password}'`,
    "pg_dump",
    // the migrateFn(first) above creates the structure, in a controlled & clean way (no extra postgres flags)
    "--data-only",
    "-U", db1i.host.username,
    "-h", db1i.host.host,
    "-d", db1i.database,
    "|", // pipe directly to new database. No intermediate file
    `PGPASSWORD='${db2i.host.password}'`,
    'psql',
    "-U", db2i.host.username,
    "-h", db2i.host.host,
    "-d", db2i.database,
  ].join(' '))

  // Then run post-migration data transformations
  await migrateFn({rest: true})

  // await db.pg.query(oldSql)
  // await addUsersToCognito(db)

  // await dbPostgres.pg.query(`drop database if exists ${sharedStage};create database ${Config.DB_NAME}`)
  // const db = new DB()
  // await db.connect()

  // Set the timeout to really high (can't disable timeouts unfortunately)
  // 10 minutes in milliseconds
}, 10 * 60 * 1000)
