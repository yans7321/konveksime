// Phase 7 self-test (run: node --test tests/phase7.mjs)
// Exercises the shipments (Kiriman Barang) API end-to-end against an in-memory
// SQL emulator (no real PostgreSQL, no credentials). Covers:
//   - shippable snapshot: order-based remaining quantity (order - shipped)
//   - flow: order 100 -> ship 60 -> ship 25 -> over-ship 20 -> REJECT 409
//           with order/shipped/sisa payload
//   - edit (legacyId = server id convention of the bridge) refunds the old
//     shipment total before re-validating
//   - legacy upsert: same legacyId updates in place, no duplicate rows
//   - validation: penerima/variants/tanggal/status rejected, foto metadata only
//   - ownership isolation: foreign shipment/job -> 404; history isolated
//   - unauthenticated -> 401; unknown id -> 404
//   - HTTP routing through the Netlify-like dev server
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://test-local"; // satisfy isDbConfigured()

const { _useTestDriver } = await import("../netlify/functions/_db.mjs");
const authMod = await import("../netlify/functions/auth.mjs");
const syncMod = await import("../netlify/functions/sync.mjs");
const jobsMod = await import("../netlify/functions/jobs.mjs");
const shipmentsMod = await import("../netlify/functions/shipments.mjs");
const { startServer } = await import("./dev-server.mjs");

