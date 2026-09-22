// Phase 2 — Job management endpoints (session-authenticated):
//   GET    /api/jobs                    -> list (soft-deleted rows excluded)
//   GET    /api/jobs?id=123             -> single job (owner must match)
//   POST   /api/jobs                    -> create
//   PUT    /api/jobs?id=123             -> update
//   DELETE /api/jobs?id=123             -> soft delete
// Query parameter ?accessories=1 / ?documents=1 includes the child collections.
//
// All data access is scoped by user_id resolved from the Bearer session; the
// client can never influence ownership. Every statement is parameterized.
import { isDbConfigured, runMigrations, q, resolveSession } from "./_db.mjs";
import { json, errorResponse, readJson, safeDbError } from "./_http.mjs";

const VALID_STATUS = ["aktif", "selesai", "arsip"];

function cleanStr(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function cleanId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

function cleanNonNegNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function cleanDate(v) {
  // Accepts 'YYYY-MM-DD' (the app's date inputs) -> Date or null.
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}

function cleanVariants(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const raw of v.slice(0, 50)) {
    if (!raw || typeof raw !== "object") continue;
    const warna = cleanStr(raw.warna, 100);
    if (!warna) continue;
    const jumlah = cleanNonNegNum(raw.jumlah);
    if (jumlah === null) continue;
    out.push({ warna, ukuran: cleanStr(raw.ukuran ?? raw.size, 50), jumlah });
  }
  return out;
}

function roundMoney(n) {
  return Math.round(n * 100) / 100;
}

