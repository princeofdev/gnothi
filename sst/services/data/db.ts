import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import {APIGatewayEvent, APIGatewayProxyResult, Context} from 'aws-lambda'
import { Client as PgClient, Pool, QueryResult } from 'pg'
import { pgTable, serial, text, varchar } from 'drizzle-orm/pg-core';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql, SQL } from 'drizzle-orm'
import { URL } from 'url'

 // TODO why was I using the sharedStage for the DB? shouldn't it stage-specific?
// export const sharedStage = `gnothi${process.env.sharedStage}`
export const sharedStage = `gnothi${process.env.stage}`

class MyLogger implements Logger {
  logQuery(query: string, params: unknown[]): void {
    console.log({ query, params });
  }
}

type Host = {
  host: string
  port: number
  username: string
  password: string
}

type ConnectionInfo = {
  database?: string
  host?: Host
  connectionUrl?: `postgresql://${string}:${string}@${string}:${string}/${string}`
}

export class DB {
  // private variable which will be singleton-initialized for running lambda (for all
  // future invocations). Note use of this class exported as an instance (bottom of file),
  // not instantiated by callers
  public info: ConnectionInfo
  private connected = false
  public pg: Pool
  public drizzle: NodePgDatabase

  constructor(info: ConnectionInfo = {}) {
    this.info = info
  }

  async connect() {
    if (this.connected) { return }
    this.connected = true

    const i = this.info
    if (i.connectionUrl) {
      const url = new URL(i.connectionUrl)
      i.host = {username: url.username, password: url.password, host: url.hostname, port: parseInt(url.port)}
      i.database = url.pathname.slice(1)
    } else if (!i.host) {
      // set localhost defaults, override if deployed
      if (process.env.IS_LOCAL || process.env.MODE === "test") {
        i.host = {
          host: "localhost",
          port: 5432,
          username: "postgres",
          password: "password"
        }
      } else {
        // get the secret from secrets manager.
        const secretsClient = new SecretsManagerClient({})
        const secret = await secretsClient.send(new GetSecretValueCommand({
          SecretId: process.env.rdsSecretArn,
        }))
        i.host = JSON.parse(secret.SecretString ?? '{}') as Host
      }
    }
    i.database = i.database || sharedStage

    console.log("pre-client")
    console.log({host: i.host, database: i.database})

    // const pgClient = new PgClient({
    const pgClient = new Pool({
      max: 1, min: 0, // single connection for singleton Lambda
      host: i.host.host, // host is the endpoint of the db cluster
      port: i.host.port, // port is 5432
      user: i.host.username, // username is the same as the secret name
      password: i.host.password, // this is the password for the default database in the db cluster
      database: i.database
    })
    // await pgClient.connect()
    const drizzleClient = drizzle(pgClient, {logger: new MyLogger()})

    // await pgClient.connect()

    // See https://gist.github.com/streamich/6175853840fb5209388405910c6cc04b
    // If using Pool (not Client), we can forgo connect() and the pool will self-manage.
    // Otherwise, we'd need:
    // const client = await pool.connect()
    // try {await client.query(q)}
    // finally {client.release(true)}

    this.drizzle = drizzleClient
    this.pg = pgClient
  }

  static prepLambda(context: Context) {
    // https://gist.github.com/streamich/6175853840fb5209388405910c6cc04b
    context.callbackWaitsForEmptyEventLoop = false; // !important to reuse pool
  }

  removeNull(obj: object) {
    // Returned zod objects with optional fields only allow `null` if `.nullable()`
    // is used. This strips nulls from the object. Keep an eye on this, there may
    // be a future situation in which null is a meaningful value over undefined.
    return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== null));
  }

  removeUndefined(obj: object) {
    return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== undefined));
  }

  async query<O = any>(sql_: SQL): Promise<O[]> {
    if (!this.connected) {
      await this.connect()
    }
    try {
      const queryResult: QueryResult<O> = await this.drizzle.execute<O>(sql_)
      return queryResult.rows.map(this.removeNull)
    } catch (error) {
      // (await this.client()).release(true)
      console.error({error, sql_})
      debugger
      throw error
    // } finally {
    //   console.log({finally: "finally"})
    //   console.log("finally reached")
    //   // this.client_.release()
    }
  }
  async queryFirst<O = any>(sql_: SQL): Promise<O> {
    const rows = await this.query<O>(sql_)
    return rows[0]
  }

  async insert<O = object>(table: string, obj: object): Promise<O> {
    const clean = this.removeUndefined(obj)
    const keys = Object.keys(clean)
    const values = keys.map(k => clean[k])
    const sql = `insert into ${table} (${keys.join(', ')}) values (${keys.map((_, i) => `$${i+1}`).join(', ')}) returning *`
    return this.queryFirst<O>(sql, values)
  }
}
