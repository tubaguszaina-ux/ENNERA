// Menguji service worker di sandbox vm dengan cache in-memory.
// Timer dipercepat 100x supaya batas 3 detik tidak membuat tes lambat.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BASE = "http://localhost/";
const SRC = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");

const basic = (body, status = 200) => {
  const res = new Response(body, { status });
  Object.defineProperty(res, "type", { value: "basic" });
  return res;
};
const pathOf = (req) => new URL(typeof req === "string" ? req : req.url, BASE).pathname;

function loadSw({ cached = {}, fetchImpl }) {
  const listeners = {};
  const store = new Map(Object.entries(cached).map(([k, v]) => [k, basic(v)]));
  const fetchCalls = [];
  const cache = {
    add: async () => {},
    put: async (req, res) => { store.set(pathOf(req), res); }
  };
  const caches = {
    open: async () => cache,
    keys: async () => [],
    delete: async () => true,
    // meniru Cache API: query string hanya diabaikan bila ignoreSearch:true
    match: async (req, opts) => {
      const hasQuery = new URL(typeof req === "string" ? req : req.url, BASE).search !== "";
      if (hasQuery && !opts?.ignoreSearch) return undefined;
      return store.get(pathOf(req))?.clone();
    }
  };
  const sandbox = {
    self: { addEventListener: (t, fn) => { listeners[t] = fn; }, skipWaiting() {}, clients: { claim() {} } },
    caches, URL, Response,
    fetch: (req) => { fetchCalls.push(pathOf(req)); return fetchImpl(req); },
    setTimeout: (fn, ms) => setTimeout(fn, ms / 100)
  };
  vm.runInNewContext(SRC, sandbox);

  return {
    store, fetchCalls,
    request(pathname, mode = "no-cors") {
      let responded; const waits = [];
      listeners.fetch({
        request: { method: "GET", url: BASE + pathname.replace(/^\//, ""), mode },
        respondWith: (p) => { responded = p; },
        waitUntil: (p) => waits.push(p)
      });
      return { response: Promise.resolve(responded), settled: () => Promise.all(waits) };
    }
  };
}

const bodyOf = async (res) => (await res).text();

test("offline: halaman dilayani dari cache", async () => {
  const sw = loadSw({ cached: { "/index.html": "CACHED" }, fetchImpl: () => Promise.reject(new TypeError("offline")) });
  assert.equal(await bodyOf(sw.request("/", "navigate").response), "CACHED");
});

test("jaringan macet: setelah batas waktu app memakai cache, tidak menggantung", async () => {
  const sw = loadSw({ cached: { "/app.js": "OLD" }, fetchImpl: () => new Promise(() => {}) });
  const t0 = Date.now();
  assert.equal(await bodyOf(sw.request("/app.js").response), "OLD");
  assert.ok(Date.now() - t0 < 1000);
});

test("jaringan normal: versi terbaru dilayani dan cache diperbarui", async () => {
  const sw = loadSw({ cached: { "/app.js": "OLD" }, fetchImpl: async () => basic("NEW") });
  const { response, settled } = sw.request("/app.js");
  assert.equal(await bodyOf(response), "NEW");
  await settled();
  assert.equal(await sw.store.get("/app.js").text(), "NEW");
});

test("manifest ikut network-first (dulu cache-first sehingga perubahan tak pernah sampai)", async () => {
  const sw = loadSw({ cached: { "/manifest.webmanifest": "OLD" }, fetchImpl: async () => basic("NEW") });
  assert.equal(await bodyOf(sw.request("/manifest.webmanifest").response), "NEW");
});

test("ikon: cache-first, tanpa menyentuh jaringan bila sudah ada di cache", async () => {
  const sw = loadSw({ cached: { "/icons/icon-192.png": "PNG" }, fetchImpl: async () => basic("NET") });
  assert.equal(await bodyOf(sw.request("/icons/icon-192.png").response), "PNG");
  assert.deepEqual(sw.fetchCalls, []);
});

test("aset dengan query string (app.js?v=2) tetap dilayani dari cache saat offline", async () => {
  const sw = loadSw({ cached: { "/app.js": "CACHED" }, fetchImpl: () => Promise.reject(new TypeError("offline")) });
  assert.equal(await bodyOf(sw.request("/app.js?v=2").response), "CACHED");
});
