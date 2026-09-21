const SERVICE_UUID = "5f524c4e-0001-4a5b-9c1e-6f2b1a8d3c00";
const STATUS_UUID  = "5f524c4e-0002-4a5b-9c1e-6f2b1a8d3c00";
const CONTROL_UUID = "5f524c4e-0003-4a5b-9c1e-6f2b1a8d3c00";

const DEFAULT_NAMES = ["Stopkontak 1", "Stopkontak 2", "Stopkontak 3", "Master Power"];
const MODE_LABELS = {
  ALL_ON: "semua relay langsung ON",
  RESTORE_LAST: "kembalikan kondisi terakhir",
  STAY_OFF: "tetap OFF sampai dikontrol manual"
};

const MODE_KEYS = Object.keys(MODE_LABELS); // urutan = indeks `cm` dari firmware
const RELAY_COUNT = DEFAULT_NAMES.length;

/* Nama dari localStorage divalidasi dulu: satu nilai rusak dulunya
   membuat seluruh proses inisialisasi gagal. */
function loadNames() {
  const stored = loadJson("neoVoltNames", DEFAULT_NAMES);
  if (!Array.isArray(stored) || stored.length !== RELAY_COUNT) {
    return [...DEFAULT_NAMES];
  }
  return stored.map((value, i) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, 24) : DEFAULT_NAMES[i]
  );
}

function loadHistory() {
  const stored = loadJson("neoVoltHistory", []);
  return Array.isArray(stored)
    ? stored.filter(x => x && typeof x.message === "string" && Number.isFinite(x.time))
    : [];
}

const state = {
  connected: false,
  relays: Array(RELAY_COUNT).fill(false),
  timerEnds: Array(RELAY_COUNT).fill(0), // epoch ms saat timer habis; 0 = tidak aktif
  autoOffSec: 3,
  connectMode: "ALL_ON",
  singleUser: true,
  names: loadNames(),
  history: loadHistory(),
  user: null,        // { name, since } — diisi saat login
  deviceName: "—"
};

let device = null;
let statusCharacteristic = null;
let controlCharacteristic = null;
let toastTimer = null;
let disconnectUiTimer = null;
let disconnectUiInterval = null;
let disconnectHideTimer = null;
let pendingLogin = false;   // login menunggu BLE benar-benar tersambung
let connecting = false;     // requestDevice/GATT sedang berjalan (Web Bluetooth)
let settingsDirty = false;  // pilihan di tab Pengaturan belum disimpan
let commandChain = Promise.resolve(); // antrean tulis GATT (satu operasi per waktu)
const busyRelays = new Set();

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------
   Kartu relay, kartu timer dan input nama dibangun dari RELAY_COUNT
   supaya markup-nya tidak lagi di-copy-paste empat kali.
   ------------------------------------------------------------------ */
function buildRelayCards() {
  $("relayGrid").innerHTML = state.names.map((name, i) => {
    const n = i + 1;
    const isMaster = n === RELAY_COUNT;
    return `
      <article class="relay-card${isMaster ? " master" : ""}" data-relay="${n}">
        <div class="relay-head">
          <div>
            <span class="relay-number">Relay ${n}</span>
            <strong class="relay-name" id="relayName${n}">${escapeHtml(name)}</strong>
          </div>
          <button class="switch relay-toggle" data-relay="${n}"
                  aria-label="Ubah Relay ${n}" aria-pressed="false" disabled></button>
        </div>
        <span class="relay-state">Mati</span>
      </article>`;
  }).join("");
}

function buildTimerCards() {
  $("timerGrid").innerHTML = state.names.map((name, i) => {
    const n = i + 1;
    return `
      <article class="timer-card" data-timer-relay="${n}">
        <strong id="timerName${n}">${escapeHtml(name)}</strong>
        <small id="timerStatus${n}">Timer tidak aktif</small>
        <div class="timer-controls">
          <select id="timerPreset${n}" aria-label="Durasi timer Relay ${n}">
            <option value="600">10 menit</option>
            <option value="900" selected>15 menit</option>
            <option value="1800">30 menit</option>
            <option value="3600">1 jam</option>
            <option value="custom">Waktu khusus</option>
          </select>
          <input id="timerCustom${n}" type="number" min="1" max="1440" value="15" hidden
                 aria-label="Menit khusus Relay ${n}">
        </div>
        <div class="timer-actions">
          <button class="timer-btn start timer-start" data-relay="${n}" disabled>Mulai</button>
          <button class="timer-btn cancel timer-cancel" data-relay="${n}" disabled>Batalkan</button>
        </div>
      </article>`;
  }).join("");
}

