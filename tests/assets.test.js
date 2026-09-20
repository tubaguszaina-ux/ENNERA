// Konsistensi aset PWA: file yang dirujuk harus ada, ukuran ikon sesuai deklarasi.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const png = (f) => {
  const b = fs.readFileSync(path.join(ROOT, f));
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
};

test("manifest valid dan semua ikon ada dengan ukuran sesuai deklarasi", () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  for (const icon of m.icons) {
    const { width, height } = png(icon.src);
    assert.equal(`${width}x${height}`, icon.sizes, icon.src);
  }
  assert.ok(m.icons.some(i => i.sizes === "192x192") && m.icons.some(i => i.sizes === "512x512"));
});

test("ikon maskable full-bleed (tanpa kanal alpha) dan tidak dipakai ulang dari ikon 'any'", () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  const maskable = m.icons.filter(i => i.purpose === "maskable");
  const any = new Set(m.icons.filter(i => i.purpose === "any").map(i => i.src));
  assert.ok(maskable.length >= 2);
  for (const icon of maskable) {
    assert.ok(!any.has(icon.src), `${icon.src} dipakai ganda`);
    assert.ok([0, 2, 3].includes(png(icon.src).colorType), `${icon.src} masih punya alpha`);
  }
});

test("semua file di daftar precache service worker ada", () => {
  const list = read("service-worker.js").match(/CACHE_FILES = \[([\s\S]*?)\];/)[1];
  const files = [...list.matchAll(/"\.\/([^"]*)"/g)].map(m => m[1]).filter(Boolean);
  assert.ok(files.length > 5);
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} tidak ada`);
});

test("file lokal yang dirujuk index.html ada", () => {
  const html = read("index.html");
  const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map(m => m[1]);
  for (const r of refs) assert.ok(fs.existsSync(path.join(ROOT, r)), `${r} tidak ada`);
});

test("setiap id yang dipakai app.js lewat $() ada di index.html", () => {
  const html = read("index.html");
  const js = read("app.js");
  const dynamic = /relayName|timerName|timerStatus|timerPreset|timerCustom|nameInput/; // dibuat oleh app.js
  const ids = [...new Set([...js.matchAll(/\$\("([A-Za-z]+)"\)/g)].map(m => m[1]))];
  for (const id of ids) {
    if (dynamic.test(id)) continue;
    assert.ok(html.includes(`id="${id}"`), `id "${id}" tidak ditemukan di index.html`);
  }
});
