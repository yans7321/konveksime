// Polish-round self-test (run: node --test tests/polish.mjs)
// Covers the required scenarios from the real-usage bug report:
//   - Qty tersedia: order 100, pickup 40 -> 60; pickup 100 -> 0 & leaves the list
//   - Storan: pickup 80, stor 50 -> belum distor 30
//   - Kiriman: order 100, shipped 70 -> sisa 30
//   - History endpoints return rows (pickups/storages/shipments)
//   - Authentication: unauthenticated 401 on every endpoint
//   - User isolation: user B never sees user A's data
//   - Date helpers: DD/MM/YYYY display + inclusive range filter (app-format.js)
// Runs against an in-memory SQL emulator (no real PostgreSQL, no credentials).
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://test-local"; // satisfy isDbConfigured()

const { _useTestDriver, runMigrations } = await import("../netlify/functions/_db.mjs");
const authMod = await import("../netlify/functions/auth.mjs");
const syncMod = await import("../netlify/functions/sync.mjs");
const jobsMod = await import("../netlify/functions/jobs.mjs");
const pickupsMod = await import("../netlify/functions/pickups.mjs");
const storagesMod = await import("../netlify/functions/storages.mjs");
const shipmentsMod = await import("../netlify/functions/shipments.mjs");

// ---------- Date helpers (app-format.js in a window shim) ----------
test("format tanggal: ISO/Date -> DD/MM/YYYY", async () => {
  global.window = {};
  await import("../app-format.js");
  const Y = global.window.YansDate;
  assert.equal(global.window.showDate("2026-09-24"), "24/09/2026");
  assert.equal(Y.fmtDmy("2026-09-24"), "24/09/2026");
  assert.equal(Y.fmtDmy("2026-09-04"), "04/09/2026");
  assert.equal(Y.fmtDmy(new Date(2026, 8, 24)), "24/09/2026");
  assert.equal(Y.fmtDmy("2026-09-24T10:00:00Z"), "24/09/2026");
  assert.equal(Y.fmtDmy(""), "");
  assert.equal(Y.fmtDmy(null), "");
});

test("filter tanggal: inclusive range [dari .. sampai]", async () => {
  const Y = global.window.YansDate;
  assert.equal(Y.inDateRange("2026-09-24", "2026-09-01", "2026-09-30"), true);
  assert.equal(Y.inDateRange("2026-09-01", "2026-09-01", "2026-09-30"), true, "batas awal inklusif");
  assert.equal(Y.inDateRange("2026-09-30", "2026-09-01", "2026-09-30"), true, "batas akhir inklusif");
  assert.equal(Y.inDateRange("2026-08-31", "2026-09-01", "2026-09-30"), false);
  assert.equal(Y.inDateRange("2026-10-01", "2026-09-01", "2026-09-30"), false);
  assert.equal(Y.inDateRange("2026-09-24", "", ""), true, "tanpa filter -> semua tampil");
  assert.equal(Y.inDateRange("2026-09-24", "2026-09-01", ""), true, "hanya batas awal");
  assert.equal(Y.inDateRange("2026-09-24", "", "2026-09-30"), true, "hanya batas akhir");
  // Date object dari pg DATE column juga difilter benar
  assert.equal(Y.inDateRange(new Date(2026, 8, 24), "2026-09-01", "2026-09-30"), true);
  assert.equal(Y.inDateRange(new Date(2026, 7, 24), "2026-09-01", "2026-09-30"), false);
});