function buildNameFields() {
  $("nameFields").innerHTML = state.names.map((name, i) => {
    const n = i + 1;
    return `
      <div class="field">
        <label for="nameInput${n}">Relay ${n}</label>
        <input id="nameInput${n}" maxlength="24" value="${escapeHtml(name)}">
      </div>`;
  }).join("");
}

buildRelayCards();
buildTimerCards();
buildNameFields();

const connectBtn = $("connectBtn");
const allOnBtn = $("allOnBtn");
const allOffBtn = $("allOffBtn");
const toggles = [...document.querySelectorAll(".relay-toggle")];
const timerStartButtons = [...document.querySelectorAll(".timer-start")];
const timerCancelButtons = [...document.querySelectorAll(".timer-cancel")];

const hasAndroidBridge = () => Boolean(window.AndroidBLE);
const hasWebBluetooth = () => Boolean(navigator.bluetooth);

// structuredClone tidak ada di WebView Android lama; kloning JSON cukup untuk data sederhana ini.
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : cloneJson(fallback);
  } catch {
    return cloneJson(fallback);
  }
}

// localStorage bisa melempar error (mode privat, kuota penuh, storage dimatikan).
// Kegagalan menyimpan tidak boleh merusak alur koneksi/kontrol.
function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeKey(key) {
  try { localStorage.removeItem(key); } catch {}
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2300);
}

function addHistory(message) {
  state.history.unshift({ time: Date.now(), message });
  state.history = state.history.slice(0, 60);
  saveJson("ecoWattHistory", state.history);
  renderHistory();
}

