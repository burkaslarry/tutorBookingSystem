const AUTH_KEY = "tutor_auth_session";
const SCREEN_COPY = {
  register: ["學生登記", "選擇課程時段，先以轉數快付款並上載收據。"],
  login: ["後台登入", "管理員可建立課程、時段，並查看日曆與收據。"],
  calendar: ["預約日曆", "查看每個時段的名額、學生與轉數快收據。"],
  courses: ["課程", "建立學生可以預約的課程。"],
  slots: ["時段", "為課程設定上課日期、時間與名額。"],
};

const pageTitle = document.querySelector("#page-title");
const pageSubtitle = document.querySelector("#page-subtitle");
const flash = document.querySelector("#flash");
const registerForm = document.querySelector("#register-form");
const courseSelect = document.querySelector("#course-select");
const slotSelect = document.querySelector("#slot-select");
const slotPrice = document.querySelector("#slot-price");
const receiptInput = document.querySelector("#receipt-input");
const receiptPreview = document.querySelector("#receipt-preview");
const receiptError = document.querySelector("#receipt-error");
const suggestionBox = document.querySelector("#suggestion-box");
const suggestionList = document.querySelector("#suggestion-list");
const registerSuccess = document.querySelector("#register-success");
const fpsInstructions = document.querySelector("#fps-instructions");
const kpayNote = document.querySelector("#kpay-note");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const loginHelp = document.querySelector("#login-help");
const sessionLabel = document.querySelector("#session-label");
const calendarGrid = document.querySelector("#calendar-grid");
const calendarCaption = document.querySelector("#calendar-caption");
const dayDetail = document.querySelector("#day-detail");
const courseForm = document.querySelector("#course-form");
const courseList = document.querySelector("#course-list");
const slotForm = document.querySelector("#slot-form");
const slotCourse = document.querySelector("#slot-course");

let catalog = { courses: [], slots: [] };
let calendarMonth = hongKongMonth();
let selectedDate = hongKongDate();
let previewUrl = "";
const receiptUrls = [];

document.querySelector("#login-help-open").addEventListener("click", () => {
  loginHelp.hidden = false;
});
document.querySelector("#login-help-close").addEventListener("click", closeLoginHelp);
document.querySelector("#login-help-dismiss").addEventListener("click", closeLoginHelp);
loginHelp.addEventListener("click", (event) => {
  if (event.target === loginHelp) closeLoginHelp();
});

document.body.addEventListener("click", (event) => {
  const button = event.target.closest("[data-go]");
  if (!button) return;
  if (button.dataset.go === "logout") {
    logout();
    return;
  }
  location.hash = button.dataset.go;
});

window.addEventListener("hashchange", route);
registerForm.addEventListener("submit", submitRegistration);
registerForm.elements.paymentMethod.forEach((input) => input.addEventListener("change", syncPayment));
courseSelect.addEventListener("change", () => fillSlots(courseSelect.value));
slotSelect.addEventListener("change", showPrice);
receiptInput.addEventListener("change", previewReceipt);
loginForm.addEventListener("submit", submitLogin);
courseForm.addEventListener("submit", submitCourse);
slotForm.addEventListener("submit", submitSlot);
document.querySelector("#month-prev").addEventListener("click", () => changeMonth(-1));
document.querySelector("#month-next").addEventListener("click", () => changeMonth(1));
suggestionList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-slot-id]");
  if (!button) return;
  courseSelect.value = button.dataset.courseId;
  fillSlots(button.dataset.courseId, button.dataset.slotId);
  setFlash("已改選尚有空位的時段，請再按確認登記。");
});

init();

async function init() {
  syncPayment();
  await loadCatalog();
  const params = new URLSearchParams(location.search);
  if (params.get("payment") === "return" && params.get("registration")) {
    await showPaymentReturn(params.get("registration"));
  }
  if (getSession()) await refreshSession();
  if (!location.hash) location.hash = "register";
  route();
}

function closeLoginHelp() {
  loginHelp.hidden = true;
}

function getSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AUTH_KEY) || "");
    if (!parsed?.token || !parsed.username) return null;
    return parsed;
  } catch {
    return null;
  }
}

function setSession(session) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(AUTH_KEY);
}

