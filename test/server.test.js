const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { once } = require("node:events");
const { startServer } = require("../server");

const temporaryDirectory = mkdtempSync(join(tmpdir(), "tutor-bookings-"));
const { server } = startServer({ databasePath: join(temporaryDirectory, "test.db"), port: 0 });

after(() => new Promise((resolve) => server.close(resolve)));

async function baseUrl() {
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("serves the booking app", async () => {
  const response = await fetch(`${await baseUrl()}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /AI 課程預約及簽到/);
});

test("creates, lists, and updates a booking", async () => {
  const url = await baseUrl();
  const booking = {
    id: "booking-1",
    student: "陳小明",
    phone: "9123 4567",
    course: "人工智能入門",
    date: "2026-10-01",
    time: "15:30",
    status: "pending",
  };

  const createResponse = await fetch(`${url}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(booking),
  });
  assert.equal(createResponse.status, 201);

  const listResponse = await fetch(`${url}/api/bookings`);
  assert.deepEqual((await listResponse.json()).bookings, [booking]);

  const updateResponse = await fetch(`${url}/api/bookings/booking-1/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "checked-in" }),
  });
  assert.equal(updateResponse.status, 200);

  const updatedBookings = (await (await fetch(`${url}/api/bookings`)).json()).bookings;
  assert.equal(updatedBookings[0].status, "checked-in");
});

test("rejects invalid bookings", async () => {
  const response = await fetch(`${await baseUrl()}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ student: "Incomplete" }),
  });
  assert.equal(response.status, 400);
});