function formatHistoryTime(timestamp) {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString("id-ID", {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString("id-ID", { day: "2-digit", month: "short" })} ${time}`;
}

function renderHistory() {
  const list = $("historyList");
  list.innerHTML = "";

  if (!state.history.length) {
    const li = document.createElement("li");
    li.innerHTML = "<time>—</time><span>Belum ada aktivitas.</span>";
    list.appendChild(li);
    return;
  }

  for (const item of state.history) {
    const li = document.createElement("li");
    const time = formatHistoryTime(item.time);
    li.innerHTML = `<time>${escapeHtml(time)}</time><span>${escapeHtml(item.message)}</span>`;
    list.appendChild(li);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

function setControlsEnabled(enabled) {
  toggles.forEach(button => button.disabled = !enabled);
  timerStartButtons.forEach(button => button.disabled = !enabled);
  timerCancelButtons.forEach(button => button.disabled = !enabled);
  allOnBtn.disabled = !enabled;
  allOffBtn.disabled = !enabled;
  $("saveDeviceSettingsBtn").disabled = !enabled;
}

function setConnected(connected, deviceName = "ENNERA") {
  state.connected = connected;
  $("statusDot").classList.toggle("connected", connected);
  $("statusMini").textContent = connected ? "Terhubung" : "Terputus";
  $("connectionText").textContent = connected ? "Bluetooth terhubung" : "Belum terhubung";
  $("deviceInfo").textContent = `Perangkat: ${deviceName || "ENNERA"}`;
  updateConnectUi();
  setControlsEnabled(connected);

  state.deviceName = connected ? (deviceName || "ENNERA") : "—";

  // Status yang sama ditampilkan juga di halaman login.
  $("loginDot").classList.toggle("connected", connected);
  $("loginStatusText").textContent = connected
    ? `Terhubung ke ${state.deviceName}`
    : "Bluetooth belum terhubung";

  if (connected) {
    // Membatalkan countdown auto-OFF yang tertunda dari sesi sebelumnya,
    // agar tidak mematikan tampilan relay setelah berhasil tersambung lagi.
    clearDisconnectCountdown();
    settingsDirty = false;
    if (pendingLogin) completeLogin();
  }

  renderRelays();
  renderTimers();
  renderUser();
}

function renderNames() {
  state.names.forEach((name, index) => {
    const number = index + 1;
    $(`relayName${number}`).textContent = name;
    $(`timerName${number}`).textContent = name;
    $(`nameInput${number}`).value = name;
  });
}

function renderRelays() {
  let activeCount = 0;

  state.relays.forEach((isOn, index) => {
    if (isOn) activeCount++;
    const relayNumber = index + 1;
    const card = document.querySelector(`.relay-card[data-relay="${relayNumber}"]`);
    const button = document.querySelector(`.relay-toggle[data-relay="${relayNumber}"]`);
    const label = card.querySelector(".relay-state");

    card.classList.toggle("active", isOn);
    button.classList.toggle("on", isOn);
    button.setAttribute("aria-pressed", String(isOn));
    label.textContent = isOn ? "Menyala" : "Mati";
  });

  $("relaySummary").textContent = `${activeCount} dari ${RELAY_COUNT} aktif`;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) return `${hours}j ${minutes}m ${remainingSeconds}d`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}d`;
  return `${remainingSeconds} detik`;
}

function timerRemaining(index) {
  const end = state.timerEnds[index];
  return end ? Math.max(0, Math.ceil((end - Date.now()) / 1000)) : 0;
}

function setTimerSeconds(index, seconds) {
  state.timerEnds[index] = seconds > 0 ? Date.now() + seconds * 1000 : 0;
}

function renderTimers() {
  let anyActive = false;
  state.timerEnds.forEach((_, index) => {
    const seconds = timerRemaining(index);
    if (seconds > 0) anyActive = true;
    $(`timerStatus${index + 1}`).textContent = seconds > 0
      ? `Akan mati dalam ${formatDuration(seconds)}`
      : "Timer tidak aktif";
  });
  $("timerDot").classList.toggle("show", anyActive);
}

// Firmware hanya mengirim sisa waktu saat status berubah, jadi tampilan dihitung
// mundur di sisi HP dan disinkronkan lagi setiap ada paket status baru.
function tickTimers() {
  let expired = false;
  state.timerEnds.forEach((end, index) => {
    if (end && timerRemaining(index) === 0) {
      state.timerEnds[index] = 0;
      state.relays[index] = false;
      expired = true;
      addHistory(`Countdown ${state.names[index]} selesai`);
    }
  });
  if (expired) {
    renderRelays();
    renderUser();
    if (state.connected) sendCommand({ command: "GET_STATUS" }, { silent: true });
  }
  if (expired || state.timerEnds.some(Boolean)) renderTimers();
}

function ensureOption(select, value, label) {
  if (![...select.options].some(option => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
}

function renderSettings() {
  // Paket status datang kapan saja; jangan mengembalikan dropdown yang sedang diubah pengguna.
  if (!settingsDirty) {
    const autoOff = String(state.autoOffSec);
    ensureOption($("autoOffSelect"), autoOff, `${autoOff} detik`);
    $("autoOffSelect").value = autoOff;
    $("connectModeSelect").value = state.connectMode;
  }
  $("safetyNote").textContent =
    `Mode connect: ${MODE_LABELS[state.connectMode]}. Jika Bluetooth terputus, ` +
    `ESP32 mematikan semua relay setelah ${state.autoOffSec} detik. Hanya satu HP dapat terhubung.`;
}

function updateConnectUi() {
  connectBtn.disabled = connecting;
  $("loginConnectBtn").disabled = connecting;
  connectBtn.textContent = connecting
    ? "Menghubungkan…"
    : state.connected ? "Putuskan" : "Hubungkan";
}

function abortPendingLogin() {
  if (!pendingLogin) return;
  pendingLogin = false;
  state.user = null;
}

function clearDisconnectCountdown() {
  clearTimeout(disconnectUiTimer);
  clearTimeout(disconnectHideTimer);
  clearInterval(disconnectUiInterval);
  $("disconnectCountdown").classList.remove("show");
}

function decodeValue(dataView) {
  return new TextDecoder().decode(dataView);
}

function onStatusNotification(event) {
  const ok = receiveStatus(decodeValue(event.target.value));
  // Notifikasi dibatasi MTU (default 20 byte) sehingga JSON bisa terpotong.
  // Baca ulang lewat readValue (mendukung long read) sekali saja, tanpa perulangan.
  if (!ok) {
    statusCharacteristic?.readValue()
      .then(value => receiveStatus(decodeValue(value)))
      .catch(() => {});
  }
}

async function readStatus() {
  try {
    receiveStatus(decodeValue(await statusCharacteristic.readValue()));
  } catch {
    await sendCommand({ command: "GET_STATUS" });
  }
}

// Melepas koneksi GATT yang setengah jadi. Firmware hanya menerima satu HP,
// jadi koneksi yang menggantung akan mengunci perangkat sampai halaman dimuat ulang.
function releaseGatt() {
  statusCharacteristic?.removeEventListener("characteristicvaluechanged", onStatusNotification);
  try { if (device?.gatt?.connected) device.gatt.disconnect(); } catch {}
  statusCharacteristic = null;
  controlCharacteristic = null;
}

async function connect() {
  if (state.connected) {
    disconnect();
    return;
  }
  if (connecting) return;

  if (hasAndroidBridge()) {
    try {
      window.AndroidBLE.connect();
      showToast("Memulai koneksi Bluetooth…");
    } catch {
      abortPendingLogin();
      showToast("Gagal membuka Bluetooth Android.");
    }
    return;
  }

  if (!hasWebBluetooth()) {
    abortPendingLogin();
    $("unsupportedNotice").classList.add("show");
    showToast("Web Bluetooth tidak tersedia.");
    return;
  }

  connecting = true;
  updateConnectUi();

  try {
    showToast("Mencari ENNERA…");
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID]
    });

    device.addEventListener("gattserverdisconnected", onBrowserDisconnected);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);

    statusCharacteristic = await service.getCharacteristic(STATUS_UUID);
    controlCharacteristic = await service.getCharacteristic(CONTROL_UUID);

    // Listener dipasang SEBELUM startNotifications agar notifikasi pertama tidak hilang.
    statusCharacteristic.addEventListener("characteristicvaluechanged", onStatusNotification);
    await statusCharacteristic.startNotifications();

    setConnected(true, device.name);
    addHistory(`Terhubung ke ${device.name || "ENNERA"}`);
    showToast("Bluetooth terhubung.");

    await readStatus();
  } catch (error) {
    releaseGatt();
    abortPendingLogin();
    if (error?.name !== "NotFoundError") { // NotFoundError = pengguna menutup dialog pilih perangkat
      addHistory(`Koneksi gagal: ${error.message || "Kesalahan tidak diketahui"}`);
      showToast("Koneksi Bluetooth gagal.");
    }
  } finally {
    connecting = false;
    updateConnectUi();
  }
}

