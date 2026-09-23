// Phase 4 — Storan endpoints (session-authenticated), following the Phase 3
// pickups.mjs pattern exactly:
//   GET /api/storages?storable=1          -> picked-up jobs with live quantity info
//                                            (only jobs with belum_distor > 0)
//   GET /api/storages?storable=1&jobId=1  -> quantity info for one job
//   GET /api/storages                     -> storan history (newest first)
//   GET /api/storages?jobId=1             -> history of one job
//   POST /api/storages {jobId, quantity}  -> controlled store transaction
//
// Storable quantity is ALWAYS computed server-side from the database:
//   belum_distor = SUM(pickups.quantity) - SUM(storages.quantity)
// A job is storable only when it has at least one pickup (Ambil Jahit first).
// The POST handler runs inside a transaction guarded by a per-job advisory lock,
// so concurrent submissions (or double clicks) can never over-store.
// Every statement is parameterized; every row is scoped by the session user.
import { isDbConfigured, runMigrations, q, withTransaction, resolveSession } from "./_db.mjs";
import { json, errorResponse, readJson, safeDbError } from "./_http.mjs";

const MAX_QTY = 1_000_000_000;

function cleanId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

// Strict quantity validation: positive integer only. Rejects 0, negatives,
// decimals ("10.5"), empty values, and any non-numeric string.
function cleanQuantity(v) {
  let n = null;
  if (typeof v === "number" && Number.isInteger(v)) n = v;
  else if (typeof v === "string" && /^\d+$/.test(v.trim())) n = Number(v.trim());
  if (n === null || n <= 0 || n > MAX_QTY) return null;
  return n;
}

function cleanStr(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function cleanDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}

function rowToStorage(r) {
  return {
    id: r.id,
    jobId: r.job_id,
    jobCode: r.job_code,
    namaPekerjaan: r.nama_pekerjaan,
    perusahaanNama: r.perusahaan_nama || null,
    quantity: r.quantity,
    storedAt: r.stored_at,
    createdAt: r.created_at,
  };
}

function rowToStorable(r) {
  const total = Number(r.jumlah_order) || 0;
  const taken = Number(r.taken) || 0;
  const stored = Number(r.stored) || 0;
  return {
    jobId: r.id,
    jobCode: r.job_code,
    namaPekerjaan: r.nama_pekerjaan,
    perusahaanNama: r.perusahaan_nama || null,
    perusahaanId: r.perusahaan_id,
    legacyId: r.legacy_id,
    status: r.status,
    totalQuantity: total,
    takenQuantity: taken,
    storedQuantity: stored,
    notStoredQuantity: taken - stored,
  };
}