async function refreshSession() {
  try {
    const data = await api("/api/auth/me", { auth: true });
    setSession({ token: data.token, username: data.username, role: data.role });
    return true;
  } catch {
    clearSession();
    return false;
  }
}

function route() {
  const requested = (location.hash || "#register").slice(1);
  const screen = ["register", "login", "calendar", "courses", "slots"].includes(requested) ? requested : "register";
  const session = getSession();
  if (["calendar", "courses", "slots"].includes(screen) && !session) {
    location.hash = "login";
    return;
  }
  if (screen === "login" && session) {
    location.hash = "calendar";
    return;
  }
  document.querySelectorAll("[data-screen]").forEach((section) => {
    section.hidden = section.dataset.screen !== screen;
  });
  const [title, subtitle] = SCREEN_COPY[screen];
  pageTitle.textContent = title;
  pageSubtitle.textContent = subtitle;
  document.querySelectorAll("[data-go]").forEach((button) => {
    if (button.dataset.go === screen) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  paintSession();
  if (screen === "calendar") loadCalendar();
  if (screen === "courses" || screen === "slots") loadAdminCourses();
}

function paintSession() {
  const session = getSession();
  document.querySelectorAll("[data-admin-nav]").forEach((item) => {
    item.hidden = !session;
  });
  document.querySelector("#login-nav").hidden = Boolean(session);
  document.querySelector("#logout-nav").hidden = !session;
  document.querySelector("#mobile-login").hidden = Boolean(session);
  if (session) {
    sessionLabel.hidden = false;
    sessionLabel.textContent = `已登入 ${session.username}`;
  } else {
    sessionLabel.hidden = true;
  }
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST", auth: true });
  } catch {
    // Local session is cleared either way.
  }
  clearSession();
  location.hash = "login";
}

async function loadCatalog() {
  try {
    catalog = await api("/api/public/catalog");
    const config = await api("/api/public/config");
    const notes = ["請先以轉數快（FPS）付款，再上載 .png 或 .jpeg 收據。"];
    if (config.fpsPayeeName) notes.push(`收款人：${config.fpsPayeeName}`);
    if (config.fpsIdentifier) notes.push(`轉數快識別碼：${config.fpsIdentifier}`);
    fpsInstructions.textContent = notes.join(" ");
    kpayNote.textContent = config.kpayReady
      ? "選擇 KPay 後會前往付款頁完成付款。"
      : "KPay 尚未啟用。請使用轉數快上載收據，或於環境變數設定商戶資料後再開通。";
  } catch (error) {
    setFlash(error.message);
    catalog = { courses: [], slots: [] };
  }
  fillCourses();
}

function fillCourses() {
  courseSelect.replaceChildren();
  if (catalog.courses.length === 0) {
    courseSelect.append(option("", "管理員尚未開放課程"));
    slotSelect.replaceChildren(option("", "沒有可預約時段"));
    return;
  }
  courseSelect.append(option("", "選擇課程"));
  for (const course of catalog.courses) courseSelect.append(option(course.id, course.name));
  fillSlots(courseSelect.value);
}

function fillSlots(courseId, selectedId = "") {
  const slots = catalog.slots.filter((slot) => slot.courseId === courseId);
  slotSelect.replaceChildren();
  if (!courseId) {
    slotSelect.append(option("", "請先選擇課程"));
    showPrice();
    return;
  }
  if (slots.length === 0) {
    slotSelect.append(option("", "此課程沒有時段"));
    showPrice();
    return;
  }
  slotSelect.append(option("", "選擇時段"));
  for (const slot of slots) {
    const seats = slot.seatsLeft > 0 ? `餘 ${slot.seatsLeft} 位` : "已滿";
    const choice = option(slot.id, `${dateLabel(slot.date)} ${slot.startTime}–${slot.endTime} · ${seats}`);
    slotSelect.append(choice);
  }
  if (selectedId) slotSelect.value = selectedId;
  showPrice();
}

function showPrice() {
  const slot = catalog.slots.find((item) => item.id === slotSelect.value);
  slotPrice.textContent = slot ? `學費 ${hkd(slot.priceCents)}` : "請選擇時段以查看學費。";
}

function syncPayment() {
  const fps = registerForm.elements.paymentMethod.value === "fps";
  receiptInput.required = fps;
  document.querySelector(".upload-panel").classList.toggle("is-optional", !fps);
}

function previewReceipt() {
  receiptError.hidden = true;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = "";
  receiptPreview.hidden = true;
  const file = receiptInput.files?.[0];
  if (!file) return;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["png", "jpg", "jpeg"].includes(extension) || file.size > 5 * 1024 * 1024) {
    receiptInput.value = "";
    receiptError.hidden = false;
    receiptError.textContent = "收據只接受 5MB 以內的 .png 或 .jpeg。";
    return;
  }
  previewUrl = URL.createObjectURL(file);
  receiptPreview.src = previewUrl;
  receiptPreview.hidden = false;
}