function disconnect() {
  if (hasAndroidBridge()) {
    try { window.AndroidBLE.disconnect(); } catch {}
    return;
  }
  if (device?.gatt?.connected) device.gatt.disconnect();
}

function onBrowserDisconnected() {
  statusCharacteristic?.removeEventListener("characteristicvaluechanged", onStatusNotification);
  device?.removeEventListener("gattserverdisconnected", onBrowserDisconnected);
  device = null;
  statusCharacteristic = null;
  controlCharacteristic = null;
  handleDisconnected();
}

function handleDisconnected() {
  const wasConnected = state.connected;
  setConnected(false);
  state.timerEnds = Array(RELAY_COUNT).fill(0);
  renderTimers();

  if (!wasConnected) {
    // Percobaan koneksi gagal atau event putus ganda: tidak ada relay yang perlu di-auto-OFF.
    if (pendingLogin) {
      abortPendingLogin();
      showToast("Tidak dapat terhubung ke ENNERA.");
    }
    return;
  }

  addHistory(`Bluetooth terputus; auto-OFF ${state.autoOffSec} detik dimulai`);
  showToast("Bluetooth terputus.");

  clearDisconnectCountdown();

  let remaining = state.autoOffSec;
  const alert = $("disconnectCountdown");
  alert.classList.add("show");
  alert.textContent = `Semua relay akan mati dalam ${remaining} detik.`;

  disconnectUiInterval = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      alert.textContent = `Semua relay akan mati dalam ${remaining} detik.`;
    }
  }, 1000);

  disconnectUiTimer = setTimeout(() => {
    clearInterval(disconnectUiInterval);
    state.relays = Array(RELAY_COUNT).fill(false);
    renderRelays();
    renderUser();
    alert.textContent = "Waktu auto-OFF habis. Hubungkan kembali untuk memastikan kondisi relay.";
    disconnectHideTimer = setTimeout(() => alert.classList.remove("show"), 2500);
  }, state.autoOffSec * 1000);
}

// Semua tulisan GATT diserialkan: Web Bluetooth menolak operasi kedua selama yang
// pertama belum selesai ("GATT operation already in progress").
function sendCommand(payload, { silent = false } = {}) {
  const job = commandChain.then(() => writeCommand(payload, silent));
  commandChain = job; // writeCommand tidak pernah reject
  return job;
}

