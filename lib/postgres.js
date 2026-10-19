const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");

const SCHEMA_SQL = readFileSync(join(__dirname, "..", "sql", "johnny_ai_tutor.sql"), "utf8");
const TABLE_PATTERN = /\b(auth_sessions|registrations|bookings|courses|admins|slots)\b/g;

function toPostgresSql(sql) {
  let index = 0;
  const prefixed = sql.replace(TABLE_PATTERN, "johnny_ai_tutor_$1");
  return prefixed.replace(/\?/g, () => `$${++index}`);
}

function poolConfig(env) {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("Missing required Postgres setting: DATABASE_URL");
  const sslRequired = env.PGSSL === "true" || env.PGSSLMODE === "require" || /sslmode=require/i.test(url);
  return {
    connectionString: url,
    ssl: sslRequired ? { rejectUnauthorized: false } : undefined,
    max: 5,
    connectionTimeoutMillis: 10000,
  };
}

async function openPostgresDatabase(env) {
  const { Pool, types } = require("pg");
  types.setTypeParser(20, (value) => Number(value));
  const pool = new Pool(poolConfig(env));
  const transactions = new AsyncLocalStorage();
  const query = (sql, params = []) => (transactions.getStore() || pool).query(toPostgresSql(sql), params);
  const database = {
    kind: "postgres",
    prepare(sql) {
      return {
        async all(...params) {
          const result = await query(sql, params);
          return result.rows;
        },
        async get(...params) {
          const result = await query(sql, params);
          return result.rows[0];
        },
        async run(...params) {
          const result = await query(sql, params);
          return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
        },
      };
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await transactions.run(client, fn);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async lockSlot(id) {
      await query("SELECT id FROM slots WHERE id = ? FOR UPDATE", [id]);
    },
    async saveReceipt(id, image) {
      await query("UPDATE registrations SET receipt_data = ? WHERE id = ?", [image.data, id]);
    },
    async loadReceipt(id) {
      const result = await query("SELECT receipt_data FROM registrations WHERE id = ?", [id]);
      return result.rows[0]?.receipt_data;
    },
    close: () => pool.end(),
  };
  try {
    await pool.query(SCHEMA_SQL);
    return database;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

module.exports = { openPostgresDatabase, toPostgresSql };
