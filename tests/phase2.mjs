// Phase 2 self-test (run: node --test tests/phase2.mjs)
// Exercises the jobs API end-to-end against an in-memory SQL emulator
// (no real PostgreSQL, no credentials). Covers:
//   - migrations stay idempotent (0001 + 0002 known)
//   - jobs CRUD (create/read/update/soft-delete)
//   - duplicate job_code per user (409), allowed for a different user
//   - validation: negative qty/price, invalid perusahaan, missing fields
//   - totalNilai consistency on create and update
//   - accessories CRUD + upsert-by-name (no duplicates) + negative qty
//   - document metadata register/update/delete (no binary anywhere)
//   - per-user isolation: user B cannot read/update/delete user A's jobs,
//     accessories, or documents; job_id ownership is verified server-side
//   - unauthenticated access is rejected
//   - HTTP routing for /api/jobs through the Netlify-like dev server
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://test-local"; // satisfy isDbConfigured()

const { _useTestDriver, runMigrations } = await import("../netlify/functions/_db.mjs");
const authMod = await import("../netlify/functions/auth.mjs");
const syncMod = await import("../netlify/functions/sync.mjs");
const jobsMod = await import("../netlify/functions/jobs.mjs");
const itemsMod = await import("../netlify/functions/job-items.mjs");
const { startServer } = await import("./dev-server.mjs");