async function writeCommand(payload, silent) {
  if (!state.connected) {
    if (!silent) showToast("Hubungkan ENNERA terlebih dahulu.");
    return false;
  }

  const json = JSON.stringify(payload);

  try {
    if (hasAndroidBridge()) {
      window.AndroidBLE.write(json);
    } else {
      if (!controlCharacteristic) throw new Error("Characteristic belum tersedia");
      const bytes = new TextEncoder().encode(json);
      if (typeof controlCharacteristic.writeValueWithResponse === "function") {
        await controlCharacteristic.writeValueWithResponse(bytes);
      } else {
        await controlCharacteristic.writeValue(bytes); // Chrome < 85
      }
    }
    return true;
  } catch (error) {
    if (!silent) {
      addHistory(`Perintah gagal: ${error.message || "Kesalahan Bluetooth"}`);
      showToast("Perintah gagal dikirim.");
    }
    return false;
  }
}

async function toggleRelay(relayNumber) {
  if (busyRelays.has(relayNumber)) return; // abaikan ketukan ganda selama perintah berjalan
  busyRelays.add(relayNumber);
  try {
    const nextState = !state.relays[relayNumber - 1];
    if (await sendCommand({ relay: relayNumber, state: nextState })) {
      state.relays[relayNumber - 1] = nextState;
      state.timerEnds[relayNumber - 1] = 0;
      renderRelays();
      renderTimers();
      renderUser();
      addHistory(`${state.names[relayNumber - 1]} ${nextState ? "dinyalakan" : "dimatikan"}`);
    }
  } finally {
    busyRelays.delete(relayNumber);
  }
}

async function setAll(on) {
  if (await sendCommand({ command: on ? "ALL_ON" : "ALL_OFF" })) {
    state.relays = Array(RELAY_COUNT).fill(on);
    state.timerEnds = Array(RELAY_COUNT).fill(0);
    renderUser();
    renderRelays();
    renderTimers();
    addHistory(on ? "Semua relay dinyalakan" : "Semua relay dimatikan");
  }
}

function selectedTimerSeconds(relayNumber) {
  const preset = $(`timerPreset${relayNumber}`).value;
  if (preset !== "custom") return Number(preset);

  const minutes = Number($(`timerCustom${relayNumber}`).value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) return null;
  return Math.round(minutes * 60);
}

async function startTimer(relayNumber) {
  const seconds = selectedTimerSeconds(relayNumber);
  if (!seconds) {
    showToast("Masukkan waktu 1–1440 menit.");
    return;
  }

  if (await sendCommand({ timer: { relay: relayNumber, seconds } })) {
    state.relays[relayNumber - 1] = true;
    setTimerSeconds(relayNumber - 1, seconds);
    renderRelays();
    renderTimers();
    addHistory(`${state.names[relayNumber - 1]} akan mati dalam ${formatDuration(seconds)}`);
    showToast("Countdown dimulai di ESP32.");
  }
}

async function cancelTimer(relayNumber) {
  if (await sendCommand({ timer: { relay: relayNumber, seconds: 0 } })) {
    state.timerEnds[relayNumber - 1] = 0;
    renderTimers();
    addHistory(`Countdown ${state.names[relayNumber - 1]} dibatalkan`);
    showToast("Countdown dibatalkan.");
  }
}

