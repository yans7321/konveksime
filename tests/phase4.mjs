// Phase 4 self-test (run: node --test tests/phase4.mjs)
// Exercises the storages (Storan) API end-to-end against an in-memory SQL
// emulator (no real PostgreSQL, no credentials). Covers:
//   - storable snapshot: picked-up jobs with live total/taken/stored/notStored
//   - flow per spec: 100 total -> take 40 -> store 15 -> store 25 -> store 1 more rejected
//   - store before any pickup: rejected 404 (Ambil Jahit first)
//   - over-store: rejected (409, insufficient_storable_quantity), DB unchanged
//   - zero / negative / decimal / non-numeric quantities rejected
//   - ownership isolation: foreign job_id rejected even when known; history isolated
//   - unauthenticated access rejected
//   - history records every transaction (date, job, perusahaan, quantity)
//   - edit (legacy id) updates in place and re-validates with the old qty refunded
//   - concurrent double submission: one succeeds, the other rejected (atomicity)
//   - HTTP routing through the Netlify-like dev server
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://test-local"; // satisfy isDbConfigured()

const { _useTestDriver, runMigrations } = await import("../netlify/functions/_db.mjs");
const authMod = await import("../netlify/functions/auth.mjs");
const syncMod = await import("../netlify/functions/sync.mjs");
const jobsMod = await import("../netlify/functions/jobs.mjs");
const pickupsMod = await import("../netlify/functions/pickups.mjs");
const storagesMod = await import("../netlify/functions/storages.mjs");
const { startServer } = await import("./dev-server.mjs");

