const crypto = require("node:crypto");
const { timingSafeEqualText } = require("./auth");

const DEFAULT_CREATE_PATH = "/v1/payment_intents";

function kpayConfig(env) {
  return {
    enabled: env.KPAY_ENABLED === "1" || env.KPAY_ENABLED === "true",
    apiBase: String(env.KPAY_API_BASE || "").trim().replace(/\/$/, ""),
    createPath: String(env.KPAY_CREATE_PATH || DEFAULT_CREATE_PATH).trim() || DEFAULT_CREATE_PATH,
    merchantId: String(env.KPAY_MERCHANT_ID || "").trim(),
    appId: String(env.KPAY_APP_ID || "").trim(),
    apiSecret: String(env.KPAY_API_SECRET || "").trim(),
    webhookSecret: String(env.KPAY_WEBHOOK_SECRET || "").trim(),
    currency: String(env.KPAY_CURRENCY || "HKD").trim() || "HKD",
  };
}

function kpayReadiness(config) {
  if (!config.enabled) return { ready: false, reason: "disabled", missing: [] };
  const missing = [];
  if (!config.apiBase) missing.push("KPAY_API_BASE");
  if (!config.merchantId) missing.push("KPAY_MERCHANT_ID");
  if (!config.appId) missing.push("KPAY_APP_ID");
  if (!config.apiSecret) missing.push("KPAY_API_SECRET");
  if (!config.webhookSecret) missing.push("KPAY_WEBHOOK_SECRET");
  if (missing.length > 0) return { ready: false, reason: "missing_credentials", missing };
  return { ready: true, reason: null, missing: [] };
}

function signBody(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function checkoutUrlFrom(payload) {
  if (!payload || typeof payload !== "object") return "";
  return payload.checkout_url
    || payload.cashier_url
    || payload.hosted_url
    || payload.payment_url
    || payload.url
    || payload.next_action?.redirect?.url
    || payload.data?.checkout_url
    || payload.data?.cashier_url
    || payload.data?.url
    || "";
}

function intentIdFrom(payload) {
  if (!payload || typeof payload !== "object") return "";
  return payload.id || payload.payment_intent_id || payload.data?.id || "";
}

async function createPaymentIntent({ config, order, fetchImpl }) {
  const readiness = kpayReadiness(config);
  if (!readiness.ready) return { ok: false, ...readiness };
  const path = config.createPath.startsWith("/") ? config.createPath : `/${config.createPath}`;
  const body = JSON.stringify({
    amount: order.amountCents,
    currency: config.currency,
    merchant_order_id: order.registrationId,
    description: order.description,
    return_url: order.returnUrl,
    notify_url: order.notifyUrl,
    metadata: {
      student_name: order.studentName,
      slot_id: order.slotId,
      course_name: order.courseName,
    },
  });
  const response = await fetchImpl(`${config.apiBase}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-KPay-Merchant-Id": config.merchantId,
      "X-KPay-App-Id": config.appId,
      "X-KPay-Signature": signBody(config.apiSecret, body),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, reason: "gateway_error", status: response.status, payload };
  }
  const checkoutUrl = checkoutUrlFrom(payload);
  const intentId = intentIdFrom(payload);
  if (!checkoutUrl || !intentId) return { ok: false, reason: "incomplete_response", payload };
  return { ok: true, intentId, checkoutUrl, payload };
}

function verifyWebhook(config, rawBody, signature) {
  if (!config.webhookSecret || !signature) return false;
  return timingSafeEqualText(signBody(config.webhookSecret, rawBody), String(signature).trim());
}

function webhookOutcome(payload) {
  const eventName = String(payload?.event || payload?.type || "").toLowerCase();
  const status = String(payload?.data?.status || payload?.status || "").toLowerCase();
  if (eventName.includes("succeed") || ["succeeded", "paid", "success", "completed"].includes(status)) return "paid";
  if (eventName.includes("fail") || eventName.includes("cancel") || ["failed", "canceled", "cancelled", "expired"].includes(status)) {
    return "failed";
  }
  return "ignore";
}

module.exports = {
  DEFAULT_CREATE_PATH,
  kpayConfig,
  kpayReadiness,
  signBody,
  createPaymentIntent,
  verifyWebhook,
  webhookOutcome,
};
