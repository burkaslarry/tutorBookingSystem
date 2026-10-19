const { AsyncLocalStorage } = require("node:async_hooks");

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bookings (
    id VARCHAR(80) PRIMARY KEY, student VARCHAR(60) NOT NULL, phone VARCHAR(30) NOT NULL,
    course VARCHAR(100) NOT NULL, date VARCHAR(10) NOT NULL, time VARCHAR(5) NOT NULL,
    status VARCHAR(20) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX bookings_date_time_idx (date, time)
  )`,
  `CREATE TABLE IF NOT EXISTS admins (
    id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(120) NOT NULL UNIQUE,
    password_salt VARCHAR(128) NOT NULL, password_hash VARCHAR(256) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'ADMIN', is_active INT NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    token VARCHAR(128) PRIMARY KEY, admin_id INT NOT NULL, expires_at VARCHAR(30) NOT NULL,
    FOREIGN KEY (admin_id) REFERENCES admins(id)
  )`,
  `CREATE TABLE IF NOT EXISTS courses (
    id VARCHAR(80) PRIMARY KEY, name VARCHAR(100) NOT NULL, description TEXT NOT NULL,
    price_cents INT NOT NULL, active INT NOT NULL DEFAULT 1, created_at VARCHAR(30) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS slots (
    id VARCHAR(80) PRIMARY KEY, course_id VARCHAR(80) NOT NULL, date VARCHAR(10) NOT NULL,
    start_time VARCHAR(5) NOT NULL, end_time VARCHAR(5) NOT NULL, capacity INT NOT NULL,
    created_at VARCHAR(30) NOT NULL, FOREIGN KEY (course_id) REFERENCES courses(id),
    INDEX slots_date_idx (date)
  )`,
  `CREATE TABLE IF NOT EXISTS registrations (
    id VARCHAR(80) PRIMARY KEY, slot_id VARCHAR(80) NOT NULL, student_name VARCHAR(60) NOT NULL,
    company_name VARCHAR(120) NOT NULL DEFAULT '', phone VARCHAR(30) NOT NULL, email VARCHAR(120) NOT NULL,
    status VARCHAR(20) NOT NULL, payment_method VARCHAR(20) NOT NULL, payment_status VARCHAR(20) NOT NULL,
    amount_cents INT NOT NULL, receipt_path VARCHAR(255), receipt_mime VARCHAR(80), receipt_data LONGBLOB,
    kpay_intent_id VARCHAR(120), kpay_checkout_url TEXT, confirmation_email_status VARCHAR(30),
    confirmation_email_id VARCHAR(120), reminder_email_status VARCHAR(30), reminder_email_id VARCHAR(120),
    reminder_sent_at VARCHAR(30), created_at VARCHAR(30) NOT NULL,
    FOREIGN KEY (slot_id) REFERENCES slots(id), INDEX registrations_slot_idx (slot_id)
  )`,
];

async function openMysqlDatabase(env) {
  for (const key of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
    if (!env[key]) throw new Error(`Missing required MySQL setting: ${key}`);
  }
  const mysql = require("mysql2/promise");
  const pool = mysql.createPool({
    host: env.DB_HOST === "localhost" ? "127.0.0.1" : env.DB_HOST,
    port: Number(env.DB_PORT || 3306), database: env.DB_NAME,
    user: env.DB_USER, password: env.DB_PASSWORD,
    connectionLimit: 5, waitForConnections: true, queueLimit: 50, connectTimeout: 10000,
    charset: "utf8mb4", supportBigNumbers: true, dateStrings: true,
    ...(env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  const transactions = new AsyncLocalStorage();
  const execute = (sql, params = []) => (transactions.getStore() || pool).execute(sql, params);
  const database = {
    kind: "mysql",
    prepare(sql) {
      return {
        async all(...params) { const [rows] = await execute(sql, params); return rows; },
        async get(...params) { const [rows] = await execute(sql, params); return rows[0]; },
        async run(...params) {
          const [result] = await execute(sql, params);
          return { changes: result.affectedRows, lastInsertRowid: result.insertId };
        },
      };
    },
    async transaction(fn) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await transactions.run(connection, fn);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally { connection.release(); }
    },
    async lockSlot(id) { await execute("SELECT id FROM slots WHERE id = ? FOR UPDATE", [id]); },
    async saveReceipt(id, image) {
      await execute("UPDATE registrations SET receipt_data = ? WHERE id = ?", [image.data, id]);
    },
    async loadReceipt(id) {
      const [rows] = await execute("SELECT receipt_data FROM registrations WHERE id = ?", [id]);
      return rows[0]?.receipt_data;
    },
    close: () => pool.end(),
  };
  try {
    for (const statement of SCHEMA) await pool.query(`${statement} ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    return database;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

module.exports = { openMysqlDatabase };
