const { createServer } = require("node:http");
const { readFileSync, existsSync, mkdirSync } = require("node:fs");
const { extname, join, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PUBLIC_FILES = new Set(["/", "/index.html", "/app.js", "/styles.css"]);
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const VALID_STATUSES = new Set(["pending", "checked-in", "cancelled"]);

function openDatabase(databasePath) {
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
  `);
  return database;
}

function isText(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

function validateBooking(value) {
  return value
    && isText(value.id, 100)
    && isText(value.student, 60)
    && isText(value.phone, 30)
    && isText(value.course, 100)
    && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
    && /^\d{2}:\d{2}$/.test(value.time)
    && VALID_STATUSES.has(value.status);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
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

function createRequestHandler(database) {
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

  return async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    try {
      if (request.method === "GET" && url.pathname === "/api/bookings") {
        return sendJson(response, 200, { bookings: listBookings.all() });
      }

      if (request.method === "POST" && url.pathname === "/api/bookings") {
        const booking = await readJson(request);
        if (!validateBooking(booking)) {
          return sendJson(response, 400, { error: "預約資料不完整或格式不正確。" });
        }
        insertBooking.run(
          booking.id.trim(), booking.student.trim(), booking.phone.trim(), booking.course.trim(),
          booking.date, booking.time, booking.status,
        );
        return sendJson(response, 201, { booking });
      }

      const statusMatch = url.pathname.match(/^\/api\/bookings\/([^/]+)\/status$/);
      if (request.method === "PATCH" && statusMatch) {
        const body = await readJson(request);
        if (!VALID_STATUSES.has(body.status)) {
          return sendJson(response, 400, { error: "預約狀態不正確。" });
        }
        const result = updateStatus.run(body.status, decodeURIComponent(statusMatch[1]));
        if (result.changes === 0) return sendJson(response, 404, { error: "找不到預約。" });
        return sendJson(response, 200, { status: body.status });
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
      const duplicate = error.code === "ERR_SQLITE_CONSTRAINT_PRIMARYKEY";
      console.error(error);
      return sendJson(response, duplicate ? 409 : 500, {
        error: duplicate ? "此預約已存在。" : "伺服器暫時無法處理要求。",
      });
    }
  };
}

function startServer(options = {}) {
  const databasePath = options.databasePath || process.env.DATABASE_PATH || join(ROOT, "data", "bookings.db");
  const port = options.port ?? Number(process.env.PORT || 8000);
  const host = options.host || process.env.HOST || "127.0.0.1";
  const database = openDatabase(databasePath);
  const server = createServer(createRequestHandler(database));
  server.listen(port, host);
  server.on("close", () => database.close());
  return { server, database };
}

if (require.main === module) {
  const { server } = startServer();
  server.on("listening", () => {
    const address = server.address();
    console.log(`AI 課程預約系統：http://${address.address}:${address.port}`);
  });
}

module.exports = { startServer };
