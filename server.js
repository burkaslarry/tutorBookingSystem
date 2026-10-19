const { createServer } = require("node:http");
const { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } = require("node:fs");
const { extname, join, resolve, sep, basename } = require("node:path");
const crypto = require("node:crypto");
const { makePasswordRecord, verifyPassword, newSessionToken } = require("./lib/auth");
const { parseMultipart } = require("./lib/multipart");
const { hongKongParts, isBookable, formatSlotWhen, monthRange } = require("./lib/time");
const { confirmationMessage, reminderMessage, sendEmail } = require("./lib/email");
const { kpayConfig, verifyWebhook, webhookOutcome } = require("./lib/kpay");
const { selectDueReminders } = require("./lib/reminders");

const ROOT = __dirname;
const PUBLIC_FILES = new Set(["/", "/index.html", "/app.js", "/styles.css"]);
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const VALID_STATUSES = new Set(["pending", "checked-in", "cancelled"]);
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const SESSION_HOURS = 12;

function sqliteReady() {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function relaunchWithSqlite() {
  if (process.env.TUTOR_BOOKING_SQLITE_RETRY === "1") {
    console.error(`node:sqlite is unavailable on Node ${process.version}. Use Node.js 22.5 or newer.`);
    process.exit(1);
  }
  const net = require("node:net");
  const { spawn } = require("node:child_process");
  const publicPort = Number(process.env.PORT || 8000);
  const internalPort = publicPort + 1;
  console.error(`node:sqlite needs --experimental-sqlite; listening on 0.0.0.0:${publicPort} and starting the database process on 127.0.0.1:${internalPort}.`);
  const child = spawn(process.execPath, ["--experimental-sqlite", __filename], {
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(internalPort),
      HOST: "127.0.0.1",
      TUTOR_BOOKING_SQLITE_RETRY: "1",
      TUTOR_BOOKING_FORCE_START: "1",
    },
  });
  const proxy = net.createServer((client) => {
    const upstream = net.connect({ port: internalPort, host: "127.0.0.1" });
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", closeBoth);
    client.on("error", closeBoth);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  proxy.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
  proxy.listen(publicPort, "0.0.0.0");
  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
}

function openDatabase(databasePath) {
  const { DatabaseSync } = require("node:sqlite");
  const resolvedPath = resolve(databasePath);
  mkdirSync(resolve(resolvedPath, ".."), { recursive: true });
  const database = new DatabaseSync(resolvedPath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      student TEXT NOT NULL,
      phone TEXT NOT NULL,
      course TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'checked-in', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS bookings_date_time_idx ON bookings (date, time);
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'ADMIN',
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES admins(id),
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slots (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(id),
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS slots_date_idx ON slots (date);
    CREATE TABLE IF NOT EXISTS registrations (
      id TEXT PRIMARY KEY,
      slot_id TEXT NOT NULL REFERENCES slots(id),
      student_name TEXT NOT NULL,
      company_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      receipt_path TEXT,
      receipt_mime TEXT,
      kpay_intent_id TEXT,
      kpay_checkout_url TEXT,
      confirmation_email_status TEXT,
      confirmation_email_id TEXT,
      reminder_email_status TEXT,
      reminder_email_id TEXT,
      reminder_sent_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS registrations_slot_idx ON registrations (slot_id);
  `);
  if (!database.prepare("PRAGMA table_info(registrations)").all().some((column) => column.name === "company_name")) {
    database.exec("ALTER TABLE registrations ADD COLUMN company_name TEXT NOT NULL DEFAULT ''");
  }
  return database;
}

async function seedAdmin(database, { username, password, reset }) {
  const existing = await database.prepare("SELECT id FROM admins WHERE username = ?").get(username);
  if (!existing) {
    const record = makePasswordRecord(password);
    await database.prepare(`
      INSERT INTO admins (username, password_salt, password_hash, role, is_active)
      VALUES (?, ?, ?, 'ADMIN', 1)
    `).run(username, record.salt, record.hash);
    return;
  }
  if (!reset) return;
  const record = makePasswordRecord(password);
  await database.prepare(`
    UPDATE admins SET password_salt = ?, password_hash = ?, is_active = 1 WHERE id = ?
  `).run(record.salt, record.hash, existing.id);
}

function isText(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

function isDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isTime(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function isEmail(value) {
  return typeof value === "string" && value.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateBooking(value) {
  return value
    && isText(value.id, 100)
    && isText(value.student, 60)
    && isText(value.phone, 30)
    && isText(value.course, 100)
    && isDate(value.date)
    && isTime(value.time)
    && VALID_STATUSES.has(value.status);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function httpError(statusCode, error, extra = {}) {
  const failure = new Error(error);
  failure.statusCode = statusCode;
  failure.payload = { error, ...extra };
  return failure;
}

async function readBody(request, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw httpError(413, "上載內容過大。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 100_000) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function leadHoursFrom(env) {
  const hours = Number(env.REMINDER_HOURS_BEFORE ?? 24);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 14) return 24;
  return hours;
}

function holdCutoff(env, now) {
  const minutes = Number(env.KPAY_HOLD_MINUTES ?? 15);
  const holdMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 15;
  return new Date(now.getTime() - holdMinutes * 60 * 1000).toISOString();
}

function publicBase(request, env) {
  const configured = String(env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  const host = request.headers.host || "localhost";
  const proto = request.headers["x-forwarded-proto"] || "http";
  return `${proto}://${host}`;
}

function priceCents(value) {
  const amount = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return null;
  return Math.round(amount * 100);
}

function detectReceipt(filename, contentType, data) {
  if (!data || data.length === 0) return null;
  if (data.length > MAX_RECEIPT_BYTES) {
    const error = httpError(413, "收據不可超過 5MB。");
    throw error;
  }
  const suffix = extname(filename || "").toLowerCase();
  const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
  const typeOk = !mime || mime === "application/octet-stream";
  const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (jpeg && (suffix === ".jpg" || suffix === ".jpeg") && (typeOk || mime === "image/jpeg")) {
    return { mime: "image/jpeg", suffix };
  }
  return null;
}

function storedPath(uploadsDir, relativePath) {
  const root = resolve(uploadsDir);
  const full = resolve(root, relativePath);
  if (full !== root && !full.startsWith(`${root}${sep}`)) return null;
  return full;
}

function saveReceipt(uploadsDir, registrationId, image) {
  const relative = join("receipts", registrationId, `${Date.now()}-receipt${image.suffix}`);
  const full = storedPath(uploadsDir, relative);
  mkdirSync(resolve(full, ".."), { recursive: true });
  writeFileSync(full, image.data);
  return relative.split(sep).join("/");
}

function mapCourse(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
  };
}

function mapRegistration(row) {
  return {
    id: row.id,
    slotId: row.slot_id,
    studentName: row.student_name,
    companyName: row.company_name || "",
    phone: row.phone,
    email: row.email,
    status: row.status,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    amountCents: row.amount_cents,
    hasReceipt: Boolean(row.receipt_path),
    courseName: row.course_name,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    emailStatus: row.confirmation_email_status || "",
    checkoutUrl: row.kpay_checkout_url || "",
  };
}

async function withTransaction(database, fn) {
  if (database.transaction) return database.transaction(fn);
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError) {
      console.error(rollbackError);
    }
    throw error;
  }
}

async function sendConfirmation(database, env, fetchImpl, registration) {
  const when = formatSlotWhen(registration.date, registration.startTime);
  const message = confirmationMessage({
    studentName: registration.studentName,
    courseName: registration.courseName,
    dateLabel: when.dateLabel,
    timeLabel: when.timeLabel,
  });
  let result;
  try {
    result = await sendEmail({ env, fetchImpl, to: registration.email, ...message });
  } catch (error) {
    console.error(error);
    result = { status: "failed", reason: "network" };
  }
  await database.prepare(`
    UPDATE registrations
    SET confirmation_email_status = ?, confirmation_email_id = ?
    WHERE id = ?
  `).run(result.status, result.id || "", registration.id);
  return result.status;
}

async function processDueReminders(database, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || new Date();
  const due = await selectDueReminders(database, now, leadHoursFrom(env));
  const results = [];
  for (const row of due) {
    if (!String(env.RESEND_API_KEY || "").trim()) {
      if (row.reminder_email_status !== "skipped") {
        await database.prepare(`
          UPDATE registrations SET reminder_email_status = ? WHERE id = ?
        `).run("skipped", row.id);
      }
      results.push({ id: row.id, status: "skipped" });
      continue;
    }
    const when = formatSlotWhen(row.date, row.start_time);
    const message = reminderMessage({
      studentName: row.student_name,
      courseName: row.course_name,
      dateLabel: when.dateLabel,
      timeLabel: when.timeLabel,
    });
    let result;
    try {
      result = await sendEmail({ env, fetchImpl, to: row.email, ...message });
    } catch (error) {
      console.error(error);
      result = { status: "failed" };
    }
    if (result.status === "sent") {
      await database.prepare(`
        UPDATE registrations
        SET reminder_email_status = 'sent', reminder_email_id = ?, reminder_sent_at = ?
        WHERE id = ?
      `).run(result.id || "", now.toISOString(), row.id);
    } else {
      await database.prepare("UPDATE registrations SET reminder_email_status = ? WHERE id = ?").run(result.status, row.id);
    }
    results.push({ id: row.id, status: result.status });
  }
  return results;
}

function createRequestHandler(database, options) {
  const env = options.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const uploadsDir = options.uploadsDir;
  const listBookings = database.prepare(`
    SELECT id, student, phone, course, date, time, status
    FROM bookings ORDER BY date, time, created_at
  `);
  const insertBooking = database.prepare(`
    INSERT INTO bookings (id, student, phone, course, date, time, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStatus = database.prepare(`
    UPDATE bookings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);
  const findAdmin = database.prepare("SELECT * FROM admins WHERE username = ?");
  const insertSession = database.prepare(`
    INSERT INTO auth_sessions (token, admin_id, expires_at) VALUES (?, ?, ?)
  `);
  const getSession = database.prepare(`
    SELECT s.token, s.expires_at, a.id AS admin_id, a.username, a.role, a.is_active
    FROM auth_sessions s
    JOIN admins a ON a.id = s.admin_id
    WHERE s.token = ?
  `);
  const deleteSession = database.prepare("DELETE FROM auth_sessions WHERE token = ?");
  const insertCourse = database.prepare(`
    INSERT INTO courses (id, name, description, price_cents, active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `);
  const findCourseName = database.prepare("SELECT id FROM courses WHERE name = ? AND active = 1");
  const listCourses = database.prepare(`
    SELECT id, name, description, price_cents FROM courses WHERE active = 1 ORDER BY created_at, name
  `);
  const insertSlot = database.prepare(`
    INSERT INTO slots (id, course_id, date, start_time, end_time, capacity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const findCourse = database.prepare("SELECT id, name, description, price_cents, active FROM courses WHERE id = ?");
  const slotWithCourse = database.prepare(`
    SELECT s.id, s.course_id, s.date, s.start_time, s.end_time, s.capacity,
           c.name AS course_name, c.price_cents, c.active
    FROM slots s
    JOIN courses c ON c.id = s.course_id
    WHERE s.id = ?
  `);
  const listFutureSlots = database.prepare(`
    SELECT s.id, s.course_id, s.date, s.start_time, s.end_time, s.capacity,
           c.name AS course_name, c.price_cents
    FROM slots s
    JOIN courses c ON c.id = s.course_id
    WHERE c.active = 1 AND s.date >= ?
    ORDER BY s.date, s.start_time
  `);
  const listMonthSlots = database.prepare(`
    SELECT s.id, s.course_id, s.date, s.start_time, s.end_time, s.capacity,
           c.name AS course_name, c.price_cents
    FROM slots s
    JOIN courses c ON c.id = s.course_id
    WHERE s.date >= ? AND s.date < ?
    ORDER BY s.date, s.start_time
  `);
  const listMonthRegistrations = database.prepare(`
    SELECT r.id, r.slot_id, r.student_name, r.company_name, r.phone, r.email, r.status, r.payment_method,
           r.payment_status, r.amount_cents, r.receipt_path, r.confirmation_email_status,
           r.kpay_checkout_url, r.created_at, s.date, s.start_time, s.end_time, c.name AS course_name
    FROM registrations r
    JOIN slots s ON s.id = r.slot_id
    JOIN courses c ON c.id = s.course_id
    WHERE s.date >= ? AND s.date < ?
    ORDER BY s.date, s.start_time, r.created_at
  `);
  const countTaken = database.prepare(`
    SELECT slot_id, COUNT(*) AS taken
    FROM registrations
    WHERE status != 'cancelled'
      AND (
        payment_status IN ('received', 'paid')
        OR (payment_status = 'pending' AND created_at >= ?)
      )
    GROUP BY slot_id
  `);
  const countSlotTaken = database.prepare(`
    SELECT COUNT(*) AS taken
    FROM registrations
    WHERE slot_id = ?
      AND status != 'cancelled'
      AND (
        payment_status IN ('received', 'paid')
        OR (payment_status = 'pending' AND created_at >= ?)
      )
  `);
  const insertRegistration = database.prepare(`
    INSERT INTO registrations (
      id, slot_id, student_name, company_name, phone, email, status, payment_method, payment_status,
      amount_cents, receipt_path, receipt_mime, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findRegistration = database.prepare(`
    SELECT r.*, s.date, s.start_time, s.end_time, c.name AS course_name
    FROM registrations r
    JOIN slots s ON s.id = r.slot_id
    JOIN courses c ON c.id = s.course_id
    WHERE r.id = ?
  `);

  const markPaid = database.prepare(`
    UPDATE registrations SET status = 'confirmed', payment_status = 'paid' WHERE id = ?
  `);
  const markFailed = database.prepare(`
    UPDATE registrations SET status = 'cancelled', payment_status = 'failed' WHERE id = ?
  `);

  async function requireAdmin(request) {
    const header = request.headers.authorization || "";
    if (!header.toLowerCase().startsWith("bearer ")) throw httpError(401, "請先登入。");
    const token = header.slice(7).trim();
    const session = token ? await getSession.get(token) : undefined;
    if (!session || !session.is_active) throw httpError(401, "登入已失效，請再登入。");
    if (session.expires_at <= new Date().toISOString()) {
      await deleteSession.run(token);
      throw httpError(401, "登入已逾時，請再登入。");
    }
    return session;
  }

  async function takenBySlot(now) {
    const counts = new Map();
    for (const row of await countTaken.all(holdCutoff(env, now))) counts.set(row.slot_id, row.taken);
    return counts;
  }

  async function suggestionsFor(chosen, now) {
    const counts = await takenBySlot(now);
    const today = hongKongParts(now).date;
    const rows = (await listFutureSlots.all(today)).filter((row) => row.id !== chosen.id && isBookable(row.date, row.start_time, now));
    const open = rows.flatMap((row) => {
      const seatsLeft = row.capacity - (counts.get(row.id) || 0);
      if (seatsLeft <= 0) return [];
      return [{
        slotId: row.id,
        courseId: row.course_id,
        courseName: row.course_name,
        date: row.date,
        startTime: row.start_time,
        endTime: row.end_time,
        seatsLeft,
        priceCents: row.price_cents,
        sameCourse: row.course_id === chosen.course_id,
      }];
    });
    open.sort((a, b) => {
      if (a.sameCourse !== b.sameCourse) return a.sameCourse ? -1 : 1;
      return `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`);
    });
    return open.slice(0, 6).map(({ sameCourse, ...suggestion }) => suggestion);
  }

  function studentFields(input) {
    const studentName = String(input.studentName || "").trim();
    const companyName = String(input.companyName || "").trim();
    if (!isText(companyName, 120)) throw httpError(400, "請填寫公司名稱（最多 120 字）。");
    const phone = String(input.phone || "").trim();
    const email = String(input.email || "").trim();
    const slotId = String(input.slotId || "").trim();
    if (!isText(studentName, 60) || !isText(phone, 30) || !isEmail(email) || !isText(slotId, 80)) {
      throw httpError(400, "登記資料不完整或格式不正確。");
    }
    return { studentName, companyName, phone, email, slotId };
  }

  async function reserve(fields, now, payment) {
    return withTransaction(database, async () => {
      if (database.lockSlot) await database.lockSlot(fields.slotId);
      const slot = await slotWithCourse.get(fields.slotId);
      if (!slot || !slot.active) throw httpError(404, "找不到可預約的時段。");
      if (!isBookable(slot.date, slot.start_time, now)) throw httpError(400, "此時段已結束或未開放。");
      const taken = (await countSlotTaken.get(slot.id, holdCutoff(env, now))).taken;
      if (taken >= slot.capacity) {
        throw httpError(409, "此時段已滿。", { full: true, suggestions: await suggestionsFor(slot, now) });
      }
      const id = crypto.randomUUID();
      let receiptPath = "";
      let receiptMime = "";
      if (payment.receipt) {
        receiptPath = database.kind === "mysql" ? `mysql:${id}` : saveReceipt(uploadsDir, id, payment.receipt);
        receiptMime = payment.receipt.mime;
      }
      const createdAt = now.toISOString();
      try {
        await insertRegistration.run(
          id,
          slot.id,
          fields.studentName,
          fields.companyName,
          fields.phone,
          fields.email,
          payment.status,
          payment.method,
          payment.paymentStatus,
          slot.price_cents,
          receiptPath || null,
          receiptMime || null,
          createdAt,
        );
        if (database.saveReceipt && payment.receipt) await database.saveReceipt(id, payment.receipt);
      } catch (error) {
        if (receiptPath && database.kind !== "mysql") {
          const full = storedPath(uploadsDir, receiptPath);
          if (full && existsSync(full)) unlinkSync(full);
        }
        throw error;
      }
      return mapRegistration({
        id,
        slot_id: slot.id,
        student_name: fields.studentName,
        company_name: fields.companyName,
        phone: fields.phone,
        email: fields.email,
        status: payment.status,
        payment_method: payment.method,
        payment_status: payment.paymentStatus,
        amount_cents: slot.price_cents,
        receipt_path: receiptPath,
        confirmation_email_status: "",
        kpay_checkout_url: "",
        course_name: slot.course_name,
        date: slot.date,
        start_time: slot.start_time,
        end_time: slot.end_time,
      });
    });
  }

  async function registerFps(parts, response, now) {
    const fields = {};
    let receipt = null;
    for (const part of parts) {
      if (part.filename && part.name === "receipt") receipt = part;
      else if (part.name) fields[part.name] = part.data.toString("utf8").trim();
    }
    if (fields.paymentMethod && fields.paymentMethod !== "fps") {
      throw httpError(400, "轉數快登記需要上載收據。");
    }
    const student = studentFields(fields);
    if (!receipt) throw httpError(400, "請上載 .jpg 付款證明。");
    const image = detectReceipt(basename(receipt.filename), receipt.contentType, receipt.data);
    if (!image) throw httpError(400, "付款證明只接受 .jpg。");
    image.data = receipt.data;
    const registration = await reserve(student, now, {
      method: "fps",
      status: "confirmed",
      paymentStatus: "received",
      receipt: image,
    });
    registration.emailStatus = await sendConfirmation(database, env, fetchImpl, registration);
    sendJson(response, 201, { registration });
  }

  return async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/api/bookings") {
        return sendJson(response, 200, { bookings: await listBookings.all() });
      }

      if (request.method === "POST" && url.pathname === "/api/bookings") {
        const booking = await readJson(request);
        if (!validateBooking(booking)) return sendJson(response, 400, { error: "預約資料不完整或格式不正確。" });
        await insertBooking.run(
          booking.id.trim(),
          booking.student.trim(),
          booking.phone.trim(),
          booking.course.trim(),
          booking.date,
          booking.time,
          booking.status,
        );
        return sendJson(response, 201, { booking });
      }

      const statusMatch = url.pathname.match(/^\/api\/bookings\/([^/]+)\/status$/);
      if (request.method === "PATCH" && statusMatch) {
        const body = await readJson(request);
        if (!VALID_STATUSES.has(body.status)) return sendJson(response, 400, { error: "預約狀態不正確。" });
        const result = await updateStatus.run(body.status, decodeURIComponent(statusMatch[1]));
        if (result.changes === 0) return sendJson(response, 404, { error: "找不到預約。" });
        return sendJson(response, 200, { status: body.status });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJson(request);
        const username = String(body.username || "").trim();
        const password = String(body.password || "");
        const admin = await findAdmin.get(username);
        if (!admin || !admin.is_active || !verifyPassword(password, admin.password_salt, admin.password_hash)) {
          return sendJson(response, 401, { error: "帳號或密碼不正確。" });
        }
        const token = newSessionToken();
        const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
        await insertSession.run(token, admin.id, expiresAt);
        return sendJson(response, 200, { token, username: admin.username, role: "ADMIN" });
      }

      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        const admin = await requireAdmin(request);
        return sendJson(response, 200, { token: admin.token, username: admin.username, role: "ADMIN" });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        const header = request.headers.authorization || "";
        const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
        if (token) await deleteSession.run(token);
        return sendJson(response, 200, { ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/public/config") {
        return sendJson(response, 200, {
          kpayReady: false,
          currency: "HKD",
        });
      }

      if (request.method === "GET" && url.pathname === "/api/public/catalog") {
        const now = new Date();
        const counts = await takenBySlot(now);
        const today = hongKongParts(now).date;
        const slots = (await listFutureSlots.all(today)).flatMap((row) => {
          if (!isBookable(row.date, row.start_time, now)) return [];
          const taken = counts.get(row.id) || 0;
          return [{
            id: row.id,
            courseId: row.course_id,
            courseName: row.course_name,
            date: row.date,
            startTime: row.start_time,
            endTime: row.end_time,
            capacity: row.capacity,
            seatsLeft: Math.max(0, row.capacity - taken),
            priceCents: row.price_cents,
          }];
        });
        return sendJson(response, 200, { courses: (await listCourses.all()).map(mapCourse), slots });
      }

      const publicRegistration = url.pathname.match(/^\/api\/public\/registrations\/([^/]+)$/);
      if (request.method === "GET" && publicRegistration) {
        const row = await findRegistration.get(decodeURIComponent(publicRegistration[1]));
        if (!row) return sendJson(response, 404, { error: "找不到登記。" });
        const registration = mapRegistration(row);
        return sendJson(response, 200, {
          registration: {
            id: registration.id,
            studentName: registration.studentName,
            courseName: registration.courseName,
            date: registration.date,
            startTime: registration.startTime,
            endTime: registration.endTime,
            paymentMethod: registration.paymentMethod,
            paymentStatus: registration.paymentStatus,
            status: registration.status,
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/api/registrations") {
        const now = new Date();
        const contentType = request.headers["content-type"] || "";
        if (contentType.includes("multipart/form-data")) {
          const body = await readBody(request, MAX_RECEIPT_BYTES + 512 * 1024);
          return await registerFps(parseMultipart(body, contentType), response, now);
        }
        return sendJson(response, 400, { error: "請上載 .jpg 付款證明。" });
      }

      if (request.method === "POST" && url.pathname === "/api/payments/kpay/webhook") {
        const raw = await readBody(request, 100_000);
        const config = kpayConfig(env);
        if (!verifyWebhook(config, raw, request.headers["x-kpay-signature"])) {
          return sendJson(response, 401, { error: "無法核對 KPay 通知。" });
        }
        let payload;
        try {
          payload = JSON.parse(raw.toString("utf8") || "{}");
        } catch {
          return sendJson(response, 400, { error: "KPay 通知格式不正確。" });
        }
        const registrationId = String(payload?.data?.merchant_order_id || payload?.merchant_order_id || "");
        const row = registrationId ? await findRegistration.get(registrationId) : undefined;
        const outcome = webhookOutcome(payload);
        if (!row || outcome === "ignore") return sendJson(response, 200, { received: true });
        if (outcome === "paid" && row.payment_status !== "paid") {
          await markPaid.run(row.id);
          const paid = mapRegistration(await findRegistration.get(row.id));
          paid.emailStatus = await sendConfirmation(database, env, fetchImpl, paid);
        } else if (outcome === "failed" && row.payment_status === "pending") {
          await markFailed.run(row.id);
        }
        return sendJson(response, 200, { received: true });
      }

      if (request.method === "GET" && url.pathname === "/api/admin/courses") {
        await requireAdmin(request);
        return sendJson(response, 200, { courses: (await listCourses.all()).map(mapCourse) });
      }

      if (request.method === "POST" && url.pathname === "/api/admin/courses") {
        await requireAdmin(request);
        const body = await readJson(request);
        const name = String(body.name || "").trim();
        const description = String(body.description || "").trim();
        const cents = priceCents(body.priceHkd);
        if (!isText(name, 100) || description.length > 500 || cents == null) {
          return sendJson(response, 400, { error: "課程資料不完整或格式不正確。" });
        }
        if (await findCourseName.get(name)) return sendJson(response, 409, { error: "已有同名課程。" });
        const id = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        await insertCourse.run(id, name, description, cents, createdAt);
        return sendJson(response, 201, { course: mapCourse(await findCourse.get(id)) });
      }

      if (request.method === "POST" && url.pathname === "/api/admin/slots") {
        await requireAdmin(request);
        const body = await readJson(request);
        const course = await findCourse.get(String(body.courseId || "").trim());
        const date = String(body.date || "");
        const startTime = String(body.startTime || "");
        const endTime = String(body.endTime || "");
        const capacity = Number(body.capacity);
        if (!course || !course.active || !isDate(date) || !isTime(startTime) || !isTime(endTime) || endTime <= startTime) {
          return sendJson(response, 400, { error: "時段資料不完整或格式不正確。" });
        }
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) {
          return sendJson(response, 400, { error: "時段名額須為 1 至 500。" });
        }
        const id = crypto.randomUUID();
        await insertSlot.run(id, course.id, date, startTime, endTime, capacity, new Date().toISOString());
        return sendJson(response, 201, {
          slot: {
            id,
            courseId: course.id,
            courseName: course.name,
            date,
            startTime,
            endTime,
            capacity,
            priceCents: course.price_cents,
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/api/admin/calendar") {
        await requireAdmin(request);
        const month = url.searchParams.get("month") || hongKongParts().month;
        const range = monthRange(month);
        if (!range) return sendJson(response, 400, { error: "月份格式不正確。" });
        const now = new Date();
        const counts = await takenBySlot(now);
        const registrations = (await listMonthRegistrations.all(range.start, range.next)).map(mapRegistration);
        const bySlot = new Map();
        for (const registration of registrations) {
          const list = bySlot.get(registration.slotId) || [];
          list.push(registration);
          bySlot.set(registration.slotId, list);
        }
        const slots = (await listMonthSlots.all(range.start, range.next)).map((row) => {
          const taken = counts.get(row.id) || 0;
          return {
            id: row.id,
            courseId: row.course_id,
            courseName: row.course_name,
            date: row.date,
            startTime: row.start_time,
            endTime: row.end_time,
            capacity: row.capacity,
            taken,
            seatsLeft: Math.max(0, row.capacity - taken),
            priceCents: row.price_cents,
            registrations: bySlot.get(row.id) || [],
          };
        });
        return sendJson(response, 200, { month, slots });
      }

      const receiptMatch = url.pathname.match(/^\/api\/admin\/registrations\/([^/]+)\/receipt$/);
      if (request.method === "GET" && receiptMatch) {
        await requireAdmin(request);
        const row = await findRegistration.get(decodeURIComponent(receiptMatch[1]));
        if (!row?.receipt_path) return sendJson(response, 404, { error: "找不到收據。" });
        let receiptData;
        if (database.loadReceipt) receiptData = await database.loadReceipt(row.id);
        else {
          const full = storedPath(uploadsDir, row.receipt_path);
          if (full && existsSync(full)) receiptData = readFileSync(full);
        }
        if (!receiptData) return sendJson(response, 404, { error: "找不到收據。" });
        response.writeHead(200, {
          "Content-Type": row.receipt_mime || "application/octet-stream",
          "Content-Disposition": "inline; filename=\"receipt\"",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        });
        return response.end(receiptData);
      }

      if (request.method === "GET" && PUBLIC_FILES.has(url.pathname)) {
        const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
        const filePath = join(ROOT, pathname);
        if (!existsSync(filePath)) return sendJson(response, 404, { error: "Not found" });
        response.writeHead(200, {
          "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
          "Cache-Control": "no-cache",
        });
        return response.end(readFileSync(filePath));
      }

      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (error.statusCode) return sendJson(response, error.statusCode, error.payload || { error: error.message });
      const duplicate = error.code === "ERR_SQLITE_CONSTRAINT_PRIMARYKEY" || error.code === "ER_DUP_ENTRY";
      console.error(error);
      return sendJson(response, duplicate ? 409 : 500, {
        error: duplicate ? "此預約已存在。" : "伺服器暫時無法處理要求。",
      });
    }
  };
}

function startServer(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  const databasePath = options.databasePath || env.DATABASE_PATH || join(ROOT, "data", "bookings.db");
  const port = options.port ?? Number(env.PORT || 8000);
  let host = options.host || env.HOST || "0.0.0.0";
  if (process.env.TUTOR_BOOKING_SQLITE_RETRY !== "1" && (host === "127.0.0.1" || host === "localhost")) host = "0.0.0.0";
  const uploadsDir = resolve(options.uploadsDir || env.UPLOADS_DIR || join(ROOT, "data", "uploads"));
  const database = options.database || openDatabase(databasePath);
  if (database.kind !== "mysql") mkdirSync(uploadsDir, { recursive: true });
  const adminUsername = options.adminUsername ?? env.ADMIN_USERNAME ?? "admin";
  const adminPassword = options.adminPassword ?? env.ADMIN_PASSWORD ?? "admin1234";
  const resetAdminPassword = options.resetAdminPassword ?? (options.adminPassword == null && Boolean(env.ADMIN_PASSWORD));
  const ready = seedAdmin(database, { username: String(adminUsername).trim() || "admin", password: String(adminPassword), reset: resetAdminPassword });
  const server = createServer(createRequestHandler(database, {
    env,
    fetchImpl: options.fetchImpl,
    uploadsDir,
  }));
  if (options.reminders) {
    const tick = () => {
      processDueReminders(database, { env, fetchImpl: options.fetchImpl }).catch((error) => console.error(error));
    };
    const timer = setInterval(tick, 60_000);
    if (typeof timer.unref === "function") timer.unref();
    server.on("listening", tick);
    server.on("close", () => clearInterval(timer));
  }
  ready.then(() => server.listen(port, host)).catch((error) => {
    database.close();
    server.emit("error", error);
  });
  server.on("close", () => database.close());
  return { server, database, env };
}

async function startConfiguredServer(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  if (env.DB_TYPE !== "mysql") return startServer(options);
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) {
    throw new Error("Set ADMIN_PASSWORD to at least 12 characters for MySQL hosting.");
  }
  const { openMysqlDatabase } = require("./lib/mysql");
  const database = await openMysqlDatabase(env);
  return startServer({ ...options, database, env });
}

if (require.main === module || process.env.TUTOR_BOOKING_FORCE_START === "1") {
  loadEnvFile(join(ROOT, ".env"));
  if (process.env.DB_TYPE !== "mysql" && !sqliteReady()) {
    relaunchWithSqlite();
  } else {
    const port = Number(process.env.PORT || 8000);
    console.log(`Starting tutor booking on ${process.env.HOST || "0.0.0.0"}:${port} with Node ${process.version} (${process.env.DB_TYPE === "mysql" ? "mysql" : "sqlite"})`);
    startConfiguredServer({ reminders: true }).then(({ server }) => {
      server.on("listening", () => {
        const address = server.address();
        console.log(`AI 課程預約系統：http://${address.address}:${address.port}`);
      });
      server.on("error", (error) => {
        console.error(error);
        process.exit(1);
      });
    }).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
}

module.exports = { startConfiguredServer, startServer, processDueReminders, loadEnvFile };