async function saveDeviceSettings() {
  const disconnectDelay = Number($("autoOffSelect").value);
  const connectMode = $("connectModeSelect").value;

  const success = await sendCommand({
    settings: {
      disconnect_delay: disconnectDelay,
      connect_mode: connectMode
    }
  });

  if (success) {
    state.autoOffSec = disconnectDelay;
    state.connectMode = connectMode;
    settingsDirty = false;
    renderSettings();
    addHistory(`Pengaturan ESP32: auto-OFF ${disconnectDelay} detik, mode ${MODE_LABELS[connectMode]}`);
    showToast("Pengaturan disimpan di ESP32.");
  }
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Mengembalikan true bila paket valid dan sudah diterapkan.
function receiveStatus(rawPayload) {
  try {
    const data = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
    if (!data || typeof data !== "object") throw new Error("payload bukan objek");

    // Selalu tepat RELAY_COUNT elemen, meskipun firmware mengirim array lebih pendek.
    if (Array.isArray(data.r)) {
      state.relays = Array.from({ length: RELAY_COUNT }, (_, i) => Boolean(data.r[i]));
    } else if (data.relay1 !== undefined) {
      state.relays = state.names.map((_, i) => Boolean(data[`relay${i + 1}`]));
    }
    // Paket status yang tidak membawa data relay dibiarkan apa adanya,
    // agar update parsial tidak menampilkan semua relay sebagai mati.

    if (Array.isArray(data.t)) {
      state.timerEnds = Array.from({ length: RELAY_COUNT }, (_, i) => {
        const seconds = Math.max(0, toNumber(data.t[i]) || 0);
        return seconds > 0 ? Date.now() + seconds * 1000 : 0;
      });
    }

    const autoOff = toNumber(data.ad);
    if (autoOff !== null) state.autoOffSec = autoOff;

    const mode = MODE_KEYS[toNumber(data.cm)];
    if (mode) state.connectMode = mode; // nilai tak dikenal diabaikan, bukan diam-diam jadi ALL_ON

    if (data.su !== undefined) state.singleUser = Boolean(data.su);

    renderRelays();
    renderTimers();
    renderSettings();
    renderUser();
    return true;
  } catch {
    console.warn("Status BLE tidak valid:", rawPayload);
    return false;
  }
}

connectBtn.addEventListener("click", connect);
toggles.forEach(button => {
  button.addEventListener("click", () => toggleRelay(Number(button.dataset.relay)));
});
allOnBtn.addEventListener("click", () => setAll(true));
allOffBtn.addEventListener("click", () => setAll(false));

timerStartButtons.forEach(button => {
  button.addEventListener("click", () => startTimer(Number(button.dataset.relay)));
});
timerCancelButtons.forEach(button => {
  button.addEventListener("click", () => cancelTimer(Number(button.dataset.relay)));
});

for (let relayNumber = 1; relayNumber <= RELAY_COUNT; relayNumber++) {
  $(`timerPreset${relayNumber}`).addEventListener("change", event => {
    $(`timerCustom${relayNumber}`).hidden = event.target.value !== "custom";
  });
}

$("saveDeviceSettingsBtn").addEventListener("click", saveDeviceSettings);

$("saveNamesBtn").addEventListener("click", () => {
  state.names = DEFAULT_NAMES.map((fallback, index) => {
    const value = $(`nameInput${index + 1}`).value.trim();
    return value || fallback;
  });
  saveJson("ecoWattNames", state.names);
  renderNames();
  addHistory("Nama relay diperbarui");
  showToast("Nama berhasil disimpan di HP.");
});

$("clearHistoryBtn").addEventListener("click", () => {
  state.history = [];
  saveJson("ecoWattHistory", state.history);
  renderHistory();
  showToast("Riwayat dihapus.");
});

window.EcoWattApp = {
  onConnected(deviceName) {
    const name = deviceName || "Neo_Volt"; // native bisa mengirim null; default parameter tidak menangkap null
    setConnected(true, name);
    addHistory(`Terhubung ke ${name}`);
    showToast("Bluetooth terhubung.");
  },
  onDisconnected() {
    handleDisconnected();
  },
  onStatus(payload) {
    receiveStatus(payload);
  },
  onError(message) {
    abortPendingLogin(); // jangan biarkan login menggantung menunggu koneksi yang sudah gagal
    addHistory(`Bluetooth error: ${message || "tidak diketahui"}`);
    showToast(message || "Terjadi kesalahan Bluetooth.");
  }
};

/* ==================================================================
   HALAMAN 1 — LOGIN
   ================================================================== */

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(el => {
    el.classList.toggle("active", el.id === id);
  });
  window.scrollTo(0, 0);
}

function attemptLogin() {
  if (connecting) return;
  const name = $("loginName").value.trim();

  if (name.length < 2) {
    $("loginError").textContent = "Nama minimal 2 karakter.";
    $("loginName").focus();
    return;
  }
  $("loginError").textContent = "";

  state.user = { name: name.slice(0, 24), since: Date.now() };

  if (state.connected) {
    completeLogin();
    return;
  }

  // Login baru dianggap selesai setelah BLE benar-benar tersambung.
  pendingLogin = true;
  connect();
}

function completeLogin() {
  pendingLogin = false;
  if (state.user) { // nama baru disimpan setelah login benar-benar berhasil
    state.user.since = Date.now();
    saveJson("ecoWattUser", state.user);
  }
  showScreen("screenApp");
  switchTab("tabControl");
  renderUser();
  addHistory(`${state.user?.name || "Pengguna"} masuk ke aplikasi`);
  showToast(`Selamat datang, ${state.user?.name || "Pengguna"}.`);
}

