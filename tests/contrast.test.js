// Menjaga keterbacaan palet: pasangan teks/latar yang benar-benar dipakai di styles.css
// harus memenuhi WCAG AA (teks 4.5:1, elemen UI 3:1) setiap kali token warna diubah.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");

const root = postcss.parse(fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8"));
const tokens = {};
root.walkRules(":root", (r) => r.walkDecls(/^--/, (d) => { tokens[d.prop.slice(2)] = d.value.trim(); }));

const resolve = (name) => {
  let v = tokens[name];
  const ref = v && v.match(/^var\(--([\w-]+)\)$/);
  return ref ? resolve(ref[1]) : v;
};
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [teks, latar, minimum, keterangan]
const PAIRS = [
  ["text", "bg", 4.5, "teks utama di latar halaman"],
  ["text", "panel", 4.5, "teks utama di panel"],
  ["text", "blue-deep", 4.5, "teks utama di awal gradasi kartu"],
  ["text", "blue", 4.5, "teks utama di kartu relay menyala"],
  ["muted", "bg", 4.5, "teks sekunder di latar halaman"],
  ["muted", "panel", 4.5, "teks sekunder di panel"],
  ["muted", "blue-deep", 4.5, "teks sekunder di kartu"],
  ["muted", "blue", 4.5, "teks sekunder di kartu relay menyala"],
  ["muted", "well", 4.5, "placeholder/teks di input"],
  ["accent", "bg", 4.5, "kuning di latar halaman"],
  ["accent", "panel", 4.5, "kuning di panel"],
  ["accent", "blue", 4.5, "kuning di tab aktif (biru brand)"],
  ["ink", "accent", 4.5, "teks tombol utama (di atas kuning)"],
  ["accent-soft", "bg", 4.5, "teks peringatan kuning"],
  ["red-soft", "bg", 4.5, "teks bahaya/error"],
  ["red", "bg", 3, "indikator merah (titik status)"],
];

test("token warna yang dibutuhkan tersedia dan berformat hex", () => {
  for (const t of new Set(PAIRS.flat().filter((x) => typeof x === "string" && !/^\d|\s/.test(x)))) {
    assert.match(resolve(t) ?? "", /^#[0-9a-f]{6}$/i, `--${t}`);
  }
});

for (const [fg, bg, min, label] of PAIRS) {
  test(`kontras ${label} ≥ ${min}:1`, () => {
    const r = ratio(resolve(fg), resolve(bg));
    assert.ok(r >= min, `--${fg} di atas --${bg} hanya ${r.toFixed(2)}:1`);
  });
}

test("palet memakai biru dan kuning brand persis", () => {
  assert.equal(resolve("blue").toLowerCase(), "#003f88");
  assert.equal(resolve("accent").toLowerCase(), "#ffd500");
  assert.equal(resolve("on").toLowerCase(), "#ffd500");
});