// ---------- In-memory SQL emulator (Phase 1+2+7 statements) ----------
function makeDriver() {
  const users = new Map();
  const sessions = new Map();
  const perusahaan = new Map();
  const jobs = new Map();
  const shipments = new Map();
  let nextId = { users: 1, perusahaan: 1, jobs: 1, shipments: 1 };
  const now = () => new Date();
  const parseJson = (v) => (typeof v === "string" ? JSON.parse(v) : v);

  function shippedOf(userId, jobId) {
    let total = 0;
    for (const s of shipments.values()) {
      if (s.user_id !== userId || s.job_id !== jobId || s.deleted_at) continue;
      const arr = parseJson(s.variants) || [];
      for (const v of arr) total += Number(v.jumlah) || 0;
    }
    return total;
  }

  return {
    async query(text, params = []) {
      const t = text.replace(/\s+/g, " ").trim();

      if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(t)) return [];
      if (/pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(t)) {
        return new Promise((resolve) => setImmediate(resolve));
      }
      if (/pg_advisory_xact_lock/.test(t)) return [];
      if (/CREATE TABLE IF NOT EXISTS yans_migrations/.test(t)) return [];
      if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/.test(t)) return [];
      if (/SELECT name FROM yans_migrations/.test(t)) {
        return [
          { name: "0001_foundation_tables" }, { name: "0002_jobs" },
          { name: "0003_tailoring_pickups" }, { name: "0004_storages" },
          { name: "0006_ledger_modules" }, { name: "0007_shipments" },
        ];
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
        return [{ id: u.id, username: u.username, email: u.email, name: u.name, provider: u.provider, is_active: true, permissions: u.permissions }];
      }

      // ---------- perusahaan (Phase 1 sync + jobs resolution) ----------
      if (/^SELECT id FROM yans_perusahaan WHERE user_id = \$1 AND lower\(nama\) = lower\(\$2\)/.test(t)) {
        return [...perusahaan.values()]
          .filter((r) => r.user_id === params[0] && r.nama.toLowerCase() === String(params[1]).toLowerCase() && !r.deleted_at)
          .map((r) => ({ id: r.id }));
      }
      if (/^SELECT id, nama FROM yans_perusahaan WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL$/.test(t)) {
        const r = perusahaan.get(params[0]);
        return r && r.user_id === params[1] && !r.deleted_at ? [{ id: r.id, nama: r.nama }] : [];
      }
      if (/INSERT INTO yans_perusahaan/.test(t)) {
        const row = { id: nextId.perusahaan++, user_id: params[0], nama: params[1], pic: params[2], telepon: params[3], catatan: params[4], legacy_id: params[5], created_at: now(), updated_at: now(), deleted_at: null };
        perusahaan.set(row.id, row);
        return [];
      }
      if (/SELECT id, nama, legacy_id AS "legacyId", created_at AS "createdAt", updated_at AS "updatedAt"/.test(t)) {
        return [...perusahaan.values()].filter((r) => r.user_id === params[0] && !r.deleted_at).sort((a, b) => a.id - b.id)
          .map((r) => ({ id: r.id, nama: r.nama, legacyId: r.legacy_id, createdAt: r.created_at, updatedAt: r.updated_at }));
      }
      if (/SELECT id, nama, pic, telepon, catatan, legacy_id AS "legacyId"/.test(t)) {
        return [...perusahaan.values()].filter((r) => r.user_id === params[0] && !r.deleted_at).sort((a, b) => a.id - b.id)
          .map((r) => ({ id: r.id, nama: r.nama, pic: r.pic, telepon: r.telepon, catatan: r.catatan, legacyId: r.legacy_id }));
      }

      // ---------- jobs (Phase 2) — SQL contract ported from tests/phase2.mjs ----------
      if (/INSERT INTO yans_pekerjaan/.test(t)) {
        const row = {
          id: nextId.jobs++, user_id: params[0], job_code: params[1], perusahaan_id: params[2], legacy_id: null,
          nama_pekerjaan: params[3], tanggal_masuk: params[4], deadline: params[5], jumlah_order: params[6],
          harga_per_pcs: params[7], total_nilai: params[8], catatan: params[9], status: params[10],
          variants: params[11], created_at: now(), updated_at: now(), deleted_at: null,
        };
        jobs.set(row.id, row);
        return [{ ...row, variants: parseJson(row.variants) }];
      }
      if (/FROM yans_pekerjaan WHERE user_id = \$1 AND deleted_at IS NULL ORDER BY id DESC/.test(t)) {
        return [...jobs.values()].filter((j) => j.user_id === params[0] && !j.deleted_at).sort((a, b) => b.id - a.id)
          .map((j) => ({ ...j, variants: parseJson(j.variants) }));
      }
      if (/FROM yans_pekerjaan WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL/.test(t)) {
        const r = jobs.get(params[0]);
        return r && r.user_id === params[1] && !r.deleted_at ? [{ ...r, variants: parseJson(r.variants) }] : [];
      }

      // ---------- shipments (Phase 7) ----------
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
      // backfill: legacy_id = id (self-anchor for server-created rows)
      if (/^UPDATE yans_shipments SET legacy_id = id WHERE id = \$1 AND legacy_id IS NULL$/.test(t)) {
        const row = shipments.get(params[0]);
        if (row && row.legacy_id == null) row.legacy_id = row.id;
        return [];
      }
      if (/^UPDATE yans_shipments SET/.test(t)) {
        const wherePart = t.slice(t.indexOf(" WHERE "));
        const idP = Number(wherePart.match(/id = \$(\d+)/)[1]);
        const uP = Number(wherePart.match(/user_id = \$(\d+)/)[1]);
        const row = shipments.get(params[idP - 1]);
        if (!row || row.user_id !== params[uP - 1] || row.deleted_at) return [];
        const setPart = t.slice(t.indexOf(" SET ") + 5, t.indexOf(" WHERE "));
        if (/deleted_at = now\(\)/.test(setPart)) { row.deleted_at = now(); row.updated_at = now(); return [{ id: row.id }]; }
        const re = /(\w+) = \$(\d+)/g; let pm;
        while ((pm = re.exec(setPart)) !== null) {
          if (pm[1] === "updated_at") continue;
          row[pm[1]] = pm[1] === "variants" ? params[Number(pm[2]) - 1] : params[Number(pm[2]) - 1];
        }
        row.updated_at = now();
        return [{ id: row.id }];
      }
      // full-row SELECT after write / history (JOINs)
      if (/^SELECT s\.id, s\.job_id, s\.perusahaan_id, s\.tanggal/.test(t) && /FROM yans_shipments s/.test(t)) {
        const uP = Number(t.match(/user_id = \$(\d+)/)[1]);
        const idP = t.match(/WHERE s\.id = \$(\d+)/);
        let rows = [...shipments.values()].filter((r) => r.user_id === params[uP - 1] && !r.deleted_at);
        if (idP) rows = rows.filter((r) => r.id === params[Number(idP[1]) - 1]);
        else if (/AND s\.job_id = \$2/.test(t)) rows = rows.filter((r) => r.job_id === params[1]);
        rows.sort((a, b) => b.id - a.id);
        if (/LIMIT 500/.test(t)) rows = rows.slice(0, 50);
        return rows.map((r) => {
          const j = r.job_id ? jobs.get(r.job_id) : null;
          const pr = r.perusahaan_id ? perusahaan.get(r.perusahaan_id) : (j && j.perusahaan_id ? perusahaan.get(j.perusahaan_id) : null);
          return { ...r, variants: parseJson(r.variants), job_code: j ? j.job_code : null, nama_pekerjaan: j ? j.nama_pekerjaan : null, perusahaan_nama: pr ? pr.nama : null };
        });
      }
      // shippable snapshot / per-job live info (jsonb SUM)
      if (/jsonb_array_elements/.test(t)) {
        const uP = Number(t.match(/user_id = \$(\d+)/)[1]);
        const idP = t.match(/p\.id = \$(\d+)/);
        let jobRows = [...jobs.values()].filter((r) => r.user_id === params[uP - 1] && !r.deleted_at);
        if (idP) jobRows = jobRows.filter((r) => r.id === params[Number(idP[1]) - 1]);
        const listOnly = /COALESCE\(sh\.shipped, 0\) < p\.jumlah_order/.test(t);
        if (listOnly) {
          jobRows = jobRows.filter((j) => shippedOf(params[uP - 1], j.id) < Number(j.jumlah_order) || 0);
        }
        return jobRows.sort((a, b) => b.id - a.id).map((j) => {
          const pr = j.perusahaan_id ? perusahaan.get(j.perusahaan_id) : null;
          return {
            id: j.id, job_code: j.job_code, nama_pekerjaan: j.nama_pekerjaan, perusahaan_id: j.perusahaan_id,
            legacy_id: j.legacy_id, status: j.status, jumlah_order: j.jumlah_order,
            shipped: shippedOf(params[uP - 1], j.id), perusahaan_nama: pr ? pr.nama : null,
          };
        });
      }

      throw new Error("SQL emulator: unsupported statement: " + t.slice(0, 160));
    },
  };
}

