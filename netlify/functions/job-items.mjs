// Phase 2 — Job accessories & document metadata endpoints (session-authenticated):
//   GET    /api/job-accessories?jobId=1            -> list accessories of a job
//   POST   /api/job-accessories   {jobId, ...}     -> create (upsert by name)
//   PUT    /api/job-accessories?id=5               -> update
//   DELETE /api/job-accessories?id=5               -> soft delete
//   GET    /api/job-documents?jobId=1              -> list document metadata
//   POST   /api/job-documents     {jobId, fileName, mimeType, sizeBytes, storageRef}
//   DELETE /api/job-documents?id=5                 -> soft delete
//
// There is NO binary upload endpoint: file bytes never pass through the API in
// Phase 2 (storage provider is a declared external dependency). The client
// registers metadata for a file it stored via a storage provider, or references
// a nota that exists physically. Every statement is parameterized and every row
// is scoped by the session user; job ownership is verified before any write.
import { isDbConfigured, runMigrations, q, resolveSession } from "./_db.mjs";
import { json, errorResponse, readJson, safeDbError } from "./_http.mjs";

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

async function getOwnedJob(userId, jobId) {
  const rows = await q("SELECT id FROM yans_pekerjaan WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL", [jobId, userId]);
  return rows[0] || null;
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

async function handleKind(req, kind) {
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
  const jobId = cleanId(url.searchParams.get("jobId"));
  const method = req.method;

  try {
    // ---------------- Accessories ----------------
    if (kind === "accessories") {
      if (method === "GET") {
        if (!jobId) return errorResponse(400, "invalid_input", "Parameter jobId wajib.");
        if (!(await getOwnedJob(user.id, jobId))) return errorResponse(404, "not_found", "Pekerjaan tidak ditemukan.");
        const rows = await q(
          `SELECT id, job_id, nama_asesoris, satuan, jumlah, catatan, created_at, updated_at
             FROM yans_job_accessories
            WHERE user_id = $1 AND job_id = $2 AND deleted_at IS NULL
            ORDER BY id`,
          [user.id, jobId]
        );
        return json({ items: rows.map(rowToAccessory) });
      }
      if (method === "POST") {
        const body = await readJson(req);
        const jid = cleanId(body.jobId);
        if (!jid) return errorResponse(400, "invalid_input", "jobId wajib dan harus angka valid.");
        const nama = cleanStr(body.namaAsesoris, 150);
        if (!nama) return errorResponse(400, "invalid_input", "Nama asesoris wajib diisi.");
        const jumlah = cleanNonNegNum(body.jumlah ?? body.qty);
        if (jumlah === null) return errorResponse(400, "invalid_input", "Jumlah asesoris tidak boleh negatif.");
        if (!(await getOwnedJob(user.id, jid))) return errorResponse(404, "not_found", "Pekerjaan tidak ditemukan.");
        const satuan = cleanStr(body.satuan, 50) || null;
        const catatan = cleanStr(body.catatan, 500) || null;
        // Upsert by (user, job, name): re-saving the same accessory updates it
        // instead of creating duplicates.
        const rows = await q(
          `INSERT INTO yans_job_accessories (user_id, job_id, nama_asesoris, satuan, jumlah, catatan)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (user_id, job_id, nama_asesoris) DO UPDATE
             SET satuan = EXCLUDED.satuan,
                 jumlah = EXCLUDED.jumlah,
                 catatan = EXCLUDED.catatan,
                 deleted_at = NULL,
                 updated_at = now()
           RETURNING id, job_id, nama_asesoris, satuan, jumlah, catatan, created_at, updated_at`,
          [user.id, jid, nama, satuan, jumlah, catatan]
        );
        return json({ accessory: rowToAccessory(rows[0]) }, 201);
      }
      if (method === "PUT") {
        if (!id) return errorResponse(400, "invalid_input", "Parameter id wajib untuk update.");
        const body = await readJson(req);
        const nama = cleanStr(body.namaAsesoris, 150);
        const jumlah = cleanNonNegNum(body.jumlah ?? body.qty);
        if ((body.jumlah !== undefined || body.qty !== undefined) && jumlah === null) {
          return errorResponse(400, "invalid_input", "Jumlah asesoris tidak boleh negatif.");
        }
        const rows0 = await q(
          "SELECT id FROM yans_job_accessories WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
          [id, user.id]
        );
        if (!rows0[0]) return errorResponse(404, "not_found", "Asesoris tidak ditemukan.");
        const sets = [];
        const params = [];
        let pn = 1;
        if (nama) { params.push(nama); sets.push(`nama_asesoris = $${pn++}`); }
        if (body.satuan !== undefined) { params.push(cleanStr(body.satuan, 50) || null); sets.push(`satuan = $${pn++}`); }
        if (jumlah !== null) { params.push(jumlah); sets.push(`jumlah = $${pn++}`); }
        if (body.catatan !== undefined) { params.push(cleanStr(body.catatan, 500) || null); sets.push(`catatan = $${pn++}`); }
        if (sets.length > 0) {
          params.push(id, user.id);
          await q(
            `UPDATE yans_job_accessories SET ${sets.join(", ")}, updated_at = now() WHERE id = $${pn++} AND user_id = $${pn++}`,
            params
          );
        }
        const rows = await q(
          "SELECT id, job_id, nama_asesoris, satuan, jumlah, catatan, created_at, updated_at FROM yans_job_accessories WHERE id = $1 AND user_id = $2",
          [id, user.id]
        );
        return json({ accessory: rowToAccessory(rows[0]) });
      }
      if (method === "DELETE") {
        if (!id) return errorResponse(400, "invalid_input", "Parameter id wajib untuk hapus.");
        const rows0 = await q(
          "SELECT id FROM yans_job_accessories WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
          [id, user.id]
        );
        if (!rows0[0]) return errorResponse(404, "not_found", "Asesoris tidak ditemukan.");
        await q("UPDATE yans_job_accessories SET deleted_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2", [id, user.id]);
        return json({ ok: true });
      }
      return errorResponse(405, "method_not_allowed", "Gunakan GET, POST, PUT, atau DELETE.");
    }

    // ---------------- Documents (metadata only) ----------------
    if (kind === "documents") {
      if (method === "GET") {
        if (!jobId) return errorResponse(400, "invalid_input", "Parameter jobId wajib.");
        if (!(await getOwnedJob(user.id, jobId))) return errorResponse(404, "not_found", "Pekerjaan tidak ditemukan.");
        const rows = await q(
          `SELECT id, job_id, file_name, mime_type, size_bytes, storage_ref, uploaded_at
             FROM yans_job_documents
            WHERE user_id = $1 AND job_id = $2 AND deleted_at IS NULL
            ORDER BY id`,
          [user.id, jobId]
        );
        return json({ items: rows.map(rowToDocument) });
      }
      if (method === "POST") {
        const body = await readJson(req);
        const jid = cleanId(body.jobId);
        if (!jid) return errorResponse(400, "invalid_input", "jobId wajib dan harus angka valid.");
        const fileName = cleanStr(body.fileName, 255);
        if (!fileName) return errorResponse(400, "invalid_input", "Nama file wajib diisi.");
        const sizeBytes = body.sizeBytes === undefined || body.sizeBytes === null ? null : cleanNonNegNum(body.sizeBytes);
        if (body.sizeBytes !== undefined && body.sizeBytes !== null && sizeBytes === null) {
          return errorResponse(400, "invalid_input", "Ukuran file tidak valid.");
        }
        if (!(await getOwnedJob(user.id, jid))) return errorResponse(404, "not_found", "Pekerjaan tidak ditemukan.");
        const mimeType = cleanStr(body.mimeType, 120) || null;
        const storageRef = cleanStr(body.storageRef, 500) || null;
        // Upsert by (user, job, file_name): re-registering the same file
        // updates metadata instead of creating duplicates.
        const rows = await q(
          `INSERT INTO yans_job_documents (user_id, job_id, file_name, mime_type, size_bytes, storage_ref)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (user_id, job_id, file_name) DO UPDATE
             SET mime_type = EXCLUDED.mime_type,
                 size_bytes = EXCLUDED.size_bytes,
                 storage_ref = COALESCE(EXCLUDED.storage_ref, yans_job_documents.storage_ref),
                 deleted_at = NULL,
                 uploaded_at = now()
           RETURNING id, job_id, file_name, mime_type, size_bytes, storage_ref, uploaded_at`,
          [user.id, jid, fileName, mimeType, sizeBytes, storageRef]
        );
        return json({ document: rowToDocument(rows[0]) }, 201);
      }
      if (method === "DELETE") {
        if (!id) return errorResponse(400, "invalid_input", "Parameter id wajib untuk hapus.");
        const rows0 = await q(
          "SELECT id FROM yans_job_documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
          [id, user.id]
        );
        if (!rows0[0]) return errorResponse(404, "not_found", "Dokumen tidak ditemukan.");
        await q("UPDATE yans_job_documents SET deleted_at = now() WHERE id = $1 AND user_id = $2", [id, user.id]);
        return json({ ok: true });
      }
      return errorResponse(405, "method_not_allowed", "Gunakan GET, POST, atau DELETE.");
    }

    return errorResponse(400, "invalid_kind", "Kind tidak dikenal.");
  } catch (e) {
    return safeDbError(e);
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const kind = url.pathname.replace(/\/+$/, "").endsWith("job-documents") ? "documents" : "accessories";
  return handleKind(req, kind);
};