// ---------- In-memory SQL emulator (Phase 1 + 2 + 3 + 4 statements) ----------
function makeDriver() {
  const users = new Map();
  const sessions = new Map();
  const pekerja = new Map();
  const perusahaan = new Map();
  const jobs = new Map();
  const pickups = new Map();
  const storages = new Map();
  let nextId = { users: 1, pekerja: 1, perusahaan: 1, jobs: 1, pickups: 1, storages: 1 };
  const now = () => new Date();

  const jobOut = (r) => ({ ...r, variants: typeof r.variants === "string" ? JSON.parse(r.variants) : r.variants });

  function parseUpdate(text, params, table, store) {
    const t = text.replace(/\s+/g, " ").trim();
    const m = t.match(new RegExp("UPDATE " + table + " SET (.+?) WHERE (.+)$"));
    if (!m) return false;
    const setPart = m[1];
    const where = m[2];
    const idMatch = where.match(/id = \$(\d+)/);
    const userMatch = where.match(/user_id = \$(\d+)/);
    if (!idMatch || !userMatch) return false;
    const row = store.get(params[Number(idMatch[1]) - 1]);
    if (!row || row.user_id !== params[Number(userMatch[1]) - 1]) return false;
    const pairRe = /(\w+) = \$(\d+)/g;
    let pm;
    while ((pm = pairRe.exec(setPart)) !== null) {
      row[pm[1]] = params[Number(pm[2]) - 1];
    }
    row.updated_at = now();
    return true;
  }

  function storageWithJoins(r) {
    const j = jobs.get(r.job_id);
    const p = j && j.perusahaan_id ? perusahaan.get(j.perusahaan_id) : null;
    return {
      ...r,
      job_code: j ? j.job_code : null,
      nama_pekerjaan: j ? j.nama_pekerjaan : null,
      perusahaan_nama: p ? p.nama : null,
    };
  }

  function sumsFor(userId, jobId) {
    const taken = [...pickups.values()]
      .filter((k) => k.user_id === userId && k.job_id === jobId && !k.deleted_at)
      .reduce((s, k) => s + k.quantity, 0);
    const stored = [...storages.values()]
      .filter((s) => s.user_id === userId && s.job_id === jobId && !s.deleted_at)
      .reduce((acc, s) => acc + s.quantity, 0);
    return { taken, stored };
  }

  function storableRow(j, userId) {
    const { taken, stored } = sumsFor(userId, j.id);
    const pr = j.perusahaan_id ? perusahaan.get(j.perusahaan_id) : null;
    return {
      id: j.id, job_code: j.job_code, nama_pekerjaan: j.nama_pekerjaan, perusahaan_id: j.perusahaan_id,
      legacy_id: j.legacy_id, status: j.status, jumlah_order: j.jumlah_order, taken, stored,
      perusahaan_nama: pr ? pr.nama : null,
    };
  }

  return {
    async query(text, params = []) {
      const t = text.replace(/\s+/g, " ").trim();

      if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(t)) return [];
      if (/pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(t)) {
        // Emulate the per-job advisory lock: a later acquirer continues only
        // after earlier acquirers finished their whole microtask chain (i.e.
        // their transaction completed). Keeps the concurrent double-submission
        // test deterministic without real PostgreSQL.
        return new Promise((resolve) => setImmediate(resolve));
      }
      if (/pg_advisory_xact_lock/.test(t)) return []; // unparameterized (migrations) — no-op
      if (/CREATE TABLE IF NOT EXISTS yans_migrations/.test(t)) return [];
      if (/SELECT name FROM yans_migrations/.test(t)) {
        return [{ name: "0001_foundation_tables" }, { name: "0002_jobs" }, { name: "0003_tailoring_pickups" }, { name: "0004_storages" }, { name: "0006_ledger_modules" }];
      }
      if (/INSERT INTO yans_migrations/.test(t)) return [];

      // ---------- auth (Phase 1) ----------
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

      // ---------- sync (Phase 1) ----------
      if (/INSERT INTO yans_pekerja \(user_id, nama, legacy_id\)/.test(t)) {
        const key = params[0] + "|" + params[1];
        const ex = pekerja.get(key);
        if (ex) { if (params[2] != null) ex.legacy_id = params[2]; ex.deleted_at = null; return []; }
        pekerja.set(key, { id: nextId.pekerja++, user_id: params[0], nama: params[1], legacy_id: params[2], deleted_at: null });
        return [];
      }
      if (/SELECT id, nama, legacy_id AS "legacyId"/.test(t)) {
        return [...pekerja.values()].filter((r) => r.user_id === params[0] && !r.deleted_at).sort((a, b) => a.id - b.id)
          .map((r) => ({ id: r.id, nama: r.nama, legacyId: r.legacy_id, createdAt: now(), updatedAt: now() }));
      }
      if (/INSERT INTO yans_perusahaan \(user_id, nama, pic/.test(t)) {
        const key = params[0] + "|" + params[1];
        const ex = perusahaan.get(key);
        if (ex) { ex.pic = params[2]; ex.telepon = params[3]; ex.catatan = params[4]; if (params[5] != null) ex.legacy_id = params[5]; ex.deleted_at = null; return []; }
        const row = { id: nextId.perusahaan++, user_id: params[0], nama: params[1], pic: params[2], telepon: params[3], catatan: params[4], legacy_id: params[5], deleted_at: null };
        perusahaan.set(row.id, row);
        return [];
      }
      if (/SELECT id, nama, pic, telepon, catatan, legacy_id AS "legacyId"/.test(t)) {
        return [...perusahaan.values()].filter((r) => r.user_id === params[0] && !r.deleted_at).sort((a, b) => a.id - b.id)
          .map((r) => ({ id: r.id, nama: r.nama, pic: r.pic, telepon: r.telepon, catatan: r.catatan, legacyId: r.legacy_id, createdAt: now(), updatedAt: now() }));
      }
      if (/INSERT INTO yans_jenis_pekerjaan/.test(t)) return [];
      if (/SELECT id, kode, nama, kategori_biaya/.test(t)) return [];

      // ---------- perusahaan resolution (Phase 2) ----------
      if (/SELECT id, nama FROM yans_perusahaan WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL/.test(t)) {
        const r = perusahaan.get(params[0]);
        return r && r.user_id === params[1] && !r.deleted_at ? [{ id: r.id, nama: r.nama }] : [];
      }
      if (/SELECT id FROM yans_perusahaan WHERE user_id = \$1 AND lower\(nama\) = lower\(\$2\)/.test(t)) {
        const found = [...perusahaan.values()].find((r) => r.user_id === params[0] && !r.deleted_at && r.nama.toLowerCase() === String(params[1]).toLowerCase());
        return found ? [{ id: found.id }] : [];
      }

      // ---------- jobs (Phase 2) ----------
      if (/INSERT INTO yans_pekerjaan/.test(t)) {
        const dup = [...jobs.values()].find((j) => j.user_id === params[0] && j.job_code === params[1]);
        if (dup) {
          throw new Error('duplicate key value violates unique constraint "yans_pekerjaan_user_code_key"');
        }
        const row = {
          id: nextId.jobs++, user_id: params[0], job_code: params[1], perusahaan_id: params[2], legacy_id: null,
          nama_pekerjaan: params[3], tanggal_masuk: params[4], deadline: params[5], jumlah_order: params[6],
          harga_per_pcs: params[7], total_nilai: params[8], catatan: params[9], status: params[10],
          variants: params[11], created_at: now(), updated_at: now(), deleted_at: null,
        };
        jobs.set(row.id, row);
        return [jobOut(row)];
      }
      if (/FROM yans_pekerjaan WHERE user_id = \$1 AND deleted_at IS NULL ORDER BY id DESC/.test(t)) {
        return [...jobs.values()].filter((j) => j.user_id === params[0] && !j.deleted_at).sort((a, b) => b.id - a.id).map(jobOut);
      }
      if (/FROM yans_pekerjaan WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL/.test(t)) {
        const r = jobs.get(params[0]);
        return r && r.user_id === params[1] && !r.deleted_at ? [jobOut(r)] : [];
      }
      if (/SELECT jumlah_order, harga_per_pcs FROM yans_pekerjaan/.test(t)) {
        const r = jobs.get(params[0]);
        return r && r.user_id === params[1] ? [{ jumlah_order: r.jumlah_order, harga_per_pcs: r.harga_per_pcs }] : [];
      }
      if (/^UPDATE yans_pekerjaan SET deleted_at = now\(\), updated_at = now\(\) WHERE id = \$1 AND user_id = \$2$/.test(t)) {
        const r = jobs.get(params[0]);
        if (!r || r.user_id !== params[1]) return [];
        r.deleted_at = now();
        r.updated_at = now();
        return [];
      }
      if (/^UPDATE yans_pekerjaan SET/.test(t)) {
        const ok = parseUpdate(t, params, "yans_pekerjaan", jobs);
        if (!ok) throw new Error("emulator: job update missed target");
        return [];
      }

      // ---------- accessories/documents (Phase 2, minimal for reuse) ----------
      if (/INSERT INTO yans_job_accessories/.test(t)) return [{ id: 1 }];
      if (/INSERT INTO yans_job_documents/.test(t)) return [{ id: 1 }];

      // ---------- tailoring pickups (Phase 3) ----------
      // (checked AFTER the storages branches: both single-job snapshots share
      // the same prefix; only the storages one selects "AS stored")
      if (/COALESCE\(st\.stored, 0\)/.test(t)) {
        // storages storable list (picked-up jobs of user with live sums)
        return [...jobs.values()]
          .filter((j) => j.user_id === params[0] && !j.deleted_at)
          .filter((j) => sumsFor(params[0], j.id).taken > 0)
          .sort((a, b) => b.id - a.id)
          .map((j) => storableRow(j, params[0]));
      }
      if (/COALESCE\(pk\.taken, 0\)/.test(t)) {
        // pickups available list (all jobs of user with live sums)
        return [...jobs.values()].filter((j) => j.user_id === params[0] && !j.deleted_at).sort((a, b) => b.id - a.id).map((j) => {
          const { taken } = sumsFor(params[0], j.id);
          const pr = j.perusahaan_id ? perusahaan.get(j.perusahaan_id) : null;
          return { id: j.id, job_code: j.job_code, nama_pekerjaan: j.nama_pekerjaan, perusahaan_id: j.perusahaan_id, legacy_id: j.legacy_id, status: j.status, jumlah_order: j.jumlah_order, taken, perusahaan_nama: pr ? pr.nama : null };
        });
      }
      if (/SELECT id, job_id, quantity FROM yans_tailoring_pickups WHERE user_id = \$1 AND legacy_id = \$2/.test(t)) {
        const r = [...pickups.values()].find((k) => k.user_id === params[0] && k.legacy_id === params[1] && !k.deleted_at);
        return r ? [{ id: r.id, job_id: r.job_id, quantity: r.quantity }] : [];
      }
      if (/INSERT INTO yans_tailoring_pickups/.test(t)) {
        const row = {
          id: nextId.pickups++, user_id: params[0], job_id: params[1], quantity: params[2], picked_up_at: params[3],
          tukang: params[4], jenis: params[5], catatan: params[6], legacy_id: params[7],
          created_at: now(), updated_at: now(), deleted_at: null,
        };
        pickups.set(row.id, row);
        return [pickupWithJoins(row)];
      }
      if (/^UPDATE yans_tailoring_pickups\s+SET quantity = \$1, picked_up_at = \$2, tukang = \$3, jenis = \$4, catatan = \$5, updated_at = now\(\)\s+WHERE id = \$6 AND user_id = \$7/.test(t)) {
        const r = pickups.get(params[5]);
        if (!r || r.user_id !== params[6]) return [];
        r.quantity = params[0]; r.picked_up_at = params[1]; r.tukang = params[2]; r.jenis = params[3]; r.catatan = params[4];
        r.updated_at = now();
        return [pickupWithJoins(r)];
      }
      if (/FROM yans_tailoring_pickups pk\s+JOIN yans_pekerjaan p ON p\.id = pk\.job_id/.test(t)) {
        const out = [...pickups.values()].filter((k) => k.user_id === params[0] && !k.deleted_at);
        const jobFiltered = params[1] !== undefined ? out.filter((k) => k.job_id === params[1]) : out;
        return jobFiltered.sort((a, b) => b.id - a.id).slice(0, 500).map(pickupWithJoins);
      }

      // ---------- storages (Phase 4) ----------
      if (/p\.jumlah_order/.test(t) && /WHERE p\.id = \$2/.test(t) && /AS stored/.test(t)) {
        // storages.jobStorable: single-job snapshot with live taken+stored sums
        const j = jobs.get(params[1]);
        if (!j || j.user_id !== params[0] || j.deleted_at) return [];
        const { taken, stored } = sumsFor(params[0], j.id);
        const pr = j.perusahaan_id ? perusahaan.get(j.perusahaan_id) : null;
        return [{
          id: j.id, job_code: j.job_code, nama_pekerjaan: j.nama_pekerjaan, perusahaan_id: j.perusahaan_id,
          legacy_id: j.legacy_id, status: j.status, jumlah_order: j.jumlah_order, taken, stored,
          perusahaan_nama: pr ? pr.nama : null,
        }];
      }
      if (/p\.jumlah_order/.test(t) && /WHERE p\.id = \$2/.test(t)) {
        // pickups.jobAvailability: single-job snapshot with live taken sum
        const j = jobs.get(params[1]);
        if (!j || j.user_id !== params[0] || j.deleted_at) return [];
        const { taken } = sumsFor(params[0], j.id);
        const pr = j.perusahaan_id ? perusahaan.get(j.perusahaan_id) : null;
        return [{
          id: j.id, job_code: j.job_code, nama_pekerjaan: j.nama_pekerjaan, perusahaan_id: j.perusahaan_id,
          legacy_id: j.legacy_id, status: j.status, jumlah_order: j.jumlah_order, taken,
          perusahaan_nama: pr ? pr.nama : null,
        }];
      }
      if (/SELECT id, job_id, quantity FROM yans_storages WHERE user_id = \$1 AND legacy_id = \$2/.test(t)) {
        const r = [...storages.values()].find((s) => s.user_id === params[0] && s.legacy_id === params[1] && !s.deleted_at);
        return r ? [{ id: r.id, job_id: r.job_id, quantity: r.quantity }] : [];
      }
      if (/INSERT INTO yans_storages/.test(t)) {
        const row = {
          id: nextId.storages++, user_id: params[0], job_id: params[1], quantity: params[2], stored_at: params[3],
          legacy_id: params[4], created_at: now(), updated_at: now(), deleted_at: null,
        };
        storages.set(row.id, row);
        return [storageWithJoins(row)];
      }
      if (/^UPDATE yans_storages\s+SET quantity = \$1, stored_at = \$2, updated_at = now\(\)\s+WHERE id = \$3 AND user_id = \$4/.test(t)) {
        const r = storages.get(params[2]);
        if (!r || r.user_id !== params[3]) return [];
        r.quantity = params[0]; r.stored_at = params[1]; r.updated_at = now();
        return [storageWithJoins(r)];
      }
      if (/FROM yans_storages s\s+JOIN yans_pekerjaan p ON p\.id = s\.job_id/.test(t)) {
        const out = [...storages.values()].filter((s) => s.user_id === params[0] && !s.deleted_at);
        const jobFiltered = params[1] !== undefined ? out.filter((s) => s.job_id === params[1]) : out;
        return jobFiltered.sort((a, b) => b.id - a.id).slice(0, 500).map(storageWithJoins);
      }

      throw new Error("SQL emulator: unsupported statement: " + t.slice(0, 140));
    },
  };
}