const driver = makeDriver();
_useTestDriver(driver);

function makeReq(method, { body, token, url }) {
  return new Request(url, {
    method,
    headers: Object.assign(
      { "Content-Type": "application/json" },
      token ? { Authorization: "Bearer " + token } : {}
    ),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(username) {
  const res = await authMod.default(makeReq("POST", { url: "https://yans.test/api/auth", body: { action: "register", name: "U", username, password: "password123" } }));
  assert.equal(res.status, 200, "register sukses");
  return (await res.json()).token;
}

async function createJob(token, { code, order }) {
  // Jobs API requires an existing perusahaan master — sync one first (like the
  // app does after sign-in), then create the job referencing it by name.
  const s = await syncMod.default(makeReq("POST", { url: "https://yans.test/api/sync", token, body: { kind: "perusahaan", items: [{ nama: "Klien " + code }] } }));
  assert.equal(s.status, 200, "sync perusahaan sukses: " + s.status);
  const res = await jobsMod.default(makeReq("POST", { url: "https://yans.test/api/jobs", token, body: { kodePekerjaan: code, perusahaanNama: "Klien " + code, jumlahOrder: order, harga: 1000, tanggalMasuk: "2026-09-24", namaPekerjaan: "Model " + code } }));
  assert.equal(res.status, 201, "job create sukses: " + res.status);
  return (await res.json()).job;
}

async function ship(token, body) {
  const res = await shipmentsMod.default(makeReq("POST", { url: "https://yans.test/api/shipments", token, body }));
  return { res, body: await res.json() };
}

// ---------- 1. flow: shippable snapshot + order-based ceiling ----------
test("alur: order 100 -> kirim 60 -> 25 -> over-ship 20 ditolak 409 dengan order/shipped/sisa", async () => {
  const token = await register("p7a_" + Date.now());
  const job = await createJob(token, { code: "J7-A", order: 100 });

  // shippable sebelum kirim
  let res = await shipmentsMod.default(makeReq("GET", { url: "https://yans.test/api/shipments?shippable=1", token }));
  let body = await res.json();
  let info = (body.items || []).find((x) => x.jobId === job.id);
  assert.ok(info, "job muncul di shippable");
  assert.equal(info.orderQuantity, 100);
  assert.equal(info.remainingQuantity, 100);

  // kirim 60
  let r1 = await ship(token, { jobId: job.id, tanggal: "2026-09-24", status: "Selesai", penerima: "Rina", variants: [{ warna: "Merah", ukuran: "L", jumlah: 60 }] });
  assert.equal(r1.res.status, 201, "kirim 60 sukses");
  assert.ok(r1.body.shipment.id);
  assert.equal(r1.body.job.remainingQuantity, 40);
  const dbId = r1.body.shipment.id;

  // kirim 25
  let r2 = await ship(token, { jobId: job.id, tanggal: "2026-09-25", status: "Bahan", penerima: "Rina", variants: [{ warna: "Biru", ukuran: "M", jumlah: 25 }] });
  assert.equal(r2.res.status, 201);
  assert.equal(r2.body.job.remainingQuantity, 15);

  // over-ship 20 (sisa 15) -> 409 + payload
  const r3 = await ship(token, { jobId: job.id, tanggal: "2026-09-26", status: "Selesai", penerima: "Rina", variants: [{ warna: "Kuning", ukuran: "S", jumlah: 20 }] });
  assert.equal(r3.res.status, 409, "over-ship ditolak");
  assert.equal(r3.body.error, "insufficient_shippable_quantity");
  assert.equal(r3.body.order, 100);
  assert.equal(r3.body.shipped, 85);
  assert.equal(r3.body.sisa, 15);

  // tepat di ceiling: kirim 15 -> sukses, sisa 0
  const r4 = await ship(token, { jobId: job.id, tanggal: "2026-09-27", status: "Selesai", penerima: "Rina", variants: [{ warna: "Hijau", ukuran: "XL", jumlah: 15 }] });
  assert.equal(r4.res.status, 201);
  assert.equal(r4.body.job.remainingQuantity, 0);

  // shippable list: job habis -> tidak muncul lagi
  res = await shipmentsMod.default(makeReq("GET", { url: "https://yans.test/api/shipments?shippable=1", token }));
  body = await res.json();
  info = (body.items || []).find((x) => x.jobId === job.id);
  assert.ok(!info, "job penuh keluar dari shippable list");

  // edit row pertama: ubah 60 -> 10 (refund 50, sisa kembali 50)
  const r5 = await ship(token, { jobId: job.id, tanggal: "2026-09-24", status: "Selesai", penerima: "Rina", variants: [{ warna: "Merah", ukuran: "L", jumlah: 10 }], legacyId: dbId });
  assert.equal(r5.res.status, 200, "legacyId edit in-place");
  assert.equal(r5.body.updated, true);
  assert.equal(r5.body.job.remainingQuantity, 50, "refund lama 60, baru 10, sisa 0+50");

  // riwayat lengkap
  res = await shipmentsMod.default(makeReq("GET", { url: "https://yans.test/api/shipments", token }));
  body = await res.json();
  assert.equal(body.items.length, 3, "3 transaksi (60->10, 25, 15)");
  const first = body.items.find((x) => x.id === dbId);
  assert.equal(first.variants.length, 1);
  assert.equal(first.variants[0].jumlah, 10);
});

// ---------- 2. legacy upsert: no duplicates ----------
test("legacyId sama tidak membuat duplikat (upsert in-place)", async () => {
  const token = await register("p7b_" + Date.now());
  const job = await createJob(token, { code: "J7-B", order: 50 });
  const legacyId = 777001;

  const a = await ship(token, { jobId: job.id, tanggal: "2026-09-24", status: "Selesai", penerima: "Budi", variants: [{ warna: "A", ukuran: "", jumlah: 10 }], legacyId });
  assert.equal(a.res.status, 201);
  const b = await ship(token, { jobId: job.id, tanggal: "2026-09-24", status: "Selesai", penerima: "Budi", variants: [{ warna: "A", ukuran: "", jumlah: 20 }], legacyId });
  assert.equal(b.res.status, 200);
  assert.equal(b.body.updated, true);
  assert.equal(b.body.shipment.id, a.body.shipment.id, "row yang sama");

  const res = await shipmentsMod.default(makeReq("GET", { url: "https://yans.test/api/shipments", token }));
  const body = await res.json();
  assert.equal(body.items.length, 1, "tidak ada duplikat");
});

// ---------- 3. validation ----------
test("validasi: penerima kosong, variants tidak valid, tanggal salah, status liar -> 400", async () => {
  const token = await register("p7c_" + Date.now());
  const job = await createJob(token, { code: "J7-C", order: 10 });
  const base = { jobId: job.id, tanggal: "2026-09-24", status: "Selesai", penerima: "X", variants: [{ warna: "A", ukuran: "", jumlah: 1 }] };

  let r = await ship(token, { ...base, penerima: "" });
  assert.equal(r.res.status, 400);
  r = await ship(token, { ...base, variants: [{ jumlah: 0 }] });
  assert.equal(r.res.status, 400);
  r = await ship(token, { ...base, variants: [{ jumlah: 2.5 }] });
  assert.equal(r.res.status, 400);
  r = await ship(token, { ...base, variants: [] });
  assert.equal(r.res.status, 400);
  r = await ship(token, { ...base, tanggal: "24-09-2026" });
  assert.equal(r.res.status, 400);
  r = await ship(token, { ...base, status: "Liar" });
  assert.equal(r.res.status, 400);
  r = await ship(token, { ...base, jobId: 999999 });
  assert.equal(r.res.status, 404, "job tidak ditemukan");
});

// ---------- 4. foto metadata only ----------
test("foto: metadata tersimpan, storage_ref NULL; tanpa foto di edit -> metadata lama dipertahankan", async () => {
  const token = await register("p7d_" + Date.now());
  const job = await createJob(token, { code: "J7-D", order: 30 });
  const legacyId = 888001;

  const a = await ship(token, { jobId: job.id, tanggal: "2026-09-24", status: "Selesai", penerima: "Citra", variants: [{ warna: "A", ukuran: "", jumlah: 5 }], legacyId, fotoName: "bukti.jpg", fotoMimeType: "image/jpeg", fotoSizeBytes: 12345 });
  assert.equal(a.res.status, 201);
  assert.equal(a.body.shipment.foto.fileName, "bukti.jpg");
  assert.equal(a.body.shipment.foto.sizeBytes, 12345);
  assert.equal(a.body.shipment.foto.storageRef, null);

  // edit tanpa foto -> metadata tetap
  const b = await ship(token, { jobId: job.id, tanggal: "2026-09-24", status: "Selesai", penerima: "Citra", variants: [{ warna: "A", ukuran: "", jumlah: 6 }], legacyId });
  assert.equal(b.res.status, 200);
  assert.equal(b.body.shipment.foto.fileName, "bukti.jpg", "metadata lama dipertahankan");
  assert.equal(b.body.shipment.foto.storageRef, null);
});

// ---------- 5. isolation + auth edges ----------
test("isolasi user: shipment/job milik user lain -> 404; unauthenticated 401", async () => {
  const tokenA = await register("p7e_a_" + Date.now());
  const jobA = await createJob(tokenA, { code: "J7-E", order: 10 });
  const a = await ship(tokenA, { jobId: jobA.id, tanggal: "2026-09-24", status: "Selesai", penerima: "A", variants: [{ warna: "A", ukuran: "", jumlah: 5 }] });
  const shipmentA = a.body.shipment.id;

  const tokenB = await register("p7e_b_" + Date.now());
  // B tidak bisa POST ke job milik A
  const rB = await ship(tokenB, { jobId: jobA.id, tanggal: "2026-09-24", status: "Selesai", penerima: "B", variants: [{ warna: "A", ukuran: "", jumlah: 1 }] });
  assert.equal(rB.res.status, 404, "job milik A tidak terlihat B");
  // B tidak bisa lihat/update/delete shipment A
  let res = await shipmentsMod.default(makeReq("GET", { url: "https://yans.test/api/shipments", token: tokenB }));
  assert.equal((await res.json()).items.length, 0, "riwayat B kosong");
  res = await shipmentsMod.default(makeReq("PUT", { url: "https://yans.test/api/shipments", token: tokenB, body: { id: shipmentA, status: "Bahan" } }));
  assert.equal(res.status, 404);
  res = await shipmentsMod.default(makeReq("DELETE", { url: "https://yans.test/api/shipments?id=" + shipmentA, token: tokenB }));
  assert.equal(res.status, 404);
  // DELETE milik A oleh A sukses (soft delete)
  res = await shipmentsMod.default(makeReq("DELETE", { url: "https://yans.test/api/shipments?id=" + shipmentA, token: tokenA }));
  assert.equal(res.status, 200);
  // unauthenticated
  res = await shipmentsMod.default(makeReq("GET", { url: "https://yans.test/api/shipments?shippable=1" }));
  assert.equal(res.status, 401);
  res = await shipmentsMod.default(makeReq("POST", { url: "https://yans.test/api/shipments", body: { jobId: 1, penerima: "x", variants: [{ jumlah: 1 }] } }));
  assert.equal(res.status, 401);
});

// ---------- 6. routing ----------
test("HTTP routing: /api/shipments terdaftar dan auth berjalan", async () => {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(base + "/api/shipments");
    assert.equal(res.status, 401);
    res = await fetch(base + "/api/shipments?shippable=1");
    assert.equal(res.status, 401);
    res = await fetch(base + "/api/shipments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: 1, penerima: "x", variants: [{ jumlah: 1 }] }),
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
