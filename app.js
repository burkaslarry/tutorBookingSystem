const LEGACY_STORAGE_KEY = "ai-learning-center-bookings";
const bookingDateInput = document.querySelector("#booking-date");
const statusFilter = document.querySelector("#status-filter");
const bookingList = document.querySelector("#booking-list");
const form = document.querySelector("#booking-form");
const exportCalendarButton = document.querySelector("#export-calendar");
const mobileTabs = document.querySelector(".mobile-tabs");
const warning = document.querySelector("#storage-warning");
const today = new Date();
const localToday = formatDate(today);
let bookings = [];

bookingDateInput.value = localToday;
form.elements.date.value = localToday;
form.elements.date.min = localToday;
render();
activateMobileTab("dashboard");
loadBookings();

bookingDateInput.addEventListener("change", () => {
  render();
});

statusFilter.addEventListener("change", () => {
  render();
});

exportCalendarButton.addEventListener("click", exportCalendar);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const formData = new FormData(form);
  const booking = {
    id: makeId(),
    student: String(formData.get("student")).trim(),
    phone: String(formData.get("phone")).trim(),
    course: String(formData.get("course")),
    date: String(formData.get("date")),
    time: String(formData.get("time")),
    status: "pending",
  };

  if (!booking.student || !booking.phone) {
    form.reportValidity();
    return;
  }

  setFormBusy(true);
  try {
    await apiRequest("/api/bookings", {
      method: "POST",
      body: JSON.stringify(booking),
    });
    bookings.push(booking);
  } catch (error) {
    showStorageError(error.message, error);
    setFormBusy(false);
    return;
  }

  bookingDateInput.value = booking.date;
  statusFilter.value = "all";
  form.reset();
  form.elements.date.value = localToday;
  form.elements.date.min = localToday;
  activateMobileTab("bookings");
  setFormBusy(false);
  render();
});

mobileTabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-tab]");
  if (button) activateMobileTab(button.dataset.tab);
});

