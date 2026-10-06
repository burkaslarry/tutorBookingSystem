const RESEND_URL = "https://api.resend.com/emails";

function emailConfig(env) {
  return {
    apiKey: String(env.RESEND_API_KEY || "").trim(),
    from: String(env.RESEND_FROM || "").trim(),
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function confirmationMessage({ studentName, courseName, dateLabel, timeLabel }) {
  const subject = `已確認預約：${courseName} ${dateLabel} ${timeLabel}`;
  const text = [
    `${studentName} 你好，`,
    "",
    "你的課堂預約已確認。請準時出席。",
    `課程：${courseName}`,
    `日期：${dateLabel}`,
    `時間：${timeLabel}（香港時間）`,
    "",
    "AI 學習中心",
  ].join("\n");
  const html = `<p>${escapeHtml(studentName)} 你好，</p><p>你的課堂預約已確認。請準時出席。</p><ul><li>課程：${escapeHtml(courseName)}</li><li>日期：${escapeHtml(dateLabel)}</li><li>時間：${escapeHtml(timeLabel)}（香港時間）</li></ul><p>AI 學習中心</p>`;
  return { subject, text, html };
}

function reminderMessage({ studentName, courseName, dateLabel, timeLabel }) {
  const subject = `上課提醒：${courseName} 將於 ${dateLabel} ${timeLabel} 開始`;
  const text = [
    `${studentName} 你好，`,
    "",
    "提醒你準時出席以下課堂。",
    `課程：${courseName}`,
    `日期：${dateLabel}`,
    `時間：${timeLabel}（香港時間）`,
    "",
    "AI 學習中心",
  ].join("\n");
  const html = `<p>${escapeHtml(studentName)} 你好，</p><p>提醒你準時出席以下課堂。</p><ul><li>課程：${escapeHtml(courseName)}</li><li>日期：${escapeHtml(dateLabel)}</li><li>時間：${escapeHtml(timeLabel)}（香港時間）</li></ul><p>AI 學習中心</p>`;
  return { subject, text, html };
}

async function sendEmail({ env, fetchImpl, to, subject, text, html }) {
  const config = emailConfig(env);
  if (!config.apiKey) return { status: "skipped", reason: "missing_api_key" };
  if (!config.from) return { status: "skipped", reason: "missing_from" };
  const response = await fetchImpl(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.from,
      to: [to],
      subject,
      text,
      html,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { status: "failed", reason: payload.message || payload.error || `HTTP ${response.status}` };
  }
  return { status: "sent", id: payload.id || "" };
}

module.exports = {
  RESEND_URL,
  emailConfig,
  confirmationMessage,
  reminderMessage,
  sendEmail,
};
