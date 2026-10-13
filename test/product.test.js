const { describe, test, after } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { once } = require("node:events");
const { startServer, processDueReminders } = require("../server");
const { hongKongParts } = require("../lib/time");

const temporaryDirectory = mkdtempSync(join(tmpdir(), "tutor-product-"));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const { server, database } = startServer({
  databasePath: join(temporaryDirectory, "test.db"),
  uploadsDir: join(temporaryDirectory, "uploads"),
  port: 0,
  adminPassword: "admin1234",
  env: { RESEND_API_KEY: "", KPAY_ENABLED: "false", FPS_PAYEE_NAME: "AI 學習中心", FPS_IDENTIFIER: "1234567" },
});

after(() => new Promise((resolve) => server.close(resolve)));

async function baseUrl() {
  if (!server.listening) await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function login(url) {
  const response = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin1234" }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function createCourse(url, token, name) {
  const response = await fetch(`${url}/api/admin/courses`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ name, description: "入門班", priceHkd: 480 }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).course;
}

async function createSlot(url, token, courseId, date, capacity = 1) {
  const response = await fetch(`${url}/api/admin/slots`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ courseId, date, startTime: "15:00", endTime: "16:00", capacity }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).slot;
}

function futureDate(days) {
  const future = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return hongKongParts(future).date;
}

function registrationForm({ slotId, email = "ming@example.com", file, filename, type }) {
  const form = new FormData();
  form.set("studentName", "陳小明");
  form.set("companyName", "Example Company");
  form.set("phone", "91234567");
  form.set("email", email);
  form.set("slotId", slotId);
  form.set("paymentMethod", "fps");
  form.set("receipt", new File([file], filename, { type }));
  return form;
}

