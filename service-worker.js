// Service worker Eco Watt — cache dasar agar app tetap bisa dibuka tanpa internet.
// Tidak menyentuh logika Bluetooth/relay, hanya menyimpan file statis.

const CACHE_NAME = "eco-watt-cache-v3";
const NETWORK_TIMEOUT_MS = 3000;
const CACHE_FILES = [
  "./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest",
  "./icons/icon-16.png", "./icons/icon-32.png", "./icons/apple-touch-icon.png",
  "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/icon-maskable-192.png", "./icons/icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Per-file agar satu ikon yang hilang tidak menggagalkan seluruh instalasi.
      Promise.all(CACHE_FILES.map((url) => cache.add(url).catch(() => null)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

function isFresh(response) {
  return response && response.ok && response.type === "basic";
}

async function putInCache(request, response) {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response);
}

async function lookupCache(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  return request.mode === "navigate" ? caches.match("./index.html") : undefined;
}

// Network-first dengan batas waktu: UI tidak boleh tertinggal versi lama, tetapi
// jaringan yang "hidup tapi macet" (tanpa internet, Wi-Fi tanpa akses) tidak boleh
// membuat app menggantung — setelah NETWORK_TIMEOUT_MS pakai salinan cache.
async function networkFirst(event) {
  const request = event.request;

  const network = fetch(request).then(async (response) => {
    if (isFresh(response)) await putInCache(request, response.clone());
    return response;
  });
  event.waitUntil(network.catch(() => {}));

  const afterTimeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS))
    .then(() => lookupCache(request))
    .then((cached) => cached || network);

  try {
    return await Promise.race([network, afterTimeout]);
  } catch {
    return (await lookupCache(request)) || Response.error();
  }
}

async function cacheFirst(event) {
  const request = event.request;
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (isFresh(response)) event.waitUntil(putInCache(request, response.clone()));
  return response;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  // webmanifest ikut network-first; dulu cache-first sehingga perubahan manifest tidak pernah sampai.
  const isAppShell =
    event.request.mode === "navigate" ||
    /\.(html|css|js|webmanifest)$/.test(url.pathname);

  event.respondWith(isAppShell ? networkFirst(event) : cacheFirst(event));
});
