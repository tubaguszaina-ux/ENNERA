const test = require("node:test");
const assert = require("node:assert/strict");
const { boot, settle } = require("./harness");

test("inisialisasi tetap jalan tanpa structuredClone dan saat localStorage.setItem melempar error", async () => {
  const app = await boot({ brokenStorage: true });
  assert.ok(app.isActiveScreen("screenLogin"));
  assert.equal(app.$("relayGrid").children.length, 4);
});

test("login → koneksi BLE → layar aplikasi, status perangkat diterapkan", async () => {
  const app = await boot({ bt: { status: '{"r":[1,0,1,0],"t":[0,0,0,0],"ad":5,"cm":2}' } });
  await app.login("Bahri");
  assert.ok(app.isActiveScreen("screenApp"));
  assert.equal(app.text("greeting"), "Halo, Bahri");
  assert.ok(app.relayOn(1) && !app.relayOn(2) && app.relayOn(3));
  assert.equal(app.text("relaySummary"), "2 dari 4 aktif");
  assert.equal(app.$("autoOffSelect").value, "5");
  assert.equal(app.$("connectModeSelect").value, "STAY_OFF");
  assert.equal(app.window.document.querySelector(".relay-toggle").disabled, false);
});

test("listener notifikasi dipasang sebelum startNotifications", async () => {
  const app = await boot();
  await app.login();
  assert.deepEqual(app.fake.log.order, ["addListener", "startNotifications"]);
});

test("gagal setelah gatt.connect: GATT dilepas, login dibatalkan, bisa dicoba lagi", async () => {
  const app = await boot({ bt: { failService: true } });
  await app.login("Bahri");
  assert.equal(app.fake.log.disconnects, 1, "koneksi GATT harus dilepas agar ESP32 tidak terkunci");
  assert.ok(app.isActiveScreen("screenLogin"));
  assert.equal(app.$("loginConnectBtn").disabled, false, "tombol harus aktif lagi");
  assert.match(app.text("toast"), /gagal/i);
  assert.ok(!app.$("disconnectCountdown").classList.contains("show"), "tidak boleh ada countdown auto-OFF");
});

test("dialog pilih perangkat ditutup: kembali ke login tanpa pesan error", async () => {
  const app = await boot({ bt: { cancel: true } });
  await app.login();
  assert.ok(app.isActiveScreen("screenLogin"));
  assert.equal(app.$("loginConnectBtn").disabled, false);
  assert.doesNotMatch(app.text("toast"), /gagal/i);
});

test("tulisan GATT diserialkan dan ketukan ganda pada relay yang sama diabaikan", async () => {
  const app = await boot();
  await app.login();
  const toggles = app.window.document.querySelectorAll(".relay-toggle");
  toggles[0].click(); toggles[0].click(); toggles[1].click();
  await app.settle(30);
  assert.equal(app.fake.log.maxActive, 1, "tidak boleh ada dua operasi GATT bersamaan");
  assert.deepEqual(app.fake.log.writes, [{ relay: 1, state: true }, { relay: 2, state: true }]);
});

test("timer dihitung mundur lokal, relay mati saat habis, lalu status diminta ulang", async () => {
  const app = await boot({ bt: { status: '{"r":[1,0,0,0],"t":[10,0,0,0],"ad":3,"cm":0}' } });
  await app.login();
  assert.match(app.text("timerStatus1"), /10 detik/);
  app.clock.tick(4000);
  assert.match(app.text("timerStatus1"), /6 detik/);
  assert.ok(app.relayOn(1));
  app.clock.tick(6000);
  await app.settle();
  assert.equal(app.text("timerStatus1"), "Timer tidak aktif");
  assert.ok(!app.relayOn(1));
  assert.ok(app.fake.log.writes.some(w => w.command === "GET_STATUS"));
});

test("paket status tidak menimpa pilihan Pengaturan yang belum disimpan", async () => {
  const app = await boot();
  await app.login();
  app.$("autoOffSelect").value = "30";
  app.$("autoOffSelect").dispatchEvent(new app.window.Event("change"));
  app.window.EcoWattApp.onStatus('{"r":[1,0,0,0],"ad":5}');
  assert.equal(app.$("autoOffSelect").value, "30");
  app.click("saveDeviceSettingsBtn");
  await app.settle();
  assert.deepEqual(app.fake.log.writes.at(-1), { settings: { disconnect_delay: 30, connect_mode: "ALL_ON" } });
  app.window.EcoWattApp.onStatus('{"ad":10}');
  assert.equal(app.$("autoOffSelect").value, "10", "nilai di luar daftar harus tetap bisa ditampilkan");
});