// The pickup row returned by INSERT/UPDATE includes job joins (same shape the
// real pg driver produces after the JOIN-less RETURNING + availability lookup).
function pickupWithJoins(r) {
  return r;
}

function req(method, body, token, url = "https://yans.test/api/storages") {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", "Bearer " + token);
  return { method, headers, url, json: async () => body };
}

async function register(auth, name, username) {
  const res = await auth(req("POST", { action: "register", name, username, password: "rahasia123" }, null, "https://yans.test/api/auth"));
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

async function createJob(jobs, token, perusahaanId, kode, jumlahOrder) {
  const res = await jobs(req("POST", {
    kodePekerjaan: kode, perusahaanId, jumlahOrder, harga: 10000,
  }, token, "https://yans.test/api/jobs"));
  assert.equal(res.status, 201);
  return (await res.json()).job;
}

test("Phase 4 storages: klop validation, pickup-first, isolation, history, edit", async () => {
  _useTestDriver(makeDriver());
  await runMigrations();
  await runMigrations(); // idempotent

  const auth = authMod.default;
  const sync = syncMod.default;
  const jobs = jobsMod.default;
  const pickups = pickupsMod.default;
  const storages = storagesMod.default;

  const tokenA = await register(auth, "Pemilik A", "pemilik_a");
  const tokenB = await register(auth, "Pemilik B", "pemilik_b");

  // Master perusahaan masing-masing user
  let res = await sync(req("POST", { kind: "perusahaan", items: [{ nama: "PT ABC" }] }, tokenA, "https://yans.test/api/sync"));
  assert.equal(res.status, 200);
  const perusahaanIdA = (await res.json()).items[0].id;
  res = await sync(req("POST", { kind: "perusahaan", items: [{ nama: "PT XYZ" }] }, tokenB, "https://yans.test/api/sync"));
  assert.equal(res.status, 200);
  const perusahaanIdB = (await res.json()).items[0].id;

  const jobA = await createJob(jobs, tokenA, perusahaanIdA, "JOB-100", 100);
  const jobB = await createJob(jobs, tokenB, perusahaanIdB, "JOB-B", 75);
  const jobC = await createJob(jobs, tokenA, perusahaanIdA, "JOB-C", 50); // never picked up

  // --- unauthenticated ditolak ---
  res = await storages(req("GET", null, null));
  assert.equal(res.status, 401);
  res = await storages(req("POST", { jobId: jobA.id, quantity: 10 }, null));
  assert.equal(res.status, 401);

  // --- Storan tanpa Ambil Jahit ditolak (jobC belum pernah diambil) ---
  res = await storages(req("POST", { jobId: jobC.id, quantity: 10 }, tokenA));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "not_found");

  // --- Flow spec: 100 total -> ambil 40 -> belum stor 40 ---
  res = await pickups(req("POST", { jobId: jobA.id, quantity: 40, pickedUpAt: "2026-09-22", tukang: "Pak Budi", jenis: "Jahit" }, tokenA));
  assert.equal(res.status, 201);

  res = await storages(req("GET", null, tokenA, "https://yans.test/api/storages?storable=1"));
  assert.equal(res.status, 200);
  let body = await res.json();
  let entry = body.items.find((j) => j.jobId === jobA.id);
  assert.ok(entry, "job yang sudah diambil harus muncul di daftar storable");
  assert.equal(entry.totalQuantity, 100);
  assert.equal(entry.takenQuantity, 40);
  assert.equal(entry.storedQuantity, 0);
  assert.equal(entry.notStoredQuantity, 40);

  // Job milik user lain dan job yang belum diambil tidak boleh muncul
  assert.equal(body.items.find((j) => j.jobId === jobB.id), undefined);
  assert.equal(body.items.find((j) => j.jobId === jobC.id), undefined);

  // --- Stor 15: total 100 / diambil 40 / stor 15 / belum 25 ---
  res = await storages(req("POST", { jobId: jobA.id, quantity: 15, storedAt: "2026-09-22" }, tokenA));
  assert.equal(res.status, 201);
  body = await res.json();
  assert.equal(body.storage.quantity, 15);
  assert.equal(body.storage.jobCode, "JOB-100");
  assert.equal(body.storage.perusahaanNama, "PT ABC");
  assert.equal(body.job.takenQuantity, 40);
  assert.equal(body.job.storedQuantity, 15);
  assert.equal(body.job.notStoredQuantity, 25);
  const storage1 = body.storage.id;

  // --- Storable list: masih tampil dengan belum 25 ---
  res = await storages(req("GET", null, tokenA, "https://yans.test/api/storages?storable=1"));
  body = await res.json();
  entry = body.items.find((j) => j.jobId === jobA.id);
  assert.ok(entry, "job dengan sisa belum stor harus tampil");
  assert.equal(entry.notStoredQuantity, 25);

  // --- Over-store: 26 dari 25 -> 409, DB tidak berubah ---
  res = await storages(req("POST", { jobId: jobA.id, quantity: 26 }, tokenA));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "insufficient_storable_quantity");
  res = await storages(req("GET", null, tokenA, "https://yans.test/api/storages?storable=1&jobId=" + jobA.id));
  assert.equal((await res.json()).job.storedQuantity, 15); // tetap

  // --- Stor 25 (pas): belum stor jadi 0, keluar dari daftar storable ---
  res = await storages(req("POST", { jobId: jobA.id, quantity: 25 }, tokenA));
  assert.equal(res.status, 201);
  body = await res.json();
  assert.equal(body.job.storedQuantity, 40);
  assert.equal(body.job.notStoredQuantity, 0);

  res = await storages(req("GET", null, tokenA, "https://yans.test/api/storages?storable=1"));
  body = await res.json();
  assert.equal(body.items.find((j) => j.jobId === jobA.id), undefined, "job lunas tidak lagi storable");

  // --- Stor 1 lagi -> 409 (semua sudah distor) ---
  res = await storages(req("POST", { jobId: jobA.id, quantity: 1 }, tokenA));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "insufficient_storable_quantity");

  // --- Validasi quantity ---
  for (const bad of [0, -1, 10.5, "abc", "", null, undefined, "1.5", Number.MAX_SAFE_INTEGER + 1]) {
    res = await storages(req("POST", { jobId: jobA.id, quantity: bad }, tokenA));
    assert.equal(res.status, 400, "quantity " + JSON.stringify(bad) + " harus ditolak");
    const err = (await res.json()).error;
    assert.ok(err === "invalid_quantity" || err === "invalid_input", "kode error konsisten: " + err);
  }

  // --- jobId tidak valid / tidak ada ---
  res = await storages(req("POST", { jobId: 999999, quantity: 5 }, tokenA));
  assert.equal(res.status, 404);
  res = await storages(req("POST", { quantity: 5 }, tokenA));
  assert.equal(res.status, 400);

  // --- Ownership isolation: job milik B ditolak walau ID diketahui ---
  res = await storages(req("POST", { jobId: jobB.id, quantity: 5 }, tokenA));
  assert.equal(res.status, 404);
  res = await storages(req("GET", null, tokenA, "https://yans.test/api/storages?storable=1&jobId=" + jobB.id));
  assert.equal(res.status, 404);
  res = await storages(req("GET", null, tokenA, "https://yans.test/api/storages?storable=1&jobId=" + jobC.id));
  assert.equal(res.status, 404, "job tanpa pickup tidak boleh terlihat storable");

  // B melakukan pickup lalu stor; riwayat A dan B terisolasi
  res = await pickups(req("POST", { jobId: jobB.id, quantity: 25 }, tokenB));
  assert.equal(res.status, 201);
  res = await storages(req("POST", { jobId: jobB.id, quantity: 10 }, tokenB));
  assert.equal(res.status, 201);

  res = await storages(req("GET", null, tokenA, "https://yans.test/api/storages"));
  const histA = (await res.json()).items;
  assert.equal(histA.length, 2); // 15 + 25 milik A saja
  assert.ok(histA.every((s) => s.jobId === jobA.id));
  res = await storages(req("GET", null, tokenB, "https://yans.test/api/storages"));
  const histB = (await res.json()).items;
  assert.equal(histB.length, 1);
  assert.equal(histB[0].jobId, jobB.id);
  assert.equal(histB[0].perusahaanNama, "PT XYZ");

  // --- Riwayat tercatat lengkap (tanggal, pekerjaan, perusahaan, jumlah) ---
  res = await storages(req("GET", null, tokenA, "https://yans.test/api/storages"));
  body = await res.json();
  const s1 = body.items.find((x) => x.id === storage1);
  assert.ok(s1, "transaksi stor pertama ada di riwayat");
  assert.equal(s1.quantity, 15);
  assert.equal(s1.jobCode, "JOB-100");
  assert.equal(s1.perusahaanNama, "PT ABC");
  assert.equal(String(s1.storedAt).slice(0, 10), "2026-09-22");

  // --- Edit (legacy id): update in place, old qty kembali ke pool sebelum validasi ---
  res = await storages(req("POST", { jobId: jobB.id, quantity: 5, legacyId: 888 }, tokenB));
  assert.equal(res.status, 201);
  // B: taken 25, stored 10+5=15, notStored 10. Edit legacy 5 -> 10: ceiling 10+5=15, pas.
  res = await storages(req("POST", { jobId: jobB.id, quantity: 10, legacyId: 888 }, tokenB));
  assert.equal(res.status, 200); // updated
  body = await res.json();
  assert.equal(body.storage.quantity, 10);
  assert.equal(body.job.takenQuantity, 25);
  assert.equal(body.job.storedQuantity, 20);
  assert.equal(body.job.notStoredQuantity, 5);
  // Reduksi ke 6 valid (old qty kembali ke pool)...
  res = await storages(req("POST", { jobId: jobB.id, quantity: 6, legacyId: 888 }, tokenB));
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.storage.quantity, 6);
  assert.equal(body.job.storedQuantity, 16);
  assert.equal(body.job.notStoredQuantity, 9);
  // ...edit melebihi ceiling (notStored 9 + old 6 = 15) -> 409
  res = await storages(req("POST", { jobId: jobB.id, quantity: 16, legacyId: 888 }, tokenB));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "insufficient_storable_quantity");
  // legacyId milik B menunjuk job lain -> 409 (guard integritas)
  res = await jobs(req("POST", { kodePekerjaan: "JOB-B2", perusahaanId: perusahaanIdB, jumlahOrder: 10, harga: 1000 }, tokenB, "https://yans.test/api/jobs"));
  assert.equal(res.status, 201);
  const jobB2 = (await res.json()).job;
  res = await pickups(req("POST", { jobId: jobB2.id, quantity: 5 }, tokenB));
  assert.equal(res.status, 201);
  res = await storages(req("POST", { jobId: jobB2.id, quantity: 3, legacyId: 888 }, tokenB));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "duplicate_legacy");
  // legacyId space per-user: A bebas memakai legacyId 888 untuk job miliknya.
  // jobA sudah lunas (notStored 0) -> insert baru ditolak 409, bukan duplikat.
  res = await storages(req("POST", { jobId: jobA.id, quantity: 1, legacyId: 888 }, tokenA));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "insufficient_storable_quantity");
});

