// Phase 7 — Kiriman Barang (shipments) endpoints, session-authenticated.
// Pattern follows storages.mjs (transactional ceiling) + ledger.mjs (upsert):
//   GET /api/shipments?shippable=1            -> jobs with live shipped info
//                                                (only jobs with sisa > 0)
//   GET /api/shipments?shippable=1&jobId=1    -> quantity info for one job
//   GET /api/shipments[?jobId=1]              -> shipment history (newest first)
//   POST /api/shipments {jobId, tanggal, status, penerima, variants[], legacyId?}
//   PUT  /api/shipments {id, ...partial}      -> update by server id
//   DELETE /api/shipments?id=1                -> soft delete
//
// Shipped ceiling is ALWAYS computed server-side from the database:
//   sisa = job.jumlah_order - SUM(total variants per shipment)
// (Order-based ceiling — matches the existing UI rule; NOT pickup/storage based.)
// The POST handler runs inside a transaction guarded by a per-job advisory lock,
// so concurrent submissions can never over-ship. Every statement is
// parameterized; user_id ALWAYS comes from the session, never the body.
// Photo fields are metadata only (name/mime/size) — never base64/bytes.
import { isDbConfigured, runMigrations, q, withTransaction, resolveSession } from "./_db.mjs";
import { json, errorResponse, readJson, safeDbError } from "./_http.mjs";

const STATUSES = ["Selesai", "Belum Selesai", "Bahan"];

function cleanId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

function cleanStr(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function cleanDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : v;
}

// Variants mirror the localStorage shape [{warna, ukuran, jumlah}]. Only rows
// with a jumlah > 0 integer are accepted; warna/ukuran are optional strings.
function cleanVariants(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const row of v) {
    if (!row || typeof row !== "object") return null;
    let jumlah = null;
    if (typeof row.jumlah === "number" && Number.isInteger(row.jumlah)) jumlah = row.jumlah;
    else if (typeof row.jumlah === "string" && /^\d+$/.test(String(row.jumlah).trim())) jumlah = Number(String(row.jumlah).trim());
    if (jumlah === null || jumlah <= 0 || jumlah > 1_000_000_000) return null;
    out.push({
      warna: cleanStr(row.warna, 80),
      ukuran: cleanStr(row.ukuran ?? row.size, 40),
      jumlah,
    });
  }
  return out;
}

function shippedTotal(variants) {
  // Defensive: pg returns jsonb as an object, but a raw string is accepted too.
  let arr = variants;
  if (typeof arr === "string") {
    try { arr = JSON.parse(arr); } catch (e) { arr = []; }
  }
  return (Array.isArray(arr) ? arr : []).reduce((s, r) => s + (Number(r && r.jumlah) || 0), 0);
}

// Foto metadata: strings only, never base64/bytes (hard length ceilings).
function cleanFotoMeta(body) {
  return {
    fileName: cleanStr(body.fotoName ?? body.foto_file_name, 200) || null,
    mimeType: cleanStr(body.fotoMimeType ?? body.foto_mime_type, 100) || null,
    sizeBytes: cleanId(body.fotoSizeBytes ?? body.foto_size_bytes),
  };
}

// Prefixed with the `s` alias (yans_shipments) — every usage joins
// yans_pekerjaan/yans_perusahaan, where an unqualified `id` would be ambiguous.
const SHIPMENT_COLS = `s.id, s.job_id, s.perusahaan_id, s.tanggal, s.status, s.penerima, s.catatan, s.variants,
        s.foto_file_name, s.foto_mime_type, s.foto_size_bytes, s.foto_storage_ref, s.legacy_id, s.created_at, s.updated_at`;