async function submitRegistration(event) {
  event.preventDefault();
  suggestionBox.hidden = true;
  suggestionList.replaceChildren();
  registerSuccess.hidden = true;
  if (!registerForm.reportValidity()) return;
  const paymentMethod = registerForm.elements.paymentMethod.value;
  const registrationBody = paymentMethod === "kpay"
    ? JSON.stringify({
      studentName: registerForm.elements.studentName.value.trim(),
      phone: registerForm.elements.phone.value.trim(),
      email: registerForm.elements.email.value.trim(),
      slotId: slotSelect.value,
      paymentMethod: "kpay",
    })
    : new FormData(registerForm);
  setBusy(registerForm, true);
  try {
    const data = await api("/api/registrations", { method: "POST", body: registrationBody });
    if (data.checkoutUrl) {
      window.location.assign(data.checkoutUrl);
      return;
    }
    const registration = data.registration;
    registerSuccess.hidden = false;
    registerSuccess.textContent = `已確認 ${registration.studentName} 的 ${registration.courseName}（${dateLabel(registration.date)} ${registration.startTime}）。請準時出席。`;
    registerForm.reset();
    registerForm.elements.paymentMethod.value = "fps";
    syncPayment();
    clearPreview();
    await loadCatalog();
    setFlash("");
  } catch (error) {
    if (error.payload?.full) showSuggestions(error.payload.suggestions || []);
    setFlash(error.message);
  } finally {
    setBusy(registerForm, false);
  }
}

function showSuggestions(suggestions) {
  suggestionBox.hidden = false;
  suggestionList.replaceChildren();
  if (suggestions.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "暫時沒有其他空位。";
    suggestionList.append(empty);
    return;
  }
  for (const suggestion of suggestions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "export-button";
    button.dataset.slotId = suggestion.slotId;
    button.dataset.courseId = suggestion.courseId;
    button.textContent = `${suggestion.courseName} · ${dateLabel(suggestion.date)} ${suggestion.startTime}–${suggestion.endTime} · 餘 ${suggestion.seatsLeft} 位`;
    suggestionList.append(button);
  }
}

async function showPaymentReturn(id) {
  try {
    const data = await api(`/api/public/registrations/${encodeURIComponent(id)}`);
    const registration = data.registration;
    const paid = registration.paymentStatus === "paid" || registration.paymentStatus === "received";
    registerSuccess.hidden = false;
    registerSuccess.textContent = paid
      ? `${registration.courseName} 付款已確認。請於 ${dateLabel(registration.date)} ${registration.startTime} 出席。`
      : "付款尚未完成。若你已離開 KPay 頁面，請再試一次或改用轉數快。";
  } catch (error) {
    setFlash(error.message);
  }
}

async function submitLogin(event) {
  event.preventDefault();
  loginError.hidden = true;
  setBusy(loginForm, true);
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: loginForm.elements.username.value.trim(),
        password: loginForm.elements.password.value,
      }),
    });
    setSession({ token: data.token, username: data.username, role: data.role });
    location.hash = "calendar";
  } catch (error) {
    loginError.hidden = false;
    loginError.textContent = error.message;
  } finally {
    setBusy(loginForm, false);
  }
}

async function submitCourse(event) {
  event.preventDefault();
  if (!courseForm.reportValidity()) return;
  setBusy(courseForm, true);
  try {
    const data = await api("/api/admin/courses", {
      method: "POST",
      auth: true,
      body: JSON.stringify({
        name: courseForm.elements.name.value.trim(),
        description: courseForm.elements.description.value.trim(),
        priceHkd: Number(courseForm.elements.priceHkd.value),
      }),
    });
    courseForm.reset();
    setFlash(`已建立課程「${data.course.name}」。`);
    await loadAdminCourses();
    await loadCatalog();
  } catch (error) {
    setFlash(error.message);
  } finally {
    setBusy(courseForm, false);
  }
}