describe("booking product", { concurrency: false }, () => {
test("rejects admin actions without a session and accepts the seeded admin", async () => {
  const url = await baseUrl();
  const denied = await fetch(`${url}/api/admin/courses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "未授權", priceHkd: 10 }),
  });
  assert.equal(denied.status, 401);

  const wrong = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "nope" }),
  });
  assert.equal(wrong.status, 401);

  const session = await login(url);
  assert.equal(session.role, "ADMIN");
  const me = await fetch(`${url}/api/auth/me`, { headers: authHeaders(session.token) });
  assert.equal(me.status, 200);
});

test("admin creates a course and slot, and the calendar lists the booking receipt", async () => {
  const url = await baseUrl();
  const session = await login(url);
  const course = await createCourse(url, session.token, "人工智能入門");
  const slot = await createSlot(url, session.token, course.id, futureDate(3), 2);
  const config = await (await fetch(`${url}/api/public/config`)).json();
  assert.equal(config.fpsPayeeName, "AI 學習中心");
  assert.equal(config.kpayReady, false);

  const created = await fetch(`${url}/api/registrations`, {
    method: "POST",
    body: registrationForm({ slotId: slot.id, file: png, filename: "receipt.png", type: "image/png" }),
  });
  assert.equal(created.status, 201);
  const { registration } = await created.json();
  assert.equal(registration.companyName, "Example Company");
  assert.equal(registration.paymentMethod, "fps");
  assert.equal(registration.paymentStatus, "received");
  assert.equal(registration.emailStatus, "skipped");

  const calendar = await fetch(`${url}/api/admin/calendar?month=${slot.date.slice(0, 7)}`, {
    headers: authHeaders(session.token),
  });
  const body = await calendar.json();
  const listed = body.slots.find((item) => item.id === slot.id);
  assert.equal(listed.registrations[0].studentName, "陳小明");
  assert.equal(listed.registrations[0].companyName, "Example Company");
  assert.equal(listed.registrations[0].hasReceipt, true);
  assert.equal(listed.taken, 1);

  const receipt = await fetch(`${url}/api/admin/registrations/${registration.id}/receipt`, {
    headers: authHeaders(session.token),
  });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await receipt.arrayBuffer()), png);

  const hidden = await fetch(`${url}/api/admin/registrations/${registration.id}/receipt`);
  assert.equal(hidden.status, 401);
});

test("accepts a jpeg receipt and rejects other files", async () => {
  const url = await baseUrl();
  const session = await login(url);
  const course = await createCourse(url, session.token, "Python 與機器學習");
  const slot = await createSlot(url, session.token, course.id, futureDate(4), 2);
  const ok = await fetch(`${url}/api/registrations`, {
    method: "POST",
    body: registrationForm({
      slotId: slot.id,
      email: "jpeg@example.com",
      file: jpeg,
      filename: "slip.jpeg",
      type: "image/jpeg",
    }),
  });
  assert.equal(ok.status, 201);

  const rejected = await fetch(`${url}/api/registrations`, {
    method: "POST",
    body: registrationForm({
      slotId: slot.id,
      email: "gif@example.com",
      file: Buffer.from("GIF89a not an image"),
      filename: "note.png",
      type: "image/png",
    }),
  });
  assert.equal(rejected.status, 400);
});

test("suggests other open slots when the chosen slot is full", async () => {
  const url = await baseUrl();
  const session = await login(url);
  const course = await createCourse(url, session.token, "生成式 AI 工作坊");
  const other = await createCourse(url, session.token, "AI 專題指導");
  const fullSlot = await createSlot(url, session.token, course.id, futureDate(5), 1);
  const sameCourse = await createSlot(url, session.token, course.id, futureDate(6), 1);
  await createSlot(url, session.token, other.id, futureDate(7), 1);

  const first = await fetch(`${url}/api/registrations`, {
    method: "POST",
    body: registrationForm({
      slotId: fullSlot.id,
      email: "first@example.com",
      file: png,
      filename: "first.png",
      type: "image/png",
    }),
  });
  assert.equal(first.status, 201);

  const second = await fetch(`${url}/api/registrations`, {
    method: "POST",
    body: registrationForm({
      slotId: fullSlot.id,
      email: "second@example.com",
      file: png,
      filename: "second.png",
      type: "image/png",
    }),
  });
  assert.equal(second.status, 409);
  const payload = await second.json();
  assert.equal(payload.full, true);
  assert.equal(payload.suggestions[0].slotId, sameCourse.id);
  assert.ok(payload.suggestions.some((item) => item.courseName === "AI 專題指導"));
});

test("registration requires a company name and an FPS receipt", async () => {
  const url = await baseUrl();
  const session = await login(url);
  const course = await createCourse(url, session.token, "Required fields");
  const slot = await createSlot(url, session.token, course.id, futureDate(8), 1);
  for (const companyName of [null, "   ", "x".repeat(121)]) {
    const form = registrationForm({ slotId: slot.id, file: png, filename: "test.png", type: "image/png" });
    if (companyName === null) form.delete("companyName");
    else form.set("companyName", companyName);
    const response = await fetch(`${url}/api/registrations`, { method: "POST", body: form });
    assert.equal(response.status, 400);
  }
  const form = registrationForm({ slotId: slot.id, file: png, filename: "test.png", type: "image/png" });
  form.delete("receipt");
  const response = await fetch(`${url}/api/registrations`, { method: "POST", body: form });
  assert.equal(response.status, 400);
  const accepted = await fetch(`${url}/api/registrations`, {
    method: "POST", body: registrationForm({ slotId: slot.id, file: png, filename: "test.png", type: "image/png" }),
  });
  assert.equal(accepted.status, 201);
});

test("KPay is rejected even with merchant settings and does not keep a seat", async () => {
  const started = startServer({
    databasePath: join(mkdtempSync(join(tmpdir(), "tutor-kpay-fail-")), "kpay.db"),
    port: 0,
    adminPassword: "admin1234",
    fetchImpl: async () => new Response("nope", { status: 500 }),
    env: {
      RESEND_API_KEY: "",
      KPAY_ENABLED: "true",
      KPAY_API_BASE: "https://merchant.example.test",
      KPAY_MERCHANT_ID: "merchant",
      KPAY_APP_ID: "app",
      KPAY_API_SECRET: "api-secret",
      KPAY_WEBHOOK_SECRET: "hook-secret",
    },
  });
  try {
    if (!started.server.listening) await once(started.server, "listening");
    const url = `http://127.0.0.1:${started.server.address().port}`;
    const session = await login(url);
    const course = await createCourse(url, session.token, "失敗後仍可預約");
    const slot = await createSlot(url, session.token, course.id, futureDate(9), 1);
    const failed = await fetch(`${url}/api/registrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentName: "陳小明",
        phone: "91234567",
        email: "fail@example.com",
        slotId: slot.id,
        paymentMethod: "kpay",
      }),
    });
    assert.equal(failed.status, 400);
    const booked = await fetch(`${url}/api/registrations`, {
      method: "POST",
      body: registrationForm({ slotId: slot.id, file: png, filename: "after.png", type: "image/png" }),
    });
    assert.equal(booked.status, 201);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
});

test("reminder selection stays quiet without a Resend key", async () => {
  const results = await processDueReminders(database, {
    env: { RESEND_API_KEY: "", REMINDER_HOURS_BEFORE: "240" },
    now: new Date(),
  });
  assert.ok(results.every((item) => item.status === "skipped"));
  const again = await processDueReminders(database, {
    env: { RESEND_API_KEY: "", REMINDER_HOURS_BEFORE: "240" },
    now: new Date(),
  });
  assert.deepEqual(again.map((item) => item.status), results.map(() => "skipped"));
});

test("unsigned kpay webhooks are rejected", async () => {
  const url = await baseUrl();
  const response = await fetch(`${url}/api/payments/kpay/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "payment_intent.succeeded" }),
  });
  assert.equal(response.status, 401);
});
});