bookingList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const booking = bookings.find((item) => item.id === button.dataset.id);
  if (!booking) return;

  const previousStatus = booking.status;
  if (button.dataset.action === "check-in") {
    booking.status = "checked-in";
  } else if (button.dataset.action === "cancel") {
    booking.status = "cancelled";
  } else if (button.dataset.action === "restore") {
    booking.status = "pending";
  } else {
    return;
  }

  button.disabled = true;
  try {
    await apiRequest(`/api/bookings/${encodeURIComponent(booking.id)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: booking.status }),
    });
  } catch (error) {
    booking.status = previousStatus;
    button.disabled = false;
    showStorageError(error.message, error);
    return;
  }
  render();
});

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function makeId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function activateMobileTab(tab) {
  document.body.dataset.activeTab = tab;
  mobileTabs.querySelectorAll("button[data-tab]").forEach((button) => {
    if (button.dataset.tab === tab) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
}

async function loadBookings() {
  try {
    const data = await apiRequest("/api/bookings");
    bookings = Array.isArray(data.bookings) ? data.bookings.filter(isBooking) : [];
    if (bookings.length === 0) await migrateLegacyBookings();
    warning.hidden = true;
    render();
  } catch (error) {
    showStorageError("無法連接預約資料庫。請以 npm start 啟動系統後再試。", error);
  }
}

function isBooking(value) {
  return value
    && typeof value.id === "string"
    && typeof value.student === "string"
    && typeof value.phone === "string"
    && typeof value.course === "string"
    && typeof value.date === "string"
    && typeof value.time === "string"
    && ["pending", "checked-in", "cancelled"].includes(value.status);
}

async function migrateLegacyBookings() {
  try {
    const stored = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!stored) return;
    const legacyBookings = JSON.parse(stored).filter(isBooking);
    for (const booking of legacyBookings) {
      await apiRequest("/api/bookings", { method: "POST", body: JSON.stringify(booking) });
    }
    bookings = legacyBookings;
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (error) {
    console.error("無法搬移舊有瀏覽器預約資料。", error);
  }
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "資料庫操作失敗，請再試一次。");
  return data;
}

function setFormBusy(busy) {
  form.querySelectorAll("input, select, button").forEach((element) => {
    element.disabled = busy;
  });
}

function showStorageError(message, error) {
  warning.textContent = message;
  warning.hidden = false;
  console.error(message, error);
}

function render() {
  const selectedDate = bookingDateInput.value || localToday;
  const selectedBookings = bookings
    .filter((booking) => booking.date === selectedDate)
    .sort((a, b) => a.time.localeCompare(b.time));
  const visibleBookings = selectedBookings.filter((booking) => (
    statusFilter.value === "all" || booking.status === statusFilter.value
  ));
  const pendingCount = selectedBookings.filter((booking) => booking.status === "pending").length;
  const checkedInCount = selectedBookings.filter((booking) => booking.status === "checked-in").length;

  document.querySelector("#total-count").textContent = String(selectedBookings.length);
  document.querySelector("#waiting-count").textContent = String(pendingCount);
  document.querySelector("#checked-in-count").textContent = String(checkedInCount);
  document.querySelector("#list-date-label").textContent = formatDateLabel(selectedDate);
  exportCalendarButton.disabled = !bookings.some((booking) => booking.status !== "cancelled");
  bookingList.replaceChildren();

  if (visibleBookings.length === 0) {
    bookingList.append(createEmptyState(selectedBookings.length > 0));
    return;
  }

  for (const booking of visibleBookings) {
    bookingList.append(createBookingRow(booking));
  }
}

function exportCalendar() {
  const activeBookings = bookings
    .filter((booking) => booking.status !== "cancelled")
    .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
  if (activeBookings.length === 0) return;

  const calendarLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AI Learning Center//Booking Calendar//ZH-HK",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:AI 學習中心課堂",
  ];

  for (const booking of activeBookings) {
    const start = new Date(`${booking.date}T${booking.time}:00`);
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + 60);
    calendarLines.push(
      "BEGIN:VEVENT",
      `UID:${escapeICalText(booking.id)}@ai-learning-center.local`,
      `DTSTAMP:${toICalUtc(new Date())}`,
      `DTSTART:${toICalUtc(start)}`,
      `DTEND:${toICalUtc(end)}`,
      `SUMMARY:${escapeICalText(`${booking.course} - ${booking.student}`)}`,
      `DESCRIPTION:${escapeICalText(`課程：${booking.course}\n學生：${booking.student}`)}`,
      "STATUS:CONFIRMED",
      "END:VEVENT",
    );
  }
  calendarLines.push("END:VCALENDAR");

  const file = new Blob(
    [calendarLines.map(foldICalLine).join("\r\n") + "\r\n"],
    { type: "text/calendar;charset=utf-8" },
  );
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = "ai-learning-center-bookings.ics";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeICalText(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/([,;])/g, "\\$1");
}

function toICalUtc(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function foldICalLine(line) {
  const chunks = [];
  let chunk = "";
  let bytes = 0;
  const encoder = new TextEncoder();

  for (const character of line) {
    const characterBytes = encoder.encode(character).length;
    if (bytes + characterBytes > 75) {
      chunks.push(chunk);
      chunk = ` ${character}`;
      bytes = characterBytes + 1;
    } else {
      chunk += character;
      bytes += characterBytes;
    }
  }

  chunks.push(chunk);
  return chunks.join("\r\n");
}

function formatDateLabel(value) {
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat("zh-HK", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

function createEmptyState(filteredOut) {
  const container = document.createElement("div");
  container.className = "empty-state";

  const icon = document.createElement("span");
  icon.className = "empty-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = filteredOut ? "⌕" : "▤";

  const heading = document.createElement("strong");
  heading.textContent = filteredOut ? "沒有符合狀態的預約" : "這天還沒有預約";

  const message = document.createElement("p");
  message.textContent = filteredOut
    ? "請更改狀態篩選條件。"
    : "使用右方表格新增學生課堂預約。";

  container.append(icon, heading, message);
  return container;
}

function createBookingRow(booking) {
  const row = document.createElement("article");
  row.className = "booking-row";

  const studentInfo = document.createElement("div");
  const studentName = document.createElement("p");
  studentName.className = "student-name";
  studentName.textContent = booking.student;
  const studentPhone = document.createElement("p");
  studentPhone.className = "student-phone";
  studentPhone.textContent = booking.phone;
  studentInfo.append(studentName, studentPhone);

  const classInfo = document.createElement("div");
  const time = document.createElement("p");
  time.className = "booking-time";
  time.textContent = booking.time;
  const course = document.createElement("p");
  course.className = "course-name";
  course.textContent = booking.course;
  const status = document.createElement("span");
  status.className = `status-pill status-${booking.status}`;
  status.textContent = statusLabel(booking.status);
  classInfo.append(time, course, status);

  const actions = document.createElement("div");
  actions.className = "row-actions";
  if (booking.status === "pending") {
    actions.append(createActionButton(booking, "check-in", "簽到", "action-check-in"));
    actions.append(createActionButton(booking, "cancel", "取消"));
  } else if (booking.status === "cancelled") {
    actions.append(createActionButton(booking, "restore", "還原預約"));
  }

  row.append(studentInfo, classInfo, actions);
  return row;
}

function createActionButton(booking, action, label, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `action-button ${className}`.trim();
  button.dataset.action = action;
  button.dataset.id = booking.id;
  button.textContent = label;
  return button;
}

function statusLabel(status) {
  return {
    pending: "待簽到",
    "checked-in": "已簽到",
    cancelled: "已取消",
  }[status];
}