function rowToShipment(r) {
  return {
    id: r.id,
    dbId: r.id,
    jobId: r.job_id,
    jobCode: r.job_code || null,
    namaPekerjaan: r.nama_pekerjaan || null,
    perusahaanId: r.perusahaan_id,
    perusahaanNama: r.perusahaan_nama || null,
    tanggal: r.tanggal,
    status: r.status,
    penerima: r.penerima,
    catatan: r.catatan || "",
    variants: typeof r.variants === "string" ? JSON.parse(r.variants) : r.variants || [],
    foto: {
      fileName: r.foto_file_name || null,
      mimeType: r.foto_mime_type || null,
      sizeBytes: r.foto_size_bytes || null,
      storageRef: r.foto_storage_ref || null,
    },
    legacyId: r.legacy_id,
    createdAt: r.created_at,
  };
}

function rowToShippable(r) {
  const order = Number(r.jumlah_order) || 0;
  const shipped = Number(r.shipped) || 0;
  return {
    jobId: r.id,
    jobCode: r.job_code,
    namaPekerjaan: r.nama_pekerjaan,
    perusahaanNama: r.perusahaan_nama || null,
    perusahaanId: r.perusahaan_id,
    legacyId: r.legacy_id,
    status: r.status,
    orderQuantity: order,
    shippedQuantity: shipped,
    remainingQuantity: order - shipped,
  };
}

