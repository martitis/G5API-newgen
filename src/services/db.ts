/*Database driver.*/
import { createPool } from 'mysql2/promise';
import config from 'config';
import { FieldPacket, PoolOptions, RowDataPacket } from 'mysql2/typings/mysql';
import logger from "../utility/logger.js";
interface IStringIndex {
  [key: string]: any;
}
// ES module imports run before bin/www.ts can default NODE_ENV, so default it here too
// (the config package itself also falls back to "development").
const env: string = process.env.NODE_ENV || "development";
const dbCfg = {
  host: config.get(env + ".host"),
  port: config.get(env + ".port"),
  user: config.get(env + ".user"),
  password: config.get(env + ".password"),
  database: config.get(env + ".database"),
  connectionLimit: config.get(env + ".connectionLimit"),
  // All times are UTC: the code writes new Date().toISOString() strings, and Date values are read back as UTC.
  timezone: "Z"
} as PoolOptions;
const connPool = createPool(dbCfg);
// Team member lists and season cvars are built with GROUP_CONCAT, which MySQL cuts at
// 1024 bytes by default (big teams came back as invalid JSON).
connPool.on("connection", (conn) => {
  // NOW() / CURRENT_TIMESTAMP defaults in UTC too, matching the times the code writes.
  // The pool's "connection" event hands out the callback connection, not the promise wrapper.
  conn.query("SET SESSION group_concat_max_len = 1048576, time_zone = '+00:00'", (err: unknown) => {
    if (err) logger.error({ err }, "Could not set up a database connection");
  });
});

/** A query bound to one transaction (see Database.transaction). */
export type TransactionQuery = (sql: string, args?: object) => Promise<RowDataPacket[]>;

// The admin config lists are applied at each Steam login (utility/access.ts configRoleLists), not at startup.
class Database {
  async query(sql: string, args?: object): Promise<RowDataPacket[]> {
    try {
      const result: [RowDataPacket[], FieldPacket[]] = await connPool.query<RowDataPacket[]>(sql, args);
      return result[0];
    } catch (error) {
      logger.error({ err: error }, "SQL query failed");
      throw error;
    }
  }

  /**
   * Runs `work` in one transaction on one connection: committed when it resolves, rolled back when it throws.
   * @param work - Gets a query function with the same shape as db.query, bound to the transaction.
   */
  async transaction<T>(work: (query: TransactionQuery) => Promise<T>): Promise<T> {
    const conn = await connPool.getConnection();
    try {
      await conn.beginTransaction();
      const query: TransactionQuery = async (sql, args) => (await conn.query<RowDataPacket[]>(sql, args))[0];
      const result = await work(query);
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }

  async buildUpdateStatement(objValues: IStringIndex): Promise<IStringIndex> {
    for (const key in objValues) {
      if (objValues[key] == null || objValues[key] == undefined) delete objValues[key];
    }
    return objValues;
  }
}
const db = new Database();
export {db};