test("Phase 4 storages: concurrent double submission tidak over-store", async () => {
  _useTestDriver(makeDriver());
  await runMigrations();

  const auth = authMod.default;
  const sync = syncMod.default;
  const jobs = jobsMod.default;
  const pickups = pickupsMod.default;
  const storages = storagesMod.default;

  const tokenA = await register(auth, "Owner C", "owner_c");
  let res = await sync(req("POST", { kind: "perusahaan", items: [{ nama: "PT Concurrent" }] }, tokenA, "https://yans.test/api/sync"));
  const pid = (await res.json()).items[0].id;
  const job = await createJob(jobs, tokenA, pid, "JOB-CONC", 10);
  res = await pickups(req("POST", { jobId: job.id, quantity: 10 }, tokenA));
  assert.equal(res.status, 201);

  // Dua request "bersamaan": belum_distor=10, A=10, B=10. Persis satu boleh lolos.
  const results = await Promise.all([
    storages(req("POST", { jobId: job.id, quantity: 10 }, tokenA)),
    storages(req("POST", { jobId: job.id, quantity: 10 }, tokenA)),
  ]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409], "persis satu request sukses, satunya ditolak: " + JSON.stringify(statuses));
  const ok = results.find((r) => r.status === 201);
  const okBody = await ok.json();
  assert.equal(okBody.job.storedQuantity, 10);
  assert.equal(okBody.job.notStoredQuantity, 0);

  // Tidak ada duplikat: riwayat hanya 1 transaksi
  res = await storages(req("GET", null, tokenA, "https://yans.test/api/storages"));
  assert.equal((await res.json()).items.length, 1);
});

test("HTTP routing: /api/storages terdaftar dan auth berjalan", async () => {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(base + "/api/storages");
    assert.equal(res.status, 401); // routing OK, auth menolak
    res = await fetch(base + "/api/storages?storable=1");
    assert.equal(res.status, 401);
    res = await fetch(base + "/api/storages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: 1, quantity: 1 }),
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
