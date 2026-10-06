function hongKongParts(date = new Date()) {
  const bag = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  const hour = bag.hour === "24" ? "00" : bag.hour;
  return {
    date: `${bag.year}-${bag.month}-${bag.day}`,
    time: `${hour}:${bag.minute}`,
    month: `${bag.year}-${bag.month}`,
  };
}

function slotStart(date, time) {
  return new Date(`${date}T${time}:00+08:00`);
}

function isBookable(date, time, now) {
  const start = slotStart(date, time);
  return !Number.isNaN(start.getTime()) && start.getTime() > now.getTime();
}

function isReminderDue({ date, startTime, now, leadHours }) {
  const start = slotStart(date, startTime);
  if (Number.isNaN(start.getTime())) return false;
  const remindAt = start.getTime() - leadHours * 60 * 60 * 1000;
  return now.getTime() >= remindAt && now.getTime() < start.getTime();
}

function formatSlotWhen(date, time) {
  const start = slotStart(date, time);
  return {
    dateLabel: new Intl.DateTimeFormat("zh-HK", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    }).format(start),
    timeLabel: time,
  };
}

function monthRange(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month || "");
  if (!match) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) return null;
  const start = `${match[1]}-${match[2]}-01`;
  const next = monthNumber === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(monthNumber + 1).padStart(2, "0")}-01`;
  return { start, next };
}

module.exports = {
  hongKongParts,
  slotStart,
  isBookable,
  isReminderDue,
  formatSlotWhen,
  monthRange,
};