async function submitSlot(event) {
  event.preventDefault();
  if (!slotForm.reportValidity()) return;
  setBusy(slotForm, true);
  try {
    const data = await api("/api/admin/slots", {
      method: "POST",
      auth: true,
      body: JSON.stringify({
        courseId: slotForm.elements.courseId.value,
        date: slotForm.elements.date.value,
        startTime: slotForm.elements.startTime.value,
        endTime: slotForm.elements.endTime.value,
        capacity: Number(slotForm.elements.capacity.value),
      }),
    });
    setFlash(`已建立 ${data.slot.date} ${data.slot.startTime} 的時段。`);
    calendarMonth = data.slot.date.slice(0, 7);
    selectedDate = data.slot.date;
    await loadCatalog();
    location.hash = "calendar";
  } catch (error) {
    setFlash(error.message);
  } finally {
    setBusy(slotForm, false);
  }
}

async function loadAdminCourses() {
  if (!getSession()) return;
  try {
    const data = await api("/api/admin/courses", { auth: true });
    courseList.replaceChildren();
    slotCourse.replaceChildren(option("", "選擇課程"));
    if (data.courses.length === 0) {
      courseList.append(emptyState("尚未建立課程", "在左方表格新增第一個課程。"));
    }
    for (const course of data.courses) {
      const row = document.createElement("article");
      row.className = "booking-row";
      const name = document.createElement("p");
      name.className = "student-name";
      name.textContent = course.name;
      const meta = document.createElement("p");
      meta.className = "course-name";
      meta.textContent = `${hkd(course.priceCents)}${course.description ? ` · ${course.description}` : ""}`;
      row.append(name, meta);
      courseList.append(row);
      slotCourse.append(option(course.id, course.name));
    }
  } catch (error) {
    setFlash(error.message);
  }
}

async function loadCalendar() {
  if (!getSession()) return;
  try {
    const data = await api(`/api/admin/calendar?month=${calendarMonth}`, { auth: true });
    calendarCaption.textContent = monthLabel(calendarMonth);
    renderCalendar(data.month, data.slots);
    renderDay(data.slots);
  } catch (error) {
    setFlash(error.message);
  }
}

function renderCalendar(month, slots) {
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const pad = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  calendarGrid.replaceChildren();
  for (let index = 0; index < pad; index += 1) calendarGrid.append(cell("", true));
  for (let day = 1; day <= days; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const button = cell(String(day), false);
    button.dataset.date = date;
    if (date === selectedDate) button.classList.add("is-selected");
    const daySlots = slots.filter((slot) => slot.date === date);
    for (const slot of daySlots.slice(0, 3)) {
      const pill = document.createElement("span");
      pill.className = `slot-pill${slot.seatsLeft === 0 ? " is-full" : ""}`;
      pill.textContent = `${slot.startTime} ${slot.courseName} ${slot.taken}/${slot.capacity}`;
      button.append(pill);
    }
    if (daySlots.length > 3) {
      const more = document.createElement("span");
      more.className = "slot-pill";
      more.textContent = `+${daySlots.length - 3}`;
      button.append(more);
    }
    button.addEventListener("click", () => {
      selectedDate = date;
      loadCalendar();
    });
    calendarGrid.append(button);
  }
}

function renderDay(slots) {
  revokeReceiptUrls();
  const daySlots = slots.filter((slot) => slot.date === selectedDate);
  dayDetail.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = dateLabel(selectedDate);
  dayDetail.append(heading);
  if (daySlots.length === 0) {
    dayDetail.append(emptyState("這天沒有時段", "到「時段」頁新增上課時間。"));
    return;
  }
  for (const slot of daySlots) {
    const block = document.createElement("article");
    block.className = "day-slot";
    const title = document.createElement("p");
    title.className = "student-name";
    title.textContent = `${slot.startTime}–${slot.endTime} ${slot.courseName}`;
    const meta = document.createElement("p");
    meta.className = "course-name";
    meta.textContent = `${slot.taken}/${slot.capacity} 已預約 · 餘 ${slot.seatsLeft} 位 · ${hkd(slot.priceCents)}`;
    block.append(title, meta);
    if (slot.registrations.length === 0) {
      const empty = document.createElement("p");
      empty.className = "field-note";
      empty.textContent = "這個時段還沒有學生。";
      block.append(empty);
    }
    for (const registration of slot.registrations) {
      block.append(registrationRow(registration));
    }
    dayDetail.append(block);
  }
}