// Live storable snapshot for one owned job (must be called inside a tx for POST).
async function jobStorable(client, userId, jobId) {
  const rows = await client.query(
    `SELECT p.id, p.job_code, p.nama_pekerjaan, p.perusahaan_id, p.legacy_id, p.status, p.jumlah_order,
            COALESCE((SELECT SUM(k.quantity) FROM yans_tailoring_pickups k
                       WHERE k.user_id = $1 AND k.job_id = p.id AND k.deleted_at IS NULL), 0) AS taken,
            COALESCE((SELECT SUM(s.quantity) FROM yans_storages s
                       WHERE s.user_id = $1 AND s.job_id = p.id AND s.deleted_at IS NULL), 0) AS stored,
            pr.nama AS perusahaan_nama
       FROM yans_pekerjaan p
       LEFT JOIN yans_perusahaan pr ON pr.id = p.perusahaan_id
      WHERE p.id = $2 AND p.user_id = $1 AND p.deleted_at IS NULL`,
    [userId, jobId]
  );
  const info = rows[0] ? rowToStorable(rows[0]) : null;
  // Business rule: Storan only exists for jobs that have been picked up.
  if (info && info.takenQuantity <= 0) return null;
  return info;
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
  const jobId = cleanId(url.searchParams.get("jobId"));
  const method = req.method;

  if (method === "GET") {
    try {
      // --- storable snapshot (picked-up jobs that still have unstored qty) ---
      if (url.searchParams.get("storable") === "1") {
        if (jobId) {
          const info = await jobStorable({ query: (t, p) => q(t, p) }, user.id, jobId);
          if (!info) return errorResponse(404, "not_found", "Pekerjaan tidak ditemukan atau belum pernah diambil.");
          return json({ job: info });
        }
        const rows = await q(
          `SELECT p.id, p.job_code, p.nama_pekerjaan, p.perusahaan_id, p.legacy_id, p.status, p.jumlah_order,
                  COALESCE(pk.taken, 0) AS taken,
                  COALESCE(st.stored, 0) AS stored,
                  pr.nama AS perusahaan_nama
             FROM yans_pekerjaan p
             LEFT JOIN yans_perusahaan pr ON pr.id = p.perusahaan_id
             LEFT JOIN (
                   SELECT job_id, SUM(quantity) AS taken
                     FROM yans_tailoring_pickups
                    WHERE user_id = $1 AND deleted_at IS NULL
                    GROUP BY job_id
             ) pk ON pk.job_id = p.id
             LEFT JOIN (
                   SELECT job_id, SUM(quantity) AS stored
                     FROM yans_storages
                    WHERE user_id = $1 AND deleted_at IS NULL
                    GROUP BY job_id
             ) st ON st.job_id = p.id
            WHERE p.user_id = $1 AND p.deleted_at IS NULL AND COALESCE(pk.taken, 0) > 0
            ORDER BY p.id DESC`,
          [user.id]
        );
        return json({ items: rows.map(rowToStorable).filter((j) => j.notStoredQuantity > 0) });
      }

      // --- storan history ---
      const params = [user.id];
      let whereJob = "";
      if (jobId) {
        params.push(jobId);
        whereJob = " AND s.job_id = $2";
      }
      const rows = await q(
        `SELECT s.id, s.job_id, s.quantity, s.stored_at, s.created_at,
                p.job_code, p.nama_pekerjaan,
                pr.nama AS perusahaan_nama
           FROM yans_storages s
           JOIN yans_pekerjaan p ON p.id = s.job_id
           LEFT JOIN yans_perusahaan pr ON pr.id = p.perusahaan_id
          WHERE s.user_id = $1 AND s.deleted_at IS NULL${whereJob}
          ORDER BY s.id DESC
          LIMIT 500`,
        params
      );
      return json({ items: rows.map(rowToStorage) });
    } catch (e) {
      return safeDbError(e);
    }
  }

  if (method === "POST") {
    const body = await readJson(req);
    const jid = cleanId(body.jobId);
    if (!jid) return errorResponse(400, "invalid_input", "jobId wajib dan harus angka valid.");
    const quantity = cleanQuantity(body.quantity ?? body.jumlah);
    if (quantity === null) {
      return errorResponse(400, "invalid_quantity", "Jumlah stor harus berupa angka bulat positif (tanpa desimal).");
    }
    try {
      const result = await withTransaction(async (client) => {
        // Serialize concurrent stores of the same job so the
        // read-available-then-insert pair is atomic (double submission safe).
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${user.id}:storage:${jid}`]);

        const job = await jobStorable(client, user.id, jid);
        if (!job) return { notFound: true };

        // The frontend mirror re-sends its legacy row id on edit: treat it as an
        // update of that exact transaction instead of a duplicate insert.
        const legacyId = cleanId(body.legacyId);
        let existing = null;
        if (legacyId) {
          const ex = await client.query(
            "SELECT id, job_id, quantity FROM yans_storages WHERE user_id = $1 AND legacy_id = $2 AND deleted_at IS NULL LIMIT 1",
            [user.id, legacyId]
          );
          if (ex[0]) existing = ex[0];
        }
        if (existing && existing.job_id !== jid) {
          return { duplicateLegacy: true };
        }

        // Effective ceiling: when editing, the row's old quantity returns to the
        // pool before the new value is checked.
        const ceiling = job.notStoredQuantity + (existing ? Number(existing.quantity) : 0);
        if (quantity > ceiling) {
          return {
            overQuantity: true,
            notStored: job.notStoredQuantity,
            taken: job.takenQuantity,
            stored: job.storedQuantity,
          };
        }

        const storedAt = cleanDate(body.storedAt) || new Date().toISOString().slice(0, 10);
        let row;
        let updated = false;
        if (existing) {
          const upd = await client.query(
            `UPDATE yans_storages
                SET quantity = $1, stored_at = $2, updated_at = now()
              WHERE id = $3 AND user_id = $4
              RETURNING id, job_id, quantity, stored_at, legacy_id, created_at, updated_at`,
            [quantity, storedAt, existing.id, user.id]
          );
          row = upd[0];
          updated = true;
        } else {
          const ins = await client.query(
            `INSERT INTO yans_storages (user_id, job_id, quantity, stored_at, legacy_id)
             VALUES ($1,$2,$3,$4,$5)
             RETURNING id, job_id, quantity, stored_at, legacy_id, created_at, updated_at`,
            [user.id, jid, quantity, storedAt, legacyId]
          );
          row = ins[0];
        }
        const after = await jobStorable(client, user.id, jid);
        return {
          updated,
          storage: rowToStorage({ ...row, job_code: job.jobCode, nama_pekerjaan: job.namaPekerjaan, perusahaan_nama: job.perusahaanNama }),
          job: after,
        };
      });

      if (result.notFound) return errorResponse(404, "not_found", "Pekerjaan tidak ditemukan atau belum pernah diambil (Ambil Jahit dulu).");
      if (result.duplicateLegacy) {
        return errorResponse(409, "duplicate_legacy", "Transaksi ini sudah terdaftar untuk pekerjaan lain.");
      }
      if (result.overQuantity) {
        return json(
          {
            error: "insufficient_storable_quantity",
            message: "Jumlah stor melebihi jumlah pekerjaan yang belum distor.",
            taken: result.taken,
            stored: result.stored,
            notStored: result.notStored,
          },
          409
        );
      }
      return json(result, result.updated ? 200 : 201);
    } catch (e) {
      return safeDbError(e);
    }
  }

  return errorResponse(405, "method_not_allowed", "Gunakan GET atau POST.");
};