// confirm() bawaan tidak jalan di Android WebView tanpa WebChromeClient.onJsConfirm
// (selalu mengembalikan false), sehingga tombol Keluar diam-diam tidak berfungsi.
function askConfirm(message, okLabel = "Ya") {
  const dialog = $("confirmDialog");
  if (typeof dialog.showModal !== "function") return Promise.resolve(window.confirm(message));

  return new Promise(resolve => {
    $("confirmMessage").textContent = message;
    $("confirmOk").textContent = okLabel;
    const finish = (result) => {
      dialog.onclose = null;
      $("confirmOk").onclick = null;
      $("confirmCancel").onclick = null;
      if (dialog.open) dialog.close();
      resolve(result);
    };
    $("confirmOk").onclick = () => finish(true);
    $("confirmCancel").onclick = () => finish(false);
    dialog.onclose = () => finish(false); // tombol Esc / back
    dialog.showModal();
  });
}

async function logout() {
  if (!(await askConfirm("Keluar dari aplikasi dan memutus Bluetooth?", "Keluar"))) return;

  pendingLogin = false;
  disconnect();
  addHistory(`${state.user?.name || "Pengguna"} keluar`);

  state.user = null;
  removeKey("ecoWattUser");

  $("loginName").value = "";
  $("loginError").textContent = "";
  showScreen("screenLogin");
  showToast("Anda telah keluar.");
}

/* ==================================================================
   HALAMAN 2 — NAVIGASI TAB BAWAH
   ================================================================== */

function switchTab(tabId) {
  document.querySelectorAll(".tab-panel").forEach(panel => {
    panel.classList.toggle("active", panel.id === tabId);
  });
  document.querySelectorAll(".tab-btn").forEach(button => {
    const isActive = button.dataset.tab === tabId;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  if (tabId === "tabUser") renderUser();
  window.scrollTo(0, 0);
}

document.querySelectorAll(".tab-btn").forEach(button => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

/* ==================================================================
   TAB 4 — INFORMASI USER
   ================================================================== */

function renderUser() {
  const name = state.user?.name || "Pengguna";
  $("greeting").textContent = `Halo, ${name}`;
  $("avatar").textContent = name.charAt(0).toUpperCase();
  $("profileName").textContent = name;
  $("profileSince").textContent = state.user?.since
    ? `Masuk sejak ${new Date(state.user.since).toLocaleTimeString("id-ID", {
        hour: "2-digit", minute: "2-digit"
      })}`
    : "Masuk sejak —";

  $("userConnState").textContent = state.connected ? "Terhubung" : "Terputus";
  $("userDevice").textContent = state.deviceName;
  $("userRelayCount").textContent =
    `${state.relays.filter(Boolean).length} dari ${RELAY_COUNT}`;
  $("userMode").textContent = MODE_LABELS[state.connectMode] || "—";
  $("userAutoOff").textContent = `${state.autoOffSec} detik`;
  $("userHistoryCount").textContent = String(state.history.length);
}

/* ==================================================================
   EVENT LOGIN / LOGOUT
   ================================================================== */

$("loginConnectBtn").addEventListener("click", attemptLogin);
$("loginName").addEventListener("keydown", event => {
  if (event.key === "Enter") attemptLogin();
});
$("loginName").addEventListener("input", () => {
  $("loginError").textContent = "";
});
$("logoutBtn").addEventListener("click", logout);

/* ==================================================================
   INISIALISASI
   ================================================================== */

if (!hasAndroidBridge() && !hasWebBluetooth()) {
  $("unsupportedNotice").classList.add("show");
}

// Nama terakhir diisikan kembali, tetapi user tetap harus menekan
// "Hubungkan" agar sesi selalu dimulai dari koneksi BLE yang nyata.
const lastUser = loadJson("neoVoltUser", null);
if (lastUser?.name) $("loginName").value = lastUser.name;

renderNames();
renderRelays();
renderTimers();
renderSettings();
renderHistory();
setConnected(false);
renderUser();
showScreen("screenLogin");

["autoOffSelect", "connectModeSelect"].forEach(id => {
  $(id).addEventListener("change", () => { settingsDirty = true; });
});

setInterval(tickTimers, 1000);