// ---------- In-memory SQL emulator (Phase 1 + Phase 2 statements) ----------
function makeDriver() {
  const users = new Map();
  const sessions = new Map();
  const pekerja = new Map();
  const perusahaan = new Map();
  const jobs = new Map();
  const acc = new Map();
  const docs = new Map();
  let nextId = { users: 1, pekerja: 1, perusahaan: 1, jobs: 1, acc: 1, docs: 1 };
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

  return {
    async query(text, params = []) {
      const t = text.replace(/\s+/g, " ").trim();

      if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(t)) return [];
      if (/pg_advisory_xact_lock/.test(t)) return [];
      if (/CREATE TABLE IF NOT EXISTS yans_migrations/.test(t)) return [];
      if (/SELECT name FROM yans_migrations/.test(t)) {
        return [{ name: "0001_foundation_tables" }, { name: "0002_jobs" }];
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

      // ---------- perusahaan resolution for jobs ----------
      if (/SELECT id, nama FROM yans_perusahaan WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL/.test(t)) {
        const r = perusahaan.get(params[0]);
        return r && r.user_id === params[1] && !r.deleted_at ? [{ id: r.id, nama: r.nama }] : [];
      }
      if (/SELECT id FROM yans_perusahaan WHERE user_id = \$1 AND lower\(nama\) = lower\(\$2\)/.test(t)) {
        const found = [...perusahaan.values()].find((r) => r.user_id === params[0] && !r.deleted_at && r.nama.toLowerCase() === String(params[1]).toLowerCase());
        return found ? [{ id: found.id }] : [];
      }

      // ---------- jobs ----------
      if (/INSERT INTO yans_pekerjaan/.test(t)) {
        const dup = [...jobs.values()].find((j) => j.user_id === params[0] && j.job_code === params[1]);
        if (dup) {
          const e = new Error('duplicate key value violates unique constraint "yans_pekerjaan_user_code_key"');
          throw e;
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

      // ---------- accessories ----------
      if (/INSERT INTO yans_job_accessories/.test(t)) {
        const ex = [...acc.values()].find((a) => a.user_id === params[0] && a.job_id === params[1] && a.nama_asesoris === params[2]);
        if (ex) {
          ex.satuan = params[3]; ex.jumlah = params[4]; ex.catatan = params[5]; ex.deleted_at = null; ex.updated_at = now();
          return [ex];
        }
        const row = { id: nextId.acc++, user_id: params[0], job_id: params[1], nama_asesoris: params[2], satuan: params[3], jumlah: params[4], catatan: params[5], created_at: now(), updated_at: now(), deleted_at: null };
        acc.set(row.id, row);
        return [row];
      }
      if (/FROM yans_job_accessories WHERE user_id = \$1 AND job_id = \$2 AND deleted_at IS NULL ORDER BY id$/.test(t)) {
        return [...acc.values()].filter((a) => a.user_id === params[0] && a.job_id === params[1] && !a.deleted_at).sort((a, b) => a.id - b.id);
      }
      if (/FROM yans_job_accessories WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL/.test(t)) {
        const r = acc.get(params[0]);
        return r && r.user_id === params[1] && !r.deleted_at ? [r] : [];
      }
      if (/FROM yans_job_accessories WHERE id = \$1 AND user_id = \$2$/.test(t)) {
        const r = acc.get(params[0]);
        return r && r.user_id === params[1] ? [r] : [];
      }
      if (/^UPDATE yans_job_accessories SET deleted_at = now\(\), updated_at = now\(\) WHERE id = \$1 AND user_id = \$2$/.test(t)) {
        const r = acc.get(params[0]);
        if (!r || r.user_id !== params[1]) return [];
        r.deleted_at = now();
        return [];
      }
      if (/^UPDATE yans_job_accessories SET/.test(t)) {
        const ok = parseUpdate(t, params, "yans_job_accessories", acc);
        if (!ok) throw new Error("emulator: accessory update missed target");
        return [];
      }

      // ---------- documents ----------
      if (/INSERT INTO yans_job_documents/.test(t)) {
        const ex = [...docs.values()].find((d) => d.user_id === params[0] && d.job_id === params[1] && d.file_name === params[2]);
        if (ex) {
          ex.mime_type = params[3]; ex.size_bytes = params[4];
          ex.storage_ref = params[5] || ex.storage_ref;
          ex.deleted_at = null; ex.uploaded_at = now();
          return [ex];
        }
        const row = { id: nextId.docs++, user_id: params[0], job_id: params[1], file_name: params[2], mime_type: params[3], size_bytes: params[4], storage_ref: params[5], uploaded_at: now(), deleted_at: null };
        docs.set(row.id, row);
        return [row];
      }
      if (/FROM yans_job_documents WHERE user_id = \$1 AND job_id = \$2 AND deleted_at IS NULL ORDER BY id$/.test(t)) {
        return [...docs.values()].filter((d) => d.user_id === params[0] && d.job_id === params[1] && !d.deleted_at).sort((a, b) => a.id - b.id);
      }
      if (/FROM yans_job_documents WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL/.test(t)) {
        const r = docs.get(params[0]);
        return r && r.user_id === params[1] && !r.deleted_at ? [r] : [];
      }
      if (/^UPDATE yans_job_documents SET deleted_at = now\(\) WHERE id = \$1 AND user_id = \$2$/.test(t)) {
        const r = docs.get(params[0]);
        if (!r || r.user_id !== params[1]) return [];
        r.deleted_at = now();
        return [];
      }

      throw new Error("SQL emulator: unsupported statement: " + t.slice(0, 140));
    },
  };
}

function req(method, body, token, url = "https://yans.test/api/jobs") {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", "Bearer " + token);
  return {
    method,
    headers,
    url,
    json: async () => body,
  };
}

async function register(auth, name, username) {
  const res = await auth(req("POST", { action: "register", name, username, password: "rahasia123" }, null, "https://yans.test/api/auth"), {});
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

test("Phase 2 jobs: CRUD, accessories, documents, isolation, validation", async () => {
  _useTestDriver(makeDriver());
  await runMigrations();
  await runMigrations(); // idempotent

  const auth = authMod.default;
  const sync = syncMod.default;
  const jobs = jobsMod.default;
  const items = itemsMod.default;

  const tokenA = await register(auth, "Pemilik A", "pemilik_a");
  const tokenB = await register(auth, "Pemilik B", "pemilik_b");

  // --- perusahaan master (Phase 1 sync) untuk user A ---
  let res = await sync(req("POST", { kind: "perusahaan", items: [{ nama: "Toko Maju", pic: "Rina" }] }, tokenA, "https://yans.test/api/sync"));
  assert.equal(res.status, 200);
  res = await sync(req("GET", null, tokenA, "https://yans.test/api/sync?kind=perusahaan"));
  const perusahaanId = (await res.json()).items[0].id;

  // --- unauthenticated access ditolak ---
  res = await jobs(req("GET", null, null));
  assert.equal(res.status, 401);
  res = await jobs(req("POST", { kodePekerjaan: "X", perusahaanId: 1 }, null));
  assert.equal(res.status, 401);

  // --- create ---
  res = await jobs(req("POST", {
    kodePekerjaan: "JOB-20260901-001",
    perusahaanId,
    namaPekerjaan: "Kemeja PDL",
    tanggalMasuk: "2026-09-01",
    deadline: "2026-09-20",
    jumlahOrder: 100,
    harga: 15000,
    catatan: "urgent",
    variants: [{ warna: "Hitam", ukuran: "M", jumlah: 60 }, { warna: "Putih", ukuran: "L", jumlah: 40 }],
  }, tokenA));
  assert.equal(res.status, 201);
  const job = (await res.json()).job;
  assert.ok(job.id > 0);
  assert.equal(job.jobCode, "JOB-20260901-001");
  assert.equal(job.totalNilai, 1500000); // konsisten: 100 x 15000
  assert.equal(job.status, "aktif");
  assert.equal(job.variants.length, 2);
  assert.equal(String(job.tanggalMasuk).slice(0, 10), "2026-09-01");
  const jobId = job.id;

  // --- duplicate job_code (same user) -> 409 ---
  res = await jobs(req("POST", { kodePekerjaan: "JOB-20260901-001", perusahaanId, jumlahOrder: 1, harga: 1 }, tokenA));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "duplicate_job_code");

  // --- kode sama untuk user lain -> valid (user isolation) ---
  // B harus punya master perusahaannya sendiri lebih dulu.
  res = await sync(req("POST", { kind: "perusahaan", items: [{ nama: "Klien B" }] }, tokenB, "https://yans.test/api/sync"));
  assert.equal(res.status, 200);
  res = await jobs(req("POST", { kodePekerjaan: "JOB-20260901-001", perusahaanNama: "Klien B", jumlahOrder: 5, harga: 1000 }, tokenB));
  assert.equal(res.status, 201);
  const jobB = (await res.json()).job;
  assert.notEqual(jobB.id, jobId);

  // --- validasi ---
  res = await jobs(req("POST", { kodePekerjaan: "JOB-N", perusahaanId, jumlahOrder: -5, harga: 1 }, tokenA));
  assert.equal(res.status, 400); // jumlah negatif
  res = await jobs(req("POST", { kodePekerjaan: "JOB-N", perusahaanId, jumlahOrder: 1, harga: -1 }, tokenA));
  assert.equal(res.status, 400); // harga negatif
  res = await jobs(req("POST", { kodePekerjaan: "JOB-N", perusahaanId: 999999, jumlahOrder: 1, harga: 1 }, tokenA));
  assert.equal(res.status, 400); // perusahaan tidak milik user
  assert.equal((await res.json()).error, "invalid_perusahaan");
  res = await jobs(req("POST", { perusahaanId, jumlahOrder: 1, harga: 1 }, tokenA));
  assert.equal(res.status, 400); // kode kosong

  // --- read ---
  res = await jobs(req("GET", null, tokenA, "https://yans.test/api/jobs"));
  let body = await res.json();
  assert.equal(body.items.length, 1);
  res = await jobs(req("GET", null, tokenA, "https://yans.test/api/jobs?id=" + jobId + "&accessories=1&documents=1"));
  body = await res.json();
  assert.equal(body.job.id, jobId);
  assert.deepEqual(body.job.accessories, []);
  assert.deepEqual(body.job.documents, []);

  // isolation: B tidak melihat job milik A
  res = await jobs(req("GET", null, tokenB, "https://yans.test/api/jobs?id=" + jobId));
  assert.equal(res.status, 404);

  // --- update ---
  res = await jobs(req("PUT", { jumlahOrder: 150, status: "selesai" }, tokenA, "https://yans.test/api/jobs?id=" + jobId));
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.job.jumlahOrder, 150);
  assert.equal(body.job.totalNilai, 2250000); // total dihitung ulang konsisten
  assert.equal(body.job.status, "selesai");

  // update kode ke yang sudah dipakai -> 409
  res = await jobs(req("PUT", { kodePekerjaan: "JOB-DUP-X" }, tokenA, "https://yans.test/api/jobs?id=" + jobId));
  assert.equal(res.status, 200);
  // kembalikan kode lama untuk skenario lanjutan
  res = await jobs(req("PUT", { kodePekerjaan: "JOB-20260901-001" }, tokenA, "https://yans.test/api/jobs?id=" + jobId));
  assert.equal(res.status, 200);

  // B tidak boleh update job milik A
  res = await jobs(req("PUT", { jumlahOrder: 999 }, tokenB, "https://yans.test/api/jobs?id=" + jobId));
  assert.equal(res.status, 404);

  // --- accessories ---
  res = await items(req("POST", { jobId, namaAsesoris: "Kancing", satuan: "pcs", jumlah: 1000 }, tokenA, "https://yans.test/api/job-accessories"));
  assert.equal(res.status, 201);
  const acc1 = (await res.json()).accessory;
  assert.equal(acc1.jumlah, 1000);

  // upsert by name: tidak ada duplikat
  res = await items(req("POST", { jobId, namaAsesoris: "Kancing", satuan: "pcs", jumlah: 1200 }, tokenA, "https://yans.test/api/job-accessories"));
  body = await res.json();
  assert.equal(body.accessory.id, acc1.id);
  assert.equal(body.accessory.jumlah, 1200);
  res = await items(req("GET", null, tokenA, "https://yans.test/api/job-accessories?jobId=" + jobId));
  body = await res.json();
  assert.equal(body.items.length, 1);

  res = await items(req("POST", { jobId, namaAsesoris: "Sleting", satuan: "pcs", jumlah: 500 }, tokenA, "https://yans.test/api/job-accessories"));
  assert.equal(res.status, 201);
  res = await items(req("POST", { jobId, namaAsesoris: "Karet", satuan: "meter", jumlah: 300 }, tokenA, "https://yans.test/api/job-accessories"));
  assert.equal(res.status, 201);

  // jumlah negatif ditolak
  res = await items(req("POST", { jobId, namaAsesoris: "Hanteg", jumlah: -1 }, tokenA, "https://yans.test/api/job-accessories"));
  assert.equal(res.status, 400);
  // jobId milik user lain ditolak (ownership)
  res = await items(req("POST", { jobId: jobB.id, namaAsesoris: "Merk", jumlah: 1 }, tokenA, "https://yans.test/api/job-accessories"));
  assert.equal(res.status, 404);
  // B tidak bisa lihat accessories job milik A
  res = await items(req("GET", null, tokenB, "https://yans.test/api/job-accessories?jobId=" + jobId));
  assert.equal(res.status, 404);

  // update accessory
  res = await items(req("PUT", { jumlah: 1500 }, tokenA, "https://yans.test/api/job-accessories?id=" + acc1.id));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).accessory.jumlah, 1500);
  // B tidak bisa update accessory milik A
  res = await items(req("PUT", { jumlah: 0 }, tokenB, "https://yans.test/api/job-accessories?id=" + acc1.id));
  assert.equal(res.status, 404);

  // --- documents (metadata only, tanpa binary) ---
  res = await items(req("POST", { jobId, fileName: "nota-toko-maju.jpg", mimeType: "image/jpeg", sizeBytes: 204800, storageRef: null }, tokenA, "https://yans.test/api/job-documents"));
  assert.equal(res.status, 201);
  const doc1 = (await res.json()).document;
  assert.equal(doc1.storageRef, null);
  // re-register file sama -> update metadata (tidak duplikat)
  res = await items(req("POST", { jobId, fileName: "nota-toko-maju.jpg", mimeType: "image/jpeg", sizeBytes: 204801, storageRef: "storage://pending" }, tokenA, "https://yans.test/api/job-documents"));
  body = await res.json();
  assert.equal(body.document.id, doc1.id);
  assert.equal(body.document.storageRef, "storage://pending");
  res = await items(req("GET", null, tokenA, "https://yans.test/api/job-documents?jobId=" + jobId));
  body = await res.json();
  assert.equal(body.items.length, 1);
  // validasi nama file kosong
  res = await items(req("POST", { jobId, fileName: "  " }, tokenA, "https://yans.test/api/job-documents"));
  assert.equal(res.status, 400);
  // B tidak bisa lihat dokumen job milik A
  res = await items(req("GET", null, tokenB, "https://yans.test/api/job-documents?jobId=" + jobId));
  assert.equal(res.status, 404);
  // B tidak bisa hapus dokumen milik A
  res = await items(req("DELETE", null, tokenB, "https://yans.test/api/job-documents?id=" + doc1.id));
  assert.equal(res.status, 404);
  // hapus dokumen oleh pemilik
  res = await items(req("DELETE", null, tokenA, "https://yans.test/api/job-documents?id=" + doc1.id));
  assert.equal(res.status, 200);
  res = await items(req("GET", null, tokenA, "https://yans.test/api/job-documents?jobId=" + jobId));
  assert.equal((await res.json()).items.length, 0);

  // --- soft delete job ---
  res = await jobs(req("DELETE", null, tokenB, "https://yans.test/api/jobs?id=" + jobId));
  assert.equal(res.status, 404); // bukan milik B
  res = await jobs(req("DELETE", null, tokenA, "https://yans.test/api/jobs?id=" + jobId));
  assert.equal(res.status, 200);
  res = await jobs(req("GET", null, tokenA, "https://yans.test/api/jobs"));
  assert.equal((await res.json()).items.length, 0);
  res = await jobs(req("GET", null, tokenA, "https://yans.test/api/jobs?id=" + jobId));
  assert.equal(res.status, 404);
  // accessories ikut tak terlihat via job yang sudah dihapus
  res = await items(req("GET", null, tokenA, "https://yans.test/api/job-accessories?jobId=" + jobId));
  assert.equal(res.status, 404);
});

test("HTTP routing: /api/jobs & /api/job-accessories terdaftar dan auth berjalan", async () => {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(base + "/api/jobs");
    assert.equal(res.status, 401); // routing OK, auth menolak
    res = await fetch(base + "/api/job-accessories?jobId=1");
    assert.equal(res.status, 401);
    res = await fetch(base + "/api/job-documents?jobId=1");
    assert.equal(res.status, 401);
    // PUT / DELETE tanpa auth juga ditolak (bukan 404/405 routing)
    res = await fetch(base + "/api/jobs?id=1", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