function registrationRow(registration) {
  const row = document.createElement("article");
  row.className = "booking-row";
  const who = document.createElement("div");
  const name = document.createElement("p");
  name.className = "student-name";
  name.textContent = registration.studentName;
  const contact = document.createElement("p");
  contact.className = "student-phone";
  contact.textContent = `${registration.phone} · ${registration.email}`;
  who.append(name, contact);
  const pay = document.createElement("div");
  const status = document.createElement("span");
  status.className = "status-pill status-pending";
  status.textContent = paymentLabel(registration);
  pay.append(status);
  row.append(who, pay);
  if (registration.hasReceipt) {
    const frame = document.createElement("div");
    frame.className = "receipt-frame";
    const image = document.createElement("img");
    image.alt = `${registration.studentName} 的轉數快收據`;
    image.className = "receipt-preview";
    frame.append(image);
    row.append(frame);
    loadReceipt(registration.id, image);
  }
  return row;
}

async function loadReceipt(id, image) {
  const session = getSession();
  if (!session) return;
  try {
    const response = await fetch(`/api/admin/registrations/${encodeURIComponent(id)}/receipt`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!response.ok) return;
    const url = URL.createObjectURL(await response.blob());
    receiptUrls.push(url);
    image.src = url;
  } catch (error) {
    console.error(error);
  }
}

function paymentLabel(registration) {
  const labels = {
    received: "已收到轉數快收據",
    paid: "KPay 已付款",
    pending: "KPay 待付款",
    failed: "付款失敗",
  };
  return labels[registration.paymentStatus] || registration.paymentStatus;
}

function changeMonth(delta) {
  const [year, monthNumber] = calendarMonth.split("-").map(Number);
  const next = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  calendarMonth = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
  selectedDate = `${calendarMonth}-01`;
  loadCalendar();
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (options.auth && getSession()?.token) headers.Authorization = `Bearer ${getSession().token}`;
  const response = await fetch(path, { method: options.method || "GET", headers, body: options.body });
  const isJson = (response.headers.get("content-type") || "").includes("json");
  const data = isJson ? await response.json() : {};
  if (response.status === 401 && options.auth) {
    clearSession();
    location.hash = "login";
  }
  if (!response.ok) {
    const error = new Error(data.error || "操作失敗，請再試一次。");
    error.payload = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

function setBusy(form, busy) {
  form.querySelectorAll("input, select, button, textarea").forEach((element) => {
    element.disabled = busy;
  });
  if (!busy) syncPayment();
}

function setFlash(message) {
  flash.hidden = !message;
  flash.textContent = message || "";
}

function option(value, label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

function cell(text, blank) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `calendar-cell${blank ? " is-blank" : ""}`;
  button.disabled = blank;
  if (text) {
    const day = document.createElement("span");
    day.className = "calendar-day";
    day.textContent = text;
    button.append(day);
  }
  return button;
}

function emptyState(title, message) {
  const container = document.createElement("div");
  container.className = "empty-state";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = message;
  container.append(heading, copy);
  return container;
}

function clearPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = "";
  receiptPreview.hidden = true;
  receiptPreview.removeAttribute("src");
}

function revokeReceiptUrls() {
  for (const url of receiptUrls) URL.revokeObjectURL(url);
  receiptUrls.length = 0;
}

function hkd(cents) {
  return `HK$${(Number(cents) / 100).toFixed(2)}`;
}

function dateLabel(value) {
  return new Intl.DateTimeFormat("zh-HK", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${value}T12:00:00+08:00`));
}

function monthLabel(month) {
  const [year, monthNumber] = month.split("-");
  return `${year}年${Number(monthNumber)}月`;
}

function hongKongDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const bag = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${bag.year}-${bag.month}-${bag.day}`;
}

function hongKongMonth() {
  return hongKongDate().slice(0, 7);
}