test("status: array pendek, cm tidak valid, dan JSON rusak ditangani", async () => {
  const app = await boot();
  await app.login();
  app.window.EcoWattApp.onStatus('{"r":[0,0,1,0],"cm":2}');
  assert.ok(app.relayOn(3));
  assert.equal(app.$("connectModeSelect").value, "STAY_OFF");

  app.window.EcoWattApp.onStatus('{"r":[1]}');            // array lebih pendek dari jumlah relay
  assert.ok(app.relayOn(1) && !app.relayOn(3), "relay 3 tidak boleh tertinggal 'menyala' dari status lama");

  app.window.EcoWattApp.onStatus('{"cm":null}');
  app.window.EcoWattApp.onStatus('{"cm":9}');
  assert.equal(app.$("connectModeSelect").value, "STAY_OFF", "cm null/tak dikenal tidak boleh diam-diam jadi ALL_ON");

  app.window.EcoWattApp.onStatus('{"r":[1,1,1');           // terpotong
  app.window.EcoWattApp.onStatus("null");
  assert.equal(app.text("relaySummary"), "1 dari 4 aktif", "paket rusak tidak mengubah tampilan");
});

test("notifikasi terpotong memicu baca ulang lewat readValue", async () => {
  const app = await boot();
  await app.login();
  app.fake.setStatus('{"r":[0,0,1,0]}');   // kondisi terbaru di perangkat
  app.fake.statusChar.notify('{"r":[0,0');  // notifikasi terpotong oleh MTU
  await app.settle();
  assert.ok(app.relayOn(3), "status harus dipulihkan lewat readValue");
  app.fake.statusChar.notify('{"r":[0,1,0,0]}');
  assert.ok(app.relayOn(2) && !app.relayOn(3));
});

test("Android: putus saat percobaan koneksi tidak memicu countdown auto-OFF dan login dibatalkan", async () => {
  const app = await boot({ android: true });
  app.$("loginName").value = "Bahri";
  app.click("loginConnectBtn");
  app.window.EcoWattApp.onDisconnected();
  assert.ok(!app.$("disconnectCountdown").classList.contains("show"));
  assert.ok(app.isActiveScreen("screenLogin"));
  assert.match(app.text("toast"), /Tidak dapat terhubung/);
  // login berikutnya tetap bisa berhasil, dan nama perangkat null tidak tercetak "null"
  app.click("loginConnectBtn");
  app.window.EcoWattApp.onConnected(null);
  assert.ok(app.isActiveScreen("screenApp"));
  assert.equal(app.text("deviceInfo"), "Perangkat: Eco_Watt");
  assert.ok(!app.$("historyList").textContent.includes("null"));
});

test("putus tak terduga saat terhubung memulai countdown lalu menampilkan relay mati", async () => {
  const app = await boot({ bt: { status: '{"r":[1,1,0,0],"ad":3}' } });
  await app.login();
  app.fake.device.gatt.disconnect();
  await app.settle();
  assert.match(app.text("disconnectCountdown"), /3 detik/);
  app.clock.tick(3000);
  assert.equal(app.text("relaySummary"), "0 dari 4 aktif");
  app.clock.tick(2600);
  assert.ok(!app.$("disconnectCountdown").classList.contains("show"));
});

test("Keluar memakai dialog aplikasi (bukan confirm) dan memutus Bluetooth", async () => {
  const app = await boot();
  app.window.confirm = () => { throw new Error("confirm() tidak boleh dipakai"); };
  await app.login();
  app.click("logoutBtn");
  assert.ok(app.$("confirmDialog").hasAttribute("open"));
  app.click("confirmOk");
  await app.settle();
  assert.ok(app.isActiveScreen("screenLogin"));
  assert.equal(app.fake.log.disconnects, 1);
  assert.equal(app.$("loginName").value, "");
});

test("Batal pada dialog Keluar mempertahankan sesi", async () => {
  const app = await boot();
  await app.login();
  app.click("logoutBtn");
  app.click("confirmCancel");
  await app.settle();
  assert.ok(app.isActiveScreen("screenApp"));
  assert.equal(app.fake.log.disconnects, 0);
});

test("riwayat menampilkan tanggal untuk entri bukan hari ini dan membuang entri tanpa waktu", async () => {
  const app = await boot({
    storage: {
      ecoWattHistory: [
        { time: Date.parse("2020-01-02T12:00:00Z"), message: "entri lama" },
        { message: "tanpa waktu" }
      ]
    }
  });
  const items = app.window.document.querySelectorAll("#historyList li");
  assert.equal(items.length, 1);
  assert.match(items[0].textContent, /02 Jan/);
  assert.match(items[0].textContent, /entri lama/);
});

test("nama relay rusak di localStorage jatuh ke nilai bawaan, bukan merusak aplikasi", async () => {
  const app = await boot({ storage: { ecoWattNames: ["A", 5, "", null] } });
  assert.equal(app.text("relayName1"), "A");
  assert.equal(app.text("relayName2"), "Stopkontak 2");
  assert.equal(app.text("relayName4"), "Master Power");
});

test("localStorage penuh/diblokir saat koneksi tidak dianggap koneksi gagal", async () => {
  const app = await boot({ brokenStorage: true });
  await app.login();
  assert.ok(app.isActiveScreen("screenApp"));
  assert.doesNotMatch(app.text("toast"), /gagal/i);
  assert.equal(app.fake.log.disconnects, 0, "koneksi tidak boleh dibuang hanya karena riwayat gagal disimpan");
});