// Live shipped snapshot for one owned job (called inside a tx for POST).
async function jobShippable(client, userId, jobId) {
  const rows = await client.query(
    `SELECT p.id, p.job_code, p.nama_pekerjaan, p.perusahaan_id, p.legacy_id, p.status, p.jumlah_order,
            COALESCE((SELECT SUM((sv.value->>'jumlah')::numeric)
                        FROM yans_shipments s, jsonb_array_elements(s.variants) sv
                       WHERE s.user_id = $1 AND s.job_id = p.id
                         AND s.deleted_at IS NULL), 0) AS shipped,
            pr.nama AS perusahaan_nama
       FROM yans_pekerjaan p
       LEFT JOIN yans_perusahaan pr ON pr.id = p.perusahaan_id
      WHERE p.id = $2 AND p.user_id = $1 AND p.deleted_at IS NULL`,
    [userId, jobId]
  );
  return rows[0] ? rowToShippable(rows[0]) : null;
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
  const method = req.method;

  if (method === "GET") {
    const jobId = cleanId(url.searchParams.get("jobId"));
    try {
      // --- shippable snapshot: order-based remaining quantity ---
      if (url.searchParams.get("shippable") === "1") {
        if (jobId) {
          const info = await jobShippable({ query: (t, p) => q(t, p) }, user.id, jobId);
          if (!info) return errorResponse(404, "not_found", "Pekerjaan tidak ditemukan.");
          return json({ job: info });
        }
        const rows = await q(
          `SELECT p.id, p.job_code, p.nama_pekerjaan, p.perusahaan_id, p.legacy_id, p.status, p.jumlah_order,
                  COALESCE(sh.shipped, 0) AS shipped,
                  pr.nama AS perusahaan_nama
             FROM yans_pekerjaan p
             LEFT JOIN yans_perusahaan pr ON pr.id = p.perusahaan_id
             LEFT JOIN (
                   SELECT job_id, SUM((sv.value->>'jumlah')::numeric) AS shipped
                     FROM yans_shipments s, jsonb_array_elements(s.variants) sv
                    WHERE s.user_id = $1 AND s.job_id IS NOT NULL AND s.deleted_at IS NULL
                    GROUP BY job_id
             ) sh ON sh.job_id = p.id
            WHERE p.user_id = $1 AND p.deleted_at IS NULL
              AND COALESCE(sh.shipped, 0) < p.jumlah_order
            ORDER BY p.id DESC`,
          [user.id]
        );
        return json({ items: rows.map(rowToShippable) });
      }

      // --- shipment history ---
      const params = [user.id];
      let whereJob = "";
      if (jobId) {
        params.push(jobId);
        whereJob = " AND s.job_id = $2";
      }
      const rows = await q(
        `SELECT s.id, s.job_id, s.perusahaan_id, s.tanggal, s.status, s.penerima, s.catatan, s.variants,
                s.foto_file_name, s.foto_mime_type, s.foto_size_bytes, s.foto_storage_ref, s.legacy_id, s.created_at,
                p.job_code, p.nama_pekerjaan,
                pr.nama AS perusahaan_nama
           FROM yans_shipments s
           LEFT JOIN yans_pekerjaan p ON p.id = s.job_id
           LEFT JOIN yans_perusahaan pr ON pr.id = s.perusahaan_id
          WHERE s.user_id = $1 AND s.deleted_at IS NULL${whereJob}
          ORDER BY s.id DESC
          LIMIT 500`,
        params
      );
      return json({ items: rows.map(rowToShipment) });
    } catch (e) {
      return safeDbError(e);
    }
  }

  if (method === "POST") {
    const body = await readJson(req);
    const jid = cleanId(body.jobId);
    if (!jid) return errorResponse(400, "invalid_input", "jobId wajib dan harus angka valid.");
    const status = body.status === undefined || body.status === null || body.status === "" ? "Selesai" : body.status;
    if (!STATUSES.includes(status)) return errorResponse(400, "invalid_input", "Status harus Selesai / Belum Selesai / Bahan.");
    const penerima = cleanStr(body.penerima, 150);
    if (!penerima) return errorResponse(400, "invalid_input", "Penerima wajib diisi.");
    const variants = cleanVariants(body.variants);
    if (!variants || variants.length === 0) {
      return errorResponse(400, "invalid_input", "Rincian barang wajib berisi minimal satu baris dengan jumlah > 0.");
    }
    const tanggal = cleanDate(body.tanggal);
    if (tanggal === null) return errorResponse(400, "invalid_input", "Tanggal harus format YYYY-MM-DD.");
    const catatan = cleanStr(body.catatan, 500);
    const foto = cleanFotoMeta(body);

    try {
      const result = await withTransaction(async (client) => {
        // Serialize concurrent shipments of the same job (double-submit safe).
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${user.id}:shipment:${jid}`]);

        const job = await jobShippable(client, user.id, jid);
        if (!job) return { notFound: true };

        // legacyId (localStorage row id) makes edits from the existing UI
        // update in place instead of duplicating rows.
        const legacyId = cleanId(body.legacyId);
        let existing = null;
        if (legacyId) {
          // The bridge sends the SERVER id for rows created here (legacy_id
          // backfilled to id below) and the local id for historical rows.
          const ex = await client.query(
            "SELECT id, job_id, variants FROM yans_shipments WHERE user_id = $1 AND deleted_at IS NULL AND (legacy_id = $2 OR id = $2) LIMIT 1",
            [user.id, legacyId]
          );
          if (ex[0]) existing = ex[0];
        }
        if (existing && existing.job_id !== jid) {
          return { duplicateLegacy: true };
        }

        // Effective ceiling: when editing, the row's old shipment total returns
        // to the pool before the new value is checked. Order-based ceiling.
        const priorShipped = existing ? shippedTotal(existing.variants) : 0;
        const ceiling = job.remainingQuantity + priorShipped;
        const newShipped = shippedTotal(variants);
        if (newShipped > ceiling) {
          return { overQuantity: true, order: job.orderQuantity, shipped: job.shippedQuantity, sisa: job.remainingQuantity };
        }

        let row;
        let updated = false;
        if (existing) {
          // Foto metadata is only overwritten when a new file was picked
          // (fileName present); otherwise the previously registered metadata
          // is preserved (the client keeps the old Data URL locally).
          const withFoto = Boolean(foto.fileName);
          const updSql = withFoto
            ? `UPDATE yans_shipments
                  SET job_id = $1, tanggal = $2, status = $3, penerima = $4, catatan = $5, variants = $6::jsonb,
                      foto_file_name = $7, foto_mime_type = $8, foto_size_bytes = $9, updated_at = now()
                WHERE id = $10 AND user_id = $11`
            : `UPDATE yans_shipments
                  SET job_id = $1, tanggal = $2, status = $3, penerima = $4, catatan = $5, variants = $6::jsonb, updated_at = now()
                WHERE id = $7 AND user_id = $8`;
          await client.query(
            updSql,
            withFoto
              ? [jid, tanggal, status, penerima, catatan, JSON.stringify(variants), foto.fileName, foto.mimeType, foto.sizeBytes, existing.id, user.id]
              : [jid, tanggal, status, penerima, catatan, JSON.stringify(variants), existing.id, user.id]
          );
          // Re-fetch with JOINs for a consistent response shape.
          row = (await client.query(`SELECT ${SHIPMENT_COLS}, p.job_code, p.nama_pekerjaan, pr.nama AS perusahaan_nama
              FROM yans_shipments s LEFT JOIN yans_pekerjaan p ON p.id = s.job_id LEFT JOIN yans_perusahaan pr ON pr.id = s.perusahaan_id
             WHERE s.id = $1 AND s.user_id = $2`, [existing.id, user.id]))[0];
          updated = true;
        } else {
          const ins = await client.query(
            `INSERT INTO yans_shipments (user_id, job_id, tanggal, status, penerima, catatan, variants, foto_file_name, foto_mime_type, foto_size_bytes, legacy_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
             RETURNING id`,
            [user.id, jid, tanggal, status, penerima, catatan, JSON.stringify(variants), foto.fileName, foto.mimeType, foto.sizeBytes, legacyId]
          );
          // Self-anchor: rows created without a client legacy id get
          // legacy_id = id, so the bridge can always re-target them.
          await client.query(
            "UPDATE yans_shipments SET legacy_id = id WHERE id = $1 AND legacy_id IS NULL",
            [ins[0].id]
          );
          row = (await client.query(`SELECT ${SHIPMENT_COLS}, p.job_code, p.nama_pekerjaan, pr.nama AS perusahaan_nama
              FROM yans_shipments s LEFT JOIN yans_pekerjaan p ON p.id = s.job_id LEFT JOIN yans_perusahaan pr ON pr.id = s.perusahaan_id
             WHERE s.id = $1 AND s.user_id = $2`, [ins[0].id, user.id]))[0];
        }
        const after = await jobShippable(client, user.id, jid);
        return { updated, shipment: rowToShipment(row), job: after };
      });

      if (result.notFound) return errorResponse(404, "not_found", "Pekerjaan tidak ditemukan.");
      if (result.duplicateLegacy) {
        return errorResponse(409, "duplicate_legacy", "Transaksi ini sudah terdaftar untuk pekerjaan lain.");
      }
      if (result.overQuantity) {
        return json(
          {
            error: "insufficient_shippable_quantity",
            message: "Jumlah kirim melebihi sisa pekerjaan yang belum dikirim.",
            order: result.order,
            shipped: result.shipped,
            sisa: result.sisa,
          },
          409
        );
      }
      return json(result, result.updated ? 200 : 201);
    } catch (e) {
      return safeDbError(e);
    }
  }

  if (method === "PUT") {
    const body = await readJson(req);
    const id = cleanId(body.id);
    if (!id) return errorResponse(400, "invalid_input", "id wajib untuk update.");
    let newVariants = null; // cleaned variants when changed (re-validated below)
    try {
      const sets = [];
      const params = [];
      if (body.tanggal !== undefined) {
        const tanggal = cleanDate(body.tanggal);
        if (tanggal === null) return errorResponse(400, "invalid_input", "Tanggal harus format YYYY-MM-DD.");
        params.push(tanggal); sets.push(`tanggal = $${params.length}`);
      }
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) return errorResponse(400, "invalid_input", "Status tidak valid.");
        params.push(body.status); sets.push(`status = $${params.length}`);
      }
      if (body.penerima !== undefined) {
        const penerima = cleanStr(body.penerima, 150);
        if (!penerima) return errorResponse(400, "invalid_input", "Penerima wajib diisi.");
        params.push(penerima); sets.push(`penerima = $${params.length}`);
      }
      if (body.catatan !== undefined) { params.push(cleanStr(body.catatan, 500)); sets.push(`catatan = $${params.length}`); }
      if (body.variants !== undefined) {
        const cleaned = cleanVariants(body.variants);
        if (!cleaned || cleaned.length === 0) return errorResponse(400, "invalid_input", "Rincian barang tidak valid.");
        newVariants = cleaned;
        params.push(JSON.stringify(cleaned)); sets.push(`variants = $${params.length}::jsonb`);
      }
      if (body.fotoName !== undefined || body.fotoMimeType !== undefined || body.fotoSizeBytes !== undefined) {
        const foto = cleanFotoMeta(body);
        params.push(foto.fileName); sets.push(`foto_file_name = $${params.length}`);
        params.push(foto.mimeType); sets.push(`foto_mime_type = $${params.length}`);
        params.push(foto.sizeBytes); sets.push(`foto_size_bytes = $${params.length}`);
      }
      if (sets.length === 0) return errorResponse(400, "invalid_input", "Tidak ada field yang diupdate.");
      // Variant changes affect the shipped ceiling: re-validate in a tx.
      const result = await withTransaction(async (client) => {
        const cur = await client.query(
          `SELECT s.id, s.job_id, s.variants FROM yans_shipments s WHERE s.id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL`,
          [id, user.id]
        );
        if (!cur[0]) return { notFound: true };
        const jobId = cur[0].job_id;
        if (jobId && body.variants !== undefined) {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${user.id}:shipment:${jobId}`]);
          const job = await jobShippable(client, user.id, jobId);
          if (!job) return { notFound: true };
          const ceiling = job.remainingQuantity + shippedTotal(cur[0].variants);
          if (newVariants && shippedTotal(newVariants) > ceiling) {
            return { overQuantity: true, order: job.orderQuantity, shipped: job.shippedQuantity, sisa: job.remainingQuantity };
          }
        }
        params.push(id, user.id);
        const rows = await client.query(
          `UPDATE yans_shipments SET ${sets.join(", ")}, updated_at = now()
            WHERE id = $${params.length - 1} AND user_id = $${params.length} AND deleted_at IS NULL
            RETURNING id`,
          params
        );
        if (!rows[0]) return { notFound: true };
        const full = await client.query(`SELECT ${SHIPMENT_COLS}, p.job_code, p.nama_pekerjaan, pr.nama AS perusahaan_nama
            FROM yans_shipments s LEFT JOIN yans_pekerjaan p ON p.id = s.job_id LEFT JOIN yans_perusahaan pr ON pr.id = s.perusahaan_id
           WHERE s.id = $1`, [id]);
        return { shipment: rowToShipment(full[0]) };
      });
      if (result.notFound) return errorResponse(404, "not_found", "Data tidak ditemukan.");
      if (result.overQuantity) {
        return json({ error: "insufficient_shippable_quantity", message: "Jumlah kirim melebihi sisa pekerjaan yang belum dikirim.", order: result.order, shipped: result.shipped, sisa: result.sisa }, 409);
      }
      return json({ item: result.shipment });
    } catch (e) {
      return safeDbError(e);
    }
  }

  if (method === "DELETE") {
    const id = cleanId(url.searchParams.get("id"));
    if (!id) return errorResponse(400, "invalid_input", "id wajib untuk delete.");
    try {
      const rows = await q(
        `UPDATE yans_shipments SET deleted_at = now(), updated_at = now()
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
        [id, user.id]
      );
      if (!rows[0]) return errorResponse(404, "not_found", "Data tidak ditemukan.");
      return json({ deleted: true, id });
    } catch (e) {
      return safeDbError(e);
    }
  }

  return errorResponse(405, "method_not_allowed", "Metode tidak didukung.");
};
