// Harness tes: memuat index.html + app.js di jsdom dengan Web Bluetooth palsu.
// Semua pengujian bersifat black-box (lewat DOM dan window.EcoWattApp).
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const FakeTimers = require("@sinonjs/fake-timers");

const ROOT = path.join(__dirname, "..");
const APP_JS = process.env.APP_JS || path.join(ROOT, "app.js"); // bisa diarahkan ke versi lama untuk perbandingan
const DEFAULT_STATUS = '{"r":[0,0,0,0],"t":[0,0,0,0],"ad":3,"cm":0,"su":1}';

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const enc = (text) => new DataView(new TextEncoder().encode(text).buffer);
const dec = (view) => new TextDecoder().decode(view);

function makeBluetooth(opts = {}) {
  const log = { writes: [], order: [], disconnects: 0, active: 0, maxActive: 0 };
  let notifyListeners = [];
  const gattListeners = new Set();

  const statusChar = {
    addEventListener(type, fn) { log.order.push("addListener"); notifyListeners.push(fn); },
    removeEventListener(type, fn) { notifyListeners = notifyListeners.filter(f => f !== fn); },
    async startNotifications() { log.order.push("startNotifications"); },
    async readValue() { return enc(opts.status ?? DEFAULT_STATUS); },
    notify(text) { notifyListeners.forEach(fn => fn({ target: { value: enc(text) } })); }
  };
  const controlChar = {
    async writeValueWithResponse(bytes) {
      log.active++; log.maxActive = Math.max(log.maxActive, log.active);
      await new Promise(r => setImmediate(r));
      log.writes.push(JSON.parse(dec(bytes)));
      log.active--;
    }
  };
  const server = {
    async getPrimaryService() {
      if (opts.failService) throw new Error("service tidak ditemukan");
      return { async getCharacteristic(uuid) { return uuid.includes("-0002-") ? statusChar : controlChar; } };
    }
  };
  const device = {
    name: "Eco_Watt",
    gatt: {
      connected: false,
      async connect() { this.connected = true; return server; },
      disconnect() {
        if (!this.connected) return;
        this.connected = false; log.disconnects++;
        setImmediate(() => gattListeners.forEach(fn => fn()));
      }
    },
    addEventListener(type, fn) { gattListeners.add(fn); },
    removeEventListener(type, fn) { gattListeners.delete(fn); }
  };
  const bluetooth = {
    async requestDevice() {
      if (opts.cancel) { const e = new Error("dibatalkan"); e.name = "NotFoundError"; throw e; }
      return device;
    }
  };
  return { bluetooth, device, statusChar, log, setStatus(text) { opts.status = text; } };
}

async function boot({ bt = {}, android = false, brokenStorage = false, noStructuredClone = !process.env.KEEP_SC, storage = {} } = {}) {
  const fake = makeBluetooth(bt);
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  let clock;

  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    beforeParse(window) {
      clock = FakeTimers.withGlobal(window).install({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]
      });
      window.scrollTo = () => {}; // belum diimplementasikan jsdom
      for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, JSON.stringify(v));
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      // Default: meniru WebView Android lama tanpa structuredClone (KEEP_SC=1 untuk menyediakannya).
      if (noStructuredClone) delete window.structuredClone; else window.structuredClone = structuredClone;
      if (brokenStorage) window.Storage.prototype.setItem = () => { throw new Error("QuotaExceededError"); };
      if (android) window.AndroidBLE = { calls: [], connect() { this.calls.push("connect"); }, disconnect() { this.calls.push("disconnect"); }, write(j) { this.calls.push(j); } };
      else Object.defineProperty(window.navigator, "bluetooth", { value: fake.bluetooth, configurable: true });
      // jsdom belum mengimplementasikan <dialog>.showModal
      window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
      window.HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open"); this.dispatchEvent(new window.Event("close"));
      };
    }
  });

  const { window } = dom;
  window.eval(fs.readFileSync(APP_JS, "utf8"));
  const $ = (id) => window.document.getElementById(id);

  return {
    window, clock, fake, $, settle,
    text: (id) => $(id).textContent,
    isActiveScreen: (id) => $(id).classList.contains("active"),
    relayOn: (n) => window.document.querySelector(`.relay-card[data-relay="${n}"]`).classList.contains("active"),
    click: (el) => (typeof el === "string" ? $(el) : el).click(),
    async login(name = "Bahri") {
      $("loginName").value = name;
      $("loginConnectBtn").click();
      await settle();
    }
  };
}

module.exports = { boot, settle, DEFAULT_STATUS };
