const { describe, test, after } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { once } = require("node:events");
const { startServer, processDueReminders } = require("../server");
const { hongKongParts } = require("../lib/time");
const { signBody } = require("../lib/kpay");

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
  assert.equal(registration.paymentMethod, "fps");
  assert.equal(registration.paymentStatus, "received");
  assert.equal(registration.emailStatus, "skipped");

  const calendar = await fetch(`${url}/api/admin/calendar?month=${slot.date.slice(0, 7)}`, {
    headers: authHeaders(session.token),
  });
  const body = await calendar.json();
  const listed = body.slots.find((item) => item.id === slot.id);
  assert.equal(listed.registrations[0].studentName, "陳小明");
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

test("kpay checkout can be switched on, and a signed webhook confirms the seat", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: options.body, headers: options.headers });
    if (String(url).includes("api.resend.com")) {
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      id: "pi_123",
      amount: 48000,
      currency: "HKD",
      status: "requires_payment_method",
      checkout_url: "https://pay.kpay-group.com/checkout/pi_123",
    }), { status: 200 });
  };
  const directory = mkdtempSync(join(tmpdir(), "tutor-kpay-"));
  const started = startServer({
    databasePath: join(directory, "kpay.db"),
    uploadsDir: join(directory, "uploads"),
    port: 0,
    adminPassword: "admin1234",
    fetchImpl,
    env: {
      RESEND_API_KEY: "re_test_key",
      RESEND_FROM: "AI 學習中心 <bookings@example.com>",
      KPAY_ENABLED: "true",
      KPAY_API_BASE: "https://merchant.example.test",
      KPAY_MERCHANT_ID: "merchant",
      KPAY_APP_ID: "app",
      KPAY_API_SECRET: "api-secret",
      KPAY_WEBHOOK_SECRET: "hook-secret",
      PUBLIC_BASE_URL: "https://booking.example.test",
    },
  });
  try {
    if (!started.server.listening) await once(started.server, "listening");
    const url = `http://127.0.0.1:${started.server.address().port}`;
    const session = await login(url);
    const course = await createCourse(url, session.token, "KPay 課程");
    const slot = await createSlot(url, session.token, course.id, futureDate(8), 1);
    const disabled = await fetch(`${await baseUrl()}/api/registrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentName: "陳小明",
        phone: "91234567",
        email: "kpay-off@example.com",
        slotId: slot.id,
        paymentMethod: "kpay",
      }),
    });
    assert.equal(disabled.status, 503);

    const created = await fetch(`${url}/api/registrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentName: "陳小明",
        phone: "91234567",
        email: "kpay@example.com",
        slotId: slot.id,
        paymentMethod: "kpay",
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.checkoutUrl, "https://pay.kpay-group.com/checkout/pi_123");
    const intentCall = calls.find((call) => call.url === "https://merchant.example.test/v1/payment_intents");
    assert.ok(intentCall);
    assert.equal(intentCall.headers["X-KPay-Signature"], signBody("api-secret", intentCall.body));
    assert.equal(JSON.parse(intentCall.body).amount, 48000);

    const raw = JSON.stringify({
      event: "payment_intent.succeeded",
      data: { id: "pi_123", merchant_order_id: createdBody.registration.id, status: "succeeded" },
    });
    const webhook = await fetch(`${url}/api/payments/kpay/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-KPay-Signature": signBody("hook-secret", raw),
      },
      body: raw,
    });
    assert.equal(webhook.status, 200);
    const status = await (await fetch(`${url}/api/public/registrations/${createdBody.registration.id}`)).json();
    assert.equal(status.registration.paymentStatus, "paid");
    assert.ok(calls.some((call) => call.url === "https://api.resend.com/emails" && call.body.includes("上課") === false && call.body.includes("已確認")));

    const reminder = await processDueReminders(started.database, {
      env: { ...started.env, REMINDER_HOURS_BEFORE: "240" },
      fetchImpl,
      now: new Date(),
    });
    assert.equal(reminder[0].status, "sent");
    assert.ok(calls.some((call) => call.body.includes("提醒你準時出席")));
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
});

test("a failed kpay request does not keep the seat", async () => {
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
    assert.equal(failed.status, 502);
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
