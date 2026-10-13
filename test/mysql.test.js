const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { startConfiguredServer } = require("../server");
const { hongKongParts } = require("../lib/time");

test("MySQL preserves company/receipt across restart and serializes the last seat", {
  skip: !process.env.MYSQL_TEST_NAME,
}, async () => {
  assert.match(process.env.MYSQL_TEST_NAME, /^test_/, "Use a dedicated test database, never a live database");
  const uploadsDir = mkdtempSync(join(tmpdir(), "tutor-mysql-"));
  const env = {
    DB_TYPE: "mysql", DB_HOST: process.env.MYSQL_TEST_HOST || "127.0.0.1",
    DB_PORT: process.env.MYSQL_TEST_PORT || "13306", DB_NAME: process.env.MYSQL_TEST_NAME,
    DB_USER: process.env.MYSQL_TEST_USER, DB_PASSWORD: process.env.MYSQL_TEST_PASSWORD,
    ADMIN_PASSWORD: "mysql-test-admin-password", RESEND_API_KEY: "",
  };
  let started;
  async function start() {
    started = await startConfiguredServer({ env, uploadsDir, port: 0 });
    if (!started.server.listening) await once(started.server, "listening");
    return `http://127.0.0.1:${started.server.address().port}`;
  }
  async function close() { await new Promise((resolve) => started.server.close(resolve)); }
  let base = await start();
  async function api(path, body, token, expected = 200) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET", headers,
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    });
    assert.equal(response.status, expected, await response.clone().text());
    return response;
  }
  async function login() {
    return (await (await api("/api/auth/login", { username: "admin", password: env.ADMIN_PASSWORD })).json()).token;
  }
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  try {
    let token = await login();
    const course = (await (await api("/api/admin/courses", { name: `MySQL ${randomUUID()}`, description: "", priceHkd: 480 }, token, 201)).json()).course;
    const date = hongKongParts(new Date(Date.now() + 10 * 86400000)).date;
    const slot = (await (await api("/api/admin/slots", { courseId: course.id, date, startTime: "15:00", endTime: "16:00", capacity: 1 }, token, 201)).json()).slot;
    function form(email) {
      const body = new FormData();
      for (const [key, value] of Object.entries({ studentName: "MySQL Student", companyName: "公司測試 🐱", phone: "91234567", email, slotId: slot.id, paymentMethod: "fps" })) body.set(key, value);
      body.set("receipt", new File([png], "receipt.png", { type: "image/png" }));
      return body;
    }
    const missing = form("missing@example.com");
    missing.delete("receipt");
    await api("/api/registrations", missing, null, 400);
    const noCompany = form("missing-company@example.com");
    noCompany.delete("companyName");
    await api("/api/registrations", noCompany, null, 400);
    const responses = await Promise.all([
      fetch(base + "/api/registrations", { method: "POST", body: form("one@example.com") }),
      fetch(base + "/api/registrations", { method: "POST", body: form("two@example.com") }),
    ]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    const registration = (await responses.find(r => r.status === 201).json()).registration;
    assert.equal(registration.companyName, "公司測試 🐱");
    const receipt = await api(`/api/admin/registrations/${registration.id}/receipt`, null, token);
    assert.deepEqual(Buffer.from(await receipt.arrayBuffer()), png);
    const denied = await fetch(base + `/api/admin/registrations/${registration.id}/receipt`);
    assert.equal(denied.status, 401);
    assert.deepEqual(readdirSync(uploadsDir), [], "MySQL receipts must not depend on local files");
    await close();
    base = await start();
    token = await login();
    const calendar = await (await api(`/api/admin/calendar?month=${date.slice(0, 7)}`, null, token)).json();
    const saved = calendar.slots.find(s => s.id === slot.id);
    assert.equal(saved.taken, 1);
    assert.equal(saved.registrations[0].companyName, "公司測試 🐱");
    const persisted = await api(`/api/admin/registrations/${registration.id}/receipt`, null, token);
    assert.deepEqual(Buffer.from(await persisted.arrayBuffer()), png);
  } finally { await close(); }
});