// ---------- In-memory SQL emulator (auth + sync + jobs + pickups + storages + shipments) ----------
function makeDriver() {
  const users = new Map(), sessions = new Map(), perusahaan = new Map();
  const jobs = new Map(), pickups = new Map(), storages = new Map(), shipments = new Map();
  let nextId = { users: 1, perusahaan: 1, jobs: 1, pickups: 1, storages: 1, shipments: 1 };
  const now = () => new Date();
  const parseJson = (v) => (typeof v === "string" ? JSON.parse(v) : v);
  const jobOut = (r) => ({ ...r, variants: parseJson(r.variants) });

  const sums = (userId, jobId) => ({
    taken: [...pickups.values()].filter((k) => k.user_id === userId && k.job_id === jobId && !k.deleted_at).reduce((s, k) => s + k.quantity, 0),
    stored: [...storages.values()].filter((s) => s.user_id === userId && s.job_id === jobId && !s.deleted_at).reduce((a, s) => a + s.quantity, 0),
    shipped: [...shipments.values()].filter((s) => s.user_id === userId && s.job_id === jobId && !s.deleted_at)
      .reduce((a, s) => a + parseJson(s.variants).reduce((x, v) => x + (Number(v.jumlah) || 0), 0), 0),
  });
  const perusahaanNama = (j) => (j.perusahaan_id && perusahaan.get(j.perusahaan_id))?.nama || null;

  function pickupWithJoins(r) { const j = jobs.get(r.job_id); return { ...r, job_code: j?.job_code ?? null, nama_pekerjaan: j?.nama_pekerjaan ?? null, perusahaan_nama: perusahaanNama(j) }; }
  function storageWithJoins(r) { return pickupWithJoins(r); }

  return {
    _perusahaan: perusahaan,
    async query(text, params = []) {
      const t = text.replace(/\s+/g, " ").trim();

      if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(t)) return [];
      if (/pg_advisory_xact_lock/.test(t)) return [];
      if (/CREATE TABLE IF NOT EXISTS yans_migrations/.test(t)) return [];
      if (/SELECT name FROM yans_migrations/.test(t)) {
        return [{ name: "0001_foundation_tables" }, { name: "0002_jobs" }, { name: "0003_tailoring_pickups" }, { name: "0004_storages" }, { name: "0006_ledger_modules" }, { name: "0007_shipments" }];
      }
      if (/INSERT INTO yans_migrations/.test(t)) return [];

      // ---------- auth ----------
      if (/SELECT id FROM app_users WHERE lower\(username\) = lower\(\$1\)/.test(t)) {
        return [...users.values()].filter((u) => u.username.toLowerCase() === String(params[0]).toLowerCase()).map((u) => ({ id: u.id }));
      }
      if (/INSERT INTO app_users/.test(t)) {
        const row = { id: nextId.users++, username: params[0], name: params[1], password_hash: params[2], provider: "local", is_active: true, permissions: JSON.parse(params[3]), email: null };
        users.set(row.id, row);
        return [row];
      }
      if (/SELECT id, username, email, name, password_hash/.test(t)) {
        return [...users.values()].filter((u) => u.username.toLowerCase() === String(params[0]).toLowerCase()).slice(0, 1);
      }
      if (/INSERT INTO app_sessions/.test(t)) {
        sessions.set(params[0], { token_hash: params[0], user_id: params[1], expires_at: new Date(Date.now() + 864e5) });
        return [];
      }
      if (/DELETE FROM app_sessions/.test(t)) return [];
      if (/FROM app_sessions s\s+JOIN app_users u/.test(t)) {
        const s = sessions.get(params[0]);
        if (!s || s.expires_at <= new Date()) return [];
        const u = users.get(s.user_id);
        if (!u || !u.is_active) return [];
        return [{ id: u.id, username: u.username, email: u.email, name: u.name, provider: u.provider, is_active: u.is_active, permissions: u.permissions }];
      }

      // ---------- sync perusahaan ----------
      if (/INSERT INTO yans_perusahaan/.test(t)) {
        const row = { id: nextId.perusahaan++, user_id: params[0], nama: params[1], pic: params[2], telepon: params[3], catatan: params[4], legacy_id: params[5], created_at: now(), updated_at: now(), deleted_at: null };
        perusahaan.set(row.id, row);
        return [{ id: row.id, nama: row.nama, legacyId: row.legacy_id }];
      }
      if (/^SELECT id FROM yans_perusahaan WHERE user_id = \$1 AND lower\(nama\) = lower\(\$2\)/.test(t)) {
        return [...perusahaan.values()].filter((r) => r.user_id === params[0] && r.nama.toLowerCase() === String(params[1]).toLowerCase() && !r.deleted_at).map((r) => ({ id: r.id }));
      }
      if (/^SELECT id, nama FROM yans_perusahaan WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL$/.test(t)) {
        const r = perusahaan.get(params[0]);
        return r && r.user_id === params[1] && !r.deleted_at ? [{ id: r.id, nama: r.nama }] : [];
      }
      if (/SELECT id, nama, pic, telepon, catatan, legacy_id AS "legacyId"/.test(t)) {
        return [...perusahaan.values()].filter((r) => r.user_id === params[0] && !r.deleted_at).sort((a, b) => a.id - b.id)
          .map((r) => ({ id: r.id, nama: r.nama, pic: r.pic, telepon: r.telepon, catatan: r.catatan, legacyId: r.legacy_id }));
      }

      // ---------- jobs ----------
      if (/INSERT INTO yans_pekerjaan/.test(t)) {
        const row = {
          id: nextId.jobs++, user_id: params[0], job_code: params[1], perusahaan_id: params[2], legacy_id: null,
          nama_pekerjaan: params[3], tanggal_masuk: params[4], deadline: params[5], jumlah_order: params[6],
          harga_per_pcs: params[7], total_nilai: params[8], catatan: params[9], status: params[10],
          variants: params[11], created_at: now(), updated_at: now(), deleted_at: null,
        };
        jobs.set(row.id, row);
        return [jobOut(row)];
      }
      if (/FROM yans_pekerjaan WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL/.test(t)) {
        const r = jobs.get(params[0]);
        return r && r.user_id === params[1] && !r.deleted_at ? [jobOut(r)] : [];
      }

      // ---------- pickups ----------
      if (/SELECT p\.id, p\.job_code/.test(t) && /WHERE p\.id = \$2/.test(t) && !/AS stored/.test(t) && !/jsonb_array_elements/.test(t)) {
        const j = jobs.get(params[1]);
        if (!j || j.user_id !== params[0] || j.deleted_at) return [];
        return [{ id: j.id, job_code: j.job_code, nama_pekerjaan: j.nama_pekerjaan, perusahaan_id: j.perusahaan_id, legacy_id: j.legacy_id, status: j.status, jumlah_order: j.jumlah_order, taken: sums(params[0], j.id).taken, perusahaan_nama: perusahaanNama(j) }];
      }
      if (/COALESCE\(st\.stored, 0\)/.test(t)) {
        return [...jobs.values()].filter((j) => j.user_id === params[0] && !j.deleted_at).filter((j) => sums(params[0], j.id).taken > 0).sort((a, b) => b.id - a.id)
          .map((j) => { const { taken, stored } = sums(params[0], j.id); return { id: j.id, job_code: j.job_code, nama_pekerjaan: j.nama_pekerjaan, perusahaan_id: j.perusahaan_id, legacy_id: j.legacy_id, status: j.status, jumlah_order: j.jumlah_order, taken, stored, perusahaan_nama: perusahaanNama(j) }; });
      }
      if (/COALESCE\(pk\.taken, 0\)/.test(t)) {
        return [...jobs.values()].filter((j) => j.user_id === params[0] && !j.deleted_at).sort((a, b) => b.id - a.id)
          .map((j) => ({ id: j.id, job_code: j.job_code, nama_pekerjaan: j.nama_pekerjaan, perusahaan_id: j.perusahaan_id, legacy_id: j.legacy_id, status: j.status, jumlah_order: j.jumlah_order, taken: sums(params[0], j.id).taken, perusahaan_nama: perusahaanNama(j) }));
      }
      if (/SELECT id, job_id, quantity FROM yans_tailoring_pickups WHERE user_id = \$1 AND legacy_id = \$2/.test(t)) {
        const r = [...pickups.values()].find((k) => k.user_id === params[0] && k.legacy_id === params[1] && !k.deleted_at);
        return r ? [{ id: r.id, job_id: r.job_id, quantity: r.quantity }] : [];
      }
      if (/INSERT INTO yans_tailoring_pickups/.test(t)) {
        const row = { id: nextId.pickups++, user_id: params[0], job_id: params[1], quantity: params[2], picked_up_at: params[3], tukang: params[4], jenis: params[5], catatan: params[6], legacy_id: params[7], created_at: now(), updated_at: now(), deleted_at: null };
        pickups.set(row.id, row);
        return [pickupWithJoins(row)];
      }
      if (/FROM yans_tailoring_pickups pk\s+JOIN yans_pekerjaan p ON p\.id = pk\.job_id/.test(t)) {
        const out = [...pickups.values()].filter((k) => k.user_id === params[0] && !k.deleted_at);
        const jobFiltered = params[1] !== undefined ? out.filter((k) => k.job_id === params[1]) : out;
        return jobFiltered.sort((a, b) => b.id - a.id).slice(0, 500).map(pickupWithJoins);
      }

      // ---------- storages ----------
      if (/SELECT p\.id, p\.job_code/.test(t) && /WHERE p\.id = \$2/.test(t) && /AS stored/.test(t)) {
        const j = jobs.get(params[1]);
        if (!j || j.user_id !== params[0] || j.deleted_at) return [];
        const { taken, stored } = sums(params[0], j.id);
        return [{ id: j.id, job_code: j.job_code, nama_pekerjaan: j.nama_pekerjaan, perusahaan_id: j.perusahaan_id, legacy_id: j.legacy_id, status: j.status, jumlah_order: j.jumlah_order, taken, stored, perusahaan_nama: perusahaanNama(j) }];
      }
      if (/SELECT id, job_id, quantity FROM yans_storages WHERE user_id = \$1 AND legacy_id = \$2/.test(t)) {
        const r = [...storages.values()].find((s) => s.user_id === params[0] && s.legacy_id === params[1] && !s.deleted_at);
        return r ? [{ id: r.id, job_id: r.job_id, quantity: r.quantity }] : [];
      }
      if (/INSERT INTO yans_storages/.test(t)) {
        const row = { id: nextId.storages++, user_id: params[0], job_id: params[1], quantity: params[2], stored_at: params[3], legacy_id: params[4], created_at: now(), updated_at: now(), deleted_at: null };
        storages.set(row.id, row);
        return [storageWithJoins(row)];
      }
      if (/FROM yans_storages s\s+JOIN yans_pekerjaan p ON p\.id = s\.job_id/.test(t)) {
        const out = [...storages.values()].filter((s) => s.user_id === params[0] && !s.deleted_at);
        const jobFiltered = params[1] !== undefined ? out.filter((s) => s.job_id === params[1]) : out;
        return jobFiltered.sort((a, b) => b.id - a.id).slice(0, 500).map(storageWithJoins);
      }

      // ---------- shipments ----------
      if (/^SELECT s\.id, s\.job_id, s\.variants FROM yans_shipments s WHERE/.test(t)) {
        const uP = Number(t.match(/user_id = \$(\d+)/)[1]);
        const iP = Number(t.match(/s\.id = \$(\d+)/)[1]);
        const row = shipments.get(params[iP - 1]);
        return row && row.user_id === params[uP - 1] && !row.deleted_at ? [{ id: row.id, job_id: row.job_id, variants: row.variants }] : [];
      }
      if (/^SELECT id, job_id, variants FROM yans_shipments WHERE/.test(t)) {
        const uP = Number(t.match(/user_id = \$(\d+)/)[1]);
        const lP = Number(t.match(/legacy_id = \$(\d+)/)[1]);
        return [...shipments.values()].filter((r) => r.user_id === params[uP - 1] && r.legacy_id === params[lP - 1] && !r.deleted_at).slice(0, 1);
      }
      if (/INSERT INTO yans_shipments/.test(t) && /RETURNING id$/.test(t)) {
        const row = {
          id: nextId.shipments++, user_id: params[0], job_id: params[1], perusahaan_id: null,
          tanggal: params[2], status: params[3], penerima: params[4], catatan: params[5],
          variants: params[6], foto_file_name: params[7], foto_mime_type: params[8],
          foto_size_bytes: params[9], foto_storage_ref: null, legacy_id: params[10],
          created_at: now(), updated_at: now(), deleted_at: null,
        };
        shipments.set(row.id, row);
        return [{ id: row.id }];
      }
      if (/^UPDATE yans_shipments SET legacy_id = id WHERE id = \$1 AND legacy_id IS NULL$/.test(t)) {
        const row = shipments.get(params[0]);
        if (row && row.legacy_id == null) row.legacy_id = row.id;
        return [];
      }
      if (/jsonb_array_elements/.test(t)) {
        const uP = Number(t.match(/user_id = \$(\d+)/)[1]);
        const idP = t.match(/p\.id = \$(\d+)/);
        let jobRows = [...jobs.values()].filter((r) => r.user_id === params[uP - 1] && !r.deleted_at);
        if (idP) jobRows = jobRows.filter((r) => r.id === params[Number(idP[1]) - 1]);
        const listOnly = /COALESCE\(sh\.shipped, 0\) < p\.jumlah_order/.test(t);
        if (listOnly) jobRows = jobRows.filter((j) => sums(params[uP - 1], j.id).shipped < Number(j.jumlah_order) || 0);
        return jobRows.sort((a, b) => b.id - a.id).map((j) => {
          return { id: j.id, job_code: j.job_code, nama_pekerjaan: j.nama_pekerjaan, perusahaan_id: j.perusahaan_id, legacy_id: j.legacy_id, status: j.status, jumlah_order: j.jumlah_order, shipped: sums(params[uP - 1], j.id).shipped, perusahaan_nama: perusahaanNama(j) };
        });
      }
      if (/^SELECT s\.id, s\.job_id, s\.perusahaan_id, s\.tanggal/.test(t) && /FROM yans_shipments s/.test(t)) {
        const uP = Number(t.match(/user_id = \$(\d+)/)[1]);
        const idP = t.match(/WHERE s\.id = \$(\d+)/);
        let rows = [...shipments.values()].filter((r) => r.user_id === params[uP - 1] && !r.deleted_at);
        if (idP) rows = rows.filter((r) => r.id === params[Number(idP[1]) - 1]);
        else if (/AND s\.job_id = \$2/.test(t)) rows = rows.filter((r) => r.job_id === params[1]);
        rows.sort((a, b) => b.id - a.id);
        return rows.map((r) => {
          const j = r.job_id ? jobs.get(r.job_id) : null;
          return { ...r, variants: parseJson(r.variants), job_code: j ? j.job_code : null, nama_pekerjaan: j ? j.nama_pekerjaan : null, perusahaan_nama: perusahaanNama(j) };
        });
      }

      throw new Error("SQL emulator: unsupported statement: " + t.slice(0, 140));
    },
  };
}