function rowToJob(r) {
  return {
    id: r.id,
    jobCode: r.job_code,
    perusahaanId: r.perusahaan_id,
    legacyId: r.legacy_id,
    namaPekerjaan: r.nama_pekerjaan,
    tanggalMasuk: r.tanggal_masuk,
    deadline: r.deadline,
    jumlahOrder: r.jumlah_order,
    hargaPerPcs: Number(r.harga_per_pcs),
    totalNilai: Number(r.total_nilai),
    catatan: r.catatan,
    status: r.status,
    variants: r.variants || [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToAccessory(r) {
  return {
    id: r.id,
    jobId: r.job_id,
    namaAsesoris: r.nama_asesoris,
    satuan: r.satuan,
    jumlah: Number(r.jumlah),
    catatan: r.catatan,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToDocument(r) {
  return {
    id: r.id,
    jobId: r.job_id,
    fileName: r.file_name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    storageRef: r.storage_ref,
    uploadedAt: r.uploaded_at,
  };
}

// Validates and normalizes the mutable job payload. Returns { ok, value|error }.
function validateJobPayload(body, { partial = false } = {}) {
  const out = {};
  if (partial && body.kodePekerjaan === undefined && body.namaPekerjaan === undefined && body.perusahaanId === undefined) {
    // nothing mandatory in a partial update — fall through to optional fields
  }
  const has = (k) => body[k] !== undefined;

  if (has("kodePekerjaan")) {
    const kode = cleanStr(body.kodePekerjaan, 60);
    if (!kode) return { error: errorResponse(400, "invalid_input", "Kode pekerjaan tidak boleh kosong.") };
    out.job_code = kode;
  } else if (!partial) {
    return { error: errorResponse(400, "invalid_input", "Kode pekerjaan wajib diisi.") };
  }

  if (has("namaPekerjaan")) {
    out.nama_pekerjaan = cleanStr(body.namaPekerjaan, 200);
  } else if (!partial) {
    out.nama_pekerjaan = cleanStr(body.model, 200); // UI legacy field name
  }

  if (has("perusahaanId") && cleanId(body.perusahaanId)) {
    out.perusahaan_id = cleanId(body.perusahaanId);
  } else if (cleanStr(body.perusahaanNama, 150)) {
    // No server id yet: resolved against yans_perusahaan by name later
    // (bridges may only know the local master row).
  } else if (!partial) {
    return { error: errorResponse(400, "invalid_input", "Perusahaan pemberi kerja wajib valid.") };
  }

  if (has("tanggalMasuk")) {
    out.tanggal_masuk = cleanDate(body.tanggalMasuk);
  } else if (!partial) {
    out.tanggal_masuk = cleanDate(body.tanggal) || cleanDate(body.tanggalMasuk);
  }

  if (has("deadline")) out.deadline = body.deadline === null ? null : cleanDate(body.deadline);

  if (has("jumlahOrder") || has("jumlah")) {
    const n = cleanNonNegNum(body.jumlahOrder ?? body.jumlah);
    if (n === null) return { error: errorResponse(400, "invalid_input", "Jumlah order harus angka >= 0.") };
    out.jumlah_order = Math.floor(n);
  } else if (!partial) {
    out.jumlah_order = 0;
  }

  if (has("harga") || has("hargaPerPcs")) {
    const h = cleanNonNegNum(body.harga ?? body.hargaPerPcs);
    if (h === null) return { error: errorResponse(400, "invalid_input", "Harga tidak boleh negatif.") };
    out.harga_per_pcs = roundMoney(h);
  } else if (!partial) {
    out.harga_per_pcs = 0;
  }

  if (has("catatan")) out.catatan = cleanStr(body.catatan, 2000) || null;
  if (has("status")) {
    if (!VALID_STATUS.includes(body.status)) {
      return { error: errorResponse(400, "invalid_input", "Status tidak valid.") };
    }
    out.status = body.status;
  }
  if (has("variants")) {
    out.variants = cleanVariants(body.variants);
  } else if (has("rincian")) {
    out.variants = cleanVariants(body.rincian);
  } else if (!partial) {
    out.variants = [];
  }
  return { value: out };
}

function computeTotals(fields) {
  const qty = fields.jumlah_order !== undefined ? fields.jumlah_order : null;
  const price = fields.harga_per_pcs !== undefined ? fields.harga_per_pcs : null;
  return { qty, price };
}

// Ownership check: the job must exist AND belong to the session user.
async function getOwnedJob(userId, jobId) {
  const rows = await q("SELECT id FROM yans_pekerjaan WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL", [jobId, userId]);
  return rows[0] || null;
}

// Resolves the perusahaan row for the session user (name or id based).
async function resolvePerusahaan(userId, body) {
  let byId = cleanId(body.perusahaanId);
  let nama = cleanStr(body.perusahaanNama, 150);
  if (!byId && nama) {
    const byName = await q(
      "SELECT id FROM yans_perusahaan WHERE user_id = $1 AND lower(nama) = lower($2) AND deleted_at IS NULL LIMIT 1",
      [userId, nama]
    );
    if (byName[0]) byId = byName[0].id;
  }
  if (!byId) return null;
  const rows = await q(
    "SELECT id, nama FROM yans_perusahaan WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    [byId, userId]
  );
  return rows[0] || null;
}

async function listAccessories(userId, jobId) {
  return q(
    `SELECT id, job_id, nama_asesoris, satuan, jumlah, catatan, created_at, updated_at
       FROM yans_job_accessories
      WHERE user_id = $1 AND job_id = $2 AND deleted_at IS NULL
      ORDER BY id`,
    [userId, jobId]
  );
}

async function listDocuments(userId, jobId) {
  return q(
    `SELECT id, job_id, file_name, mime_type, size_bytes, storage_ref, uploaded_at
       FROM yans_job_documents
      WHERE user_id = $1 AND job_id = $2 AND deleted_at IS NULL
      ORDER BY id`,
    [userId, jobId]
  );
}

export default async (req) => {
  if (!isDbConfigured()) {
    return json({ error: "db_not_configured", message: "Database is not configured on the server." }, 503);
  }
  try {
    await runMigrations();
  } catch (e) {
    return safeDbError(e);
  }
  const user = await resolveSession(req);
  if (!user) return errorResponse(401, "unauthorized", "Sesi tidak valid. Silakan login ulang.");

  const url = new URL(req.url);
  const id = cleanId(url.searchParams.get("id"));
  const wantAcc = url.searchParams.get("accessories") === "1";
  const wantDocs = url.searchParams.get("documents") === "1";
  const method = req.method;

  if (method === "GET") {
    try {
      if (id) {
        const rows = await q(
          `SELECT id, job_code, perusahaan_id, legacy_id, nama_pekerjaan, tanggal_masuk, deadline,
                  jumlah_order, harga_per_pcs, total_nilai, catatan, status, variants,
                  created_at, updated_at
             FROM yans_pekerjaan WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [id, user.id]
        );
        if (!rows[0]) return errorResponse(404, "not_found", "Pekerjaan tidak ditemukan.");
        const job = rowToJob(rows[0]);
        if (wantAcc) {
          const acc = await listAccessories(user.id, id);
          job.accessories = acc.map(rowToAccessory);
        }
        if (wantDocs) {
          const docs = await listDocuments(user.id, id);
          job.documents = docs.map(rowToDocument);
        }
        return json({ job });
      }
      const rows = await q(
        `SELECT id, job_code, perusahaan_id, legacy_id, nama_pekerjaan, tanggal_masuk, deadline,
                jumlah_order, harga_per_pcs, total_nilai, catatan, status, variants,
                created_at, updated_at
           FROM yans_pekerjaan WHERE user_id = $1 AND deleted_at IS NULL
          ORDER BY id DESC`,
        [user.id]
      );
      return json({ items: rows.map(rowToJob) });
    } catch (e) {
      return safeDbError(e);
    }
  }

  if (method === "POST") {
    const body = await readJson(req);
    const v = validateJobPayload(body, { partial: false });
    if (v.error) return v.error;
    try {
      const p = await resolvePerusahaan(user.id, body);
      if (!p) return errorResponse(400, "invalid_perusahaan", "Perusahaan pemberi kerja wajib valid.");
      const f = v.value;
      const total = roundMoney((f.jumlah_order || 0) * (f.harga_per_pcs || 0));
      const variantJson = JSON.stringify(f.variants || []);
      const rows = await q(
        `INSERT INTO yans_pekerjaan
           (user_id, job_code, perusahaan_id, nama_pekerjaan, tanggal_masuk, deadline,
            jumlah_order, harga_per_pcs, total_nilai, catatan, status, variants)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
         RETURNING id, job_code, perusahaan_id, legacy_id, nama_pekerjaan, tanggal_masuk, deadline,
                   jumlah_order, harga_per_pcs, total_nilai, catatan, status, variants,
                   created_at, updated_at`,
        [
          user.id, f.job_code, p.id, f.nama_pekerjaan || "", f.tanggal_masuk, f.deadline,
          f.jumlah_order, f.harga_per_pcs, total, f.catatan, f.status || "aktif", variantJson,
        ]
      );
      return json({ job: rowToJob(rows[0]) }, 201);
    } catch (e) {
      if (String(e && e.message || "").includes("yans_pekerjaan_user_code_key")) {
        return errorResponse(409, "duplicate_job_code", "Kode pekerjaan sudah dipakai untuk akun ini.");
      }
      return safeDbError(e);
    }
  }

  if (method === "PUT") {
    if (!id) return errorResponse(400, "invalid_input", "Parameter id wajib untuk update.");
    const body = await readJson(req);
    const v = validateJobPayload(body, { partial: true });
    if (v.error) return v.error;
    try {
      const owned = await getOwnedJob(user.id, id);
      if (!owned) return errorResponse(404, "not_found", "Pekerjaan tidak ditemukan.");
      const f = v.value;
      if (body.perusahaanId !== undefined || body.perusahaanNama !== undefined) {
        const p = await resolvePerusahaan(user.id, body);
        if (!p) return errorResponse(400, "invalid_perusahaan", "Perusahaan pemberi kerja wajib valid.");
        f.perusahaan_id = p.id;
      }
      // Keep totalNilai consistent with the final (qty x price) after merge.
      const cur = await q("SELECT jumlah_order, harga_per_pcs FROM yans_pekerjaan WHERE id = $1 AND user_id = $2", [id, user.id]);
      const finalQty = f.jumlah_order !== undefined ? f.jumlah_order : Number(cur[0].jumlah_order);
      const finalPrice = f.harga_per_pcs !== undefined ? f.harga_per_pcs : Number(cur[0].harga_per_pcs);
      f.total_nilai = roundMoney(finalQty * finalPrice);
      if (f.variants !== undefined) f.variants = JSON.stringify(f.variants);

      const keys = Object.keys(f);
      if (keys.length > 0) {
        // $1 = id, $2..$n+1 = values, $n+2 = user_id (never interpolated input).
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
        const uidParam = keys.length + 2;
        const params = keys.map((k) => f[k]);
        await q(
          `UPDATE yans_pekerjaan SET ${sets}, updated_at = now() WHERE id = $1 AND user_id = $${uidParam} AND deleted_at IS NULL`,
          [id, ...params, user.id]
        );
      }
      const rows = await q(
        `SELECT id, job_code, perusahaan_id, legacy_id, nama_pekerjaan, tanggal_masuk, deadline,
                jumlah_order, harga_per_pcs, total_nilai, catatan, status, variants,
                created_at, updated_at
           FROM yans_pekerjaan WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [id, user.id]
      );
      return json({ job: rowToJob(rows[0]) });
    } catch (e) {
      if (String(e && e.message || "").includes("yans_pekerjaan_user_code_key")) {
        return errorResponse(409, "duplicate_job_code", "Kode pekerjaan sudah dipakai untuk akun ini.");
      }
      return safeDbError(e);
    }
  }

  if (method === "DELETE") {
    if (!id) return errorResponse(400, "invalid_input", "Parameter id wajib untuk hapus.");
    try {
      const owned = await getOwnedJob(user.id, id);
      if (!owned) return errorResponse(404, "not_found", "Pekerjaan tidak ditemukan.");
      await q("UPDATE yans_pekerjaan SET deleted_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2", [id, user.id]);
      return json({ ok: true });
    } catch (e) {
      return safeDbError(e);
    }
  }

  return errorResponse(405, "method_not_allowed", "Gunakan GET, POST, PUT, atau DELETE.");
};

export { rowToJob, rowToAccessory, rowToDocument, listAccessories, listDocuments, validateJobPayload, computeTotals };
