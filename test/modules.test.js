const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isReminderDue } = require("../lib/time");
const { kpayReadiness, createPaymentIntent, signBody } = require("../lib/kpay");
const { confirmationMessage, sendEmail } = require("../lib/email");

test("attendance reminder is due only before the session", () => {
  const now = new Date("2026-10-08T02:00:00.000Z");
  assert.equal(isReminderDue({ date: "2026-10-08", startTime: "15:00", now, leadHours: 24 }), true);
  assert.equal(isReminderDue({ date: "2026-10-20", startTime: "15:00", now, leadHours: 24 }), false);
  assert.equal(isReminderDue({ date: "2026-10-08", startTime: "09:00", now, leadHours: 24 }), false);
});

test("kpay stays off until merchant settings are present", () => {
  assert.deepEqual(kpayReadiness({ enabled: false }).reason, "disabled");
  const missing = kpayReadiness({
    enabled: true,
    apiBase: "",
    merchantId: "",
    appId: "app",
    apiSecret: "secret",
    webhookSecret: "",
  });
  assert.equal(missing.reason, "missing_credentials");
  assert.deepEqual(missing.missing, ["KPAY_API_BASE", "KPAY_MERCHANT_ID", "KPAY_WEBHOOK_SECRET"]);
});

test("kpay signs the payment intent and reads the hosted checkout url", async () => {
  let seen;
  const result = await createPaymentIntent({
    config: {
      enabled: true,
      apiBase: "https://merchant.example.test",
      createPath: "/v1/payment_intents",
      merchantId: "m1",
      appId: "a1",
      apiSecret: "top-secret",
      webhookSecret: "hook",
      currency: "HKD",
    },
    order: {
      amountCents: 1200,
      registrationId: "reg-1",
      description: "人工智能入門",
      returnUrl: "https://booking.example.test/return",
      notifyUrl: "https://booking.example.test/hook",
      studentName: "陳小明",
      slotId: "slot-1",
      courseName: "人工智能入門",
    },
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return new Response(JSON.stringify({
        id: "pi_1",
        checkout_url: "https://pay.kpay-group.com/checkout/pi_1",
      }), { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(seen.url, "https://merchant.example.test/v1/payment_intents");
  assert.equal(seen.options.headers["X-KPay-Signature"], signBody("top-secret", seen.options.body));
  assert.equal(JSON.parse(seen.options.body).metadata.student_name, "陳小明");
});

test("resend confirmation is skipped without a key and posts when configured", async () => {
  const message = confirmationMessage({
    studentName: "陳小明",
    courseName: "人工智能入門",
    dateLabel: "2026年10月8日",
    timeLabel: "15:00",
  });
  assert.match(message.text, /請準時出席/);
  const skipped = await sendEmail({ env: {}, fetchImpl: async () => { throw new Error("should not send"); }, to: "ming@example.com", ...message });
  assert.equal(skipped.status, "skipped");

  let posted;
  const sent = await sendEmail({
    env: { RESEND_API_KEY: "re_test", RESEND_FROM: "AI <book@example.com>" },
    to: "ming@example.com",
    ...message,
    fetchImpl: async (url, options) => {
      posted = { url, options };
      return new Response(JSON.stringify({ id: "email_9" }), { status: 200 });
    },
  });
  assert.equal(sent.status, "sent");
  assert.equal(posted.url, "https://api.resend.com/emails");
  assert.equal(posted.options.headers.Authorization, "Bearer re_test");
});