function req(method, body, token, url = "https://yans.test/api/tailoring-pickups") {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", "Bearer " + token);
  return { method, headers, url, json: async () => body };
}

async function register(auth, name, username) {
  const res = await auth(req("POST", { action: "register", name, username, password: "rahasia123" }, null, "https://yans.test/api/auth"), {});
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

async function createJob(jobs, token, perusahaanId, kode, jumlahOrder) {
  const res = await jobs(req("POST", { kodePekerjaan: kode, perusahaanId, jumlahOrder, harga: 10000 }, token, "https://yans.test/api/jobs"));
  assert.equal(res.status, 201, "job create sukses");
  return (await res.json()).job;
}

async function setup() {
  const driver = makeDriver();
  _useTestDriver(driver);
  await runMigrations();
  const auth = authMod.default, sync = syncMod.default, jobs = jobsMod.default;
  const tokenA = await register(auth, "Pemilik A", "pol_a_" + Date.now());
  const tokenB = await register(auth, "Pemilik B", "pol_b_" + Date.now());
  let res = await sync(req("POST", { kind: "perusahaan", items: [{ nama: "PT A" }] }, tokenA, "https://yans.test/api/sync"));
  assert.equal(res.status, 200);
  const perusahaanIdA = (await res.json()).items[0].id;
  res = await sync(req("POST", { kind: "perusahaan", items: [{ nama: "PT B" }] }, tokenB, "https://yans.test/api/sync"));
  assert.equal(res.status, 200);
  return { driver, tokenA, tokenB, perusahaanIdA, jobs };
}

test("Ambil Jahit: order 100, diambil 40 -> tersedia 60; diambil 100 -> 0 & keluar dari daftar", async () => {
  const { tokenA, perusahaanIdA, jobs } = await setup();
  const pickups = pickupsMod.default;
  const job = await createJob(jobs, tokenA, perusahaanIdA, "POL-A1", 100);

  // order 100, pickup 40 -> tersedia 60
  let res = await pickups(req("POST", { jobId: job.id, quantity: 40, pickedUpAt: "2026-09-20", tukang: "Pak Budi" }, tokenA));
  assert.equal(res.status, 201);
  let body = await res.json();
  assert.equal(body.job.totalQuantity, 100);
  assert.equal(body.job.takenQuantity, 40);
  assert.equal(body.job.availableQuantity, 60);

  res = await pickups(req("GET", null, tokenA, "https://yans.test/api/tailoring-pickups?available=1"));
  body = await res.json();
  const inList = body.items.find((j) => j.jobId === job.id);
  assert.ok(inList, "job dengan sisa muncul di daftar tersedia");
  assert.equal(inList.availableQuantity, 60);

  // pickup 60 lagi -> total 100 -> tersedia 0 & keluar dari daftar
  res = await pickups(req("POST", { jobId: job.id, quantity: 60, pickedUpAt: "2026-09-21" }, tokenA));
  assert.equal(res.status, 201);
  res = await pickups(req("GET", null, tokenA, "https://yans.test/api/tailoring-pickups?available=1"));
  body = await res.json();
  assert.ok(!body.items.find((j) => j.jobId === job.id), "job penuh tidak muncul lagi");
  res = await pickups(req("GET", null, tokenA, "https://yans.test/api/tailoring-pickups?jobId=" + job.id + "&available=1"));
  body = await res.json();
  assert.equal(body.job.availableQuantity, 0);

  // riwayat server berisi kedua transaksi (2D: API history berfungsi)
  res = await pickups(req("GET", null, tokenA, "https://yans.test/api/tailoring-pickups"));
  body = await res.json();
  assert.equal(body.items.length, 2);
  assert.ok(body.items[0].pickedUpAt, "pickedUpAt ada");
});

test("Storan: diambil 80, stor 50 -> belum distor 30", async () => {
  const { tokenA, perusahaanIdA, jobs } = await setup();
  const pickups = pickupsMod.default, storages = storagesMod.default;
  const job = await createJob(jobs, tokenA, perusahaanIdA, "POL-S1", 100);

  let res = await pickups(req("POST", { jobId: job.id, quantity: 80, pickedUpAt: "2026-09-20" }, tokenA));
  assert.equal(res.status, 201);

  // Belum ada pengambilan -> tidak storable; SUDAH diambil -> storable
  res = await storages(req("GET", null, tokenA, "https://yans.test/api/storages?storable=1"));
  let body = await res.json();
  const row = body.items.find((j) => j.jobId === job.id);
  assert.ok(row, "job yang sudah diambil muncul di daftar belum distor");
  assert.equal(row.takenQuantity, 80);
  assert.equal(row.notStoredQuantity, 80);

  res = await storages(req("POST", { jobId: job.id, quantity: 50, storedAt: "2026-09-22" }, tokenA));
  assert.equal(res.status, 201);
  body = await res.json();
  assert.equal(body.job.takenQuantity, 80);
  assert.equal(body.job.storedQuantity, 50);
  assert.equal(body.job.notStoredQuantity, 30);

  res = await storages(req("GET", null, tokenA, "https://yans.test/api/storages?storable=1&jobId=" + job.id));
  body = await res.json();
  assert.equal(body.job.notStoredQuantity, 30);

  // riwayat storan berisi 1 transaksi (3B: API history berfungsi)
  res = await storages(req("GET", null, tokenA, "https://yans.test/api/storages"));
  body = await res.json();
  assert.equal(body.items.length, 1);
  assert.ok(body.items[0].storedAt, "storedAt ada");
});

test("Kiriman: order 100, dikirim 70 -> sisa 30", async () => {
  const { tokenA, perusahaanIdA, jobs } = await setup();
  const shipments = shipmentsMod.default;
  const job = await createJob(jobs, tokenA, perusahaanIdA, "POL-K1", 100);

  let res = await shipments(req("POST", { jobId: job.id, tanggal: "2026-09-24", status: "Selesai", penerima: "Rina", variants: [{ warna: "A", ukuran: "L", jumlah: 70 }] }, tokenA, "https://yans.test/api/shipments"));
  assert.equal(res.status, 201);

  res = await shipments(req("GET", null, tokenA, "https://yans.test/api/shipments?shippable=1&jobId=" + job.id));
  let body = await res.json();
  assert.equal(body.job.remainingQuantity, 30);

  res = await shipments(req("GET", null, tokenA, "https://yans.test/api/shipments?shippable=1"));
  body = await res.json();
  const inList = body.items.find((j) => j.jobId === job.id);
  assert.ok(inList, "job dengan sisa muncul di daftar kiriman");
  assert.equal(inList.remainingQuantity, 30);

  // kirim sisa 30 -> keluar dari daftar
  res = await shipments(req("POST", { jobId: job.id, tanggal: "2026-09-25", status: "Selesai", penerima: "Rina", variants: [{ warna: "A", ukuran: "L", jumlah: 30 }] }, tokenA, "https://yans.test/api/shipments"));
  assert.equal(res.status, 201);
  res = await shipments(req("GET", null, tokenA, "https://yans.test/api/shipments?shippable=1"));
  body = await res.json();
  assert.ok(!body.items.find((j) => j.jobId === job.id), "job penuh tidak muncul lagi");

  // riwayat kiriman berisi 2 transaksi (4B: API history berfungsi)
  res = await shipments(req("GET", null, tokenA, "https://yans.test/api/shipments"));
  body = await res.json();
  assert.equal(body.items.length, 2);
});

test("Authentication & isolasi user: 401 tanpa sesi; data user A tidak terlihat user B", async () => {
  const { tokenA, tokenB, perusahaanIdA, jobs } = await setup();
  const pickups = pickupsMod.default, storages = storagesMod.default, shipments = shipmentsMod.default;
  const job = await createJob(jobs, tokenA, perusahaanIdA, "POL-ISO", 100);

  await pickups(req("POST", { jobId: job.id, quantity: 10, pickedUpAt: "2026-09-20" }, tokenA));
  await storages(req("POST", { jobId: job.id, quantity: 5, storedAt: "2026-09-21" }, tokenA));
  await shipments(req("POST", { jobId: job.id, tanggal: "2026-09-22", status: "Selesai", penerima: "R", variants: [{ warna: "A", ukuran: "", jumlah: 7 }] }, tokenA, "https://yans.test/api/shipments"));

  // unauthenticated -> 401 di semua endpoint
  let res = await pickups(req("GET", null, null));
  assert.equal(res.status, 401);
  res = await storages(req("GET", null, null));
  assert.equal(res.status, 401);
  res = await shipments(req("GET", null, null, "https://yans.test/api/shipments"));
  assert.equal(res.status, 401);

  // user B tidak melihat data user A
  res = await pickups(req("GET", null, tokenB, "https://yans.test/api/tailoring-pickups"));
  assert.equal((await res.json()).items.length, 0, "riwayat pickup B kosong");
  res = await pickups(req("GET", null, tokenB, "https://yans.test/api/tailoring-pickups?available=1"));
  assert.ok(!(await res.json()).items.find((j) => j.jobId === job.id), "job A tidak ada di daftar B");
  res = await storages(req("GET", null, tokenB, "https://yans.test/api/storages"));
  assert.equal((await res.json()).items.length, 0, "riwayat storan B kosong");
  res = await shipments(req("GET", null, tokenB, "https://yans.test/api/shipments"));
  assert.equal((await res.json()).items.length, 0, "riwayat kiriman B kosong");

  // sedangkan user A melihat semuanya
  res = await pickups(req("GET", null, tokenA, "https://yans.test/api/tailoring-pickups"));
  assert.equal((await res.json()).items.length, 1);
  res = await storages(req("GET", null, tokenA, "https://yans.test/api/storages"));
  assert.equal((await res.json()).items.length, 1);
  res = await shipments(req("GET", null, tokenA, "https://yans.test/api/shipments"));
  assert.equal((await res.json()).items.length, 1);
});
