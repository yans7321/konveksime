// Phase 1 data sync endpoints (session-authenticated):
//   GET  /api/sync?kind=pekerja|perusahaan|jenis_pekerjaan  -> list rows for the caller
//   POST /api/sync  { kind, items: [{...}] }                -> idempotent upsert by stable keys
// Only pekerja/perusahaan are wired into the UI in Phase 1. jenis_pekerjaan is
// reserved for the Phase 2 master (data is NOT copied from localStorage here).
import { isDbConfigured, runMigrations, q, resolveSession } from "./_db.mjs";
import { json, errorResponse, readJson, safeDbError } from "./_http.mjs";

const KINDS = ["pekerja", "perusahaan", "jenis_pekerjaan"];

function cleanStr(v, max = 200) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function cleanLegacyId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

async function listKind(userId, kind) {
  if (kind === "pekerja") {
    return q(
      `SELECT id, nama, legacy_id AS "legacyId", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM yans_pekerja WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id`,
      [userId]
    );
  }
  if (kind === "perusahaan") {
    return q(
      `SELECT id, nama, pic, telepon, catatan, legacy_id AS "legacyId",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM yans_perusahaan WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id`,
      [userId]
    );
  }
  return q(
    `SELECT id, kode, nama, kategori_biaya AS "kategoriBiaya", legacy_id AS "legacyId", is_active AS "isActive"
       FROM yans_jenis_pekerjaan WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id`,
    [userId]
  );
}

async function upsertItems(userId, kind, items) {
  let synced = 0;
  for (const raw of items.slice(0, 500)) {
    if (!raw || typeof raw !== "object") continue;
    if (kind === "pekerja") {
      const nama = cleanStr(raw.nama || raw.name, 150);
      if (!nama) continue;
      const legacyId = cleanLegacyId(raw.legacyId ?? raw.id);
      // Idempotent: re-saving the same name (or same legacy id) updates instead of duplicating.
      await q(
        `INSERT INTO yans_pekerja (user_id, nama, legacy_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, nama) DO UPDATE
           SET legacy_id = COALESCE(EXCLUDED.legacy_id, yans_pekerja.legacy_id),
               deleted_at = NULL,
               updated_at = now()`,
        [userId, nama, legacyId]
      );
      synced++;
    } else if (kind === "perusahaan") {
      const nama = cleanStr(raw.nama || raw.name, 150);
      if (!nama) continue;
      const legacyId = cleanLegacyId(raw.legacyId ?? raw.id);
      await q(
        `INSERT INTO yans_perusahaan (user_id, nama, pic, telepon, catatan, legacy_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, nama) DO UPDATE
           SET pic = EXCLUDED.pic,
               telepon = EXCLUDED.telepon,
               catatan = EXCLUDED.catatan,
               legacy_id = COALESCE(EXCLUDED.legacy_id, yans_perusahaan.legacy_id),
               deleted_at = NULL,
               updated_at = now()`,
        [userId, nama, cleanStr(raw.pic, 150) || null, cleanStr(raw.telepon, 50) || null, cleanStr(raw.catatan, 500) || null, legacyId]
      );
      synced++;
    } else if (kind === "jenis_pekerjaan") {
      const kode = cleanStr(raw.kode, 80);
      const nama = cleanStr(raw.nama || raw.name, 150);
      if (!kode || !nama) continue;
      const kategori = raw.kategoriBiaya === "lainnya" ? "lainnya" : "produksi";
      const legacyId = cleanLegacyId(raw.legacyId ?? raw.id);
      await q(
        `INSERT INTO yans_jenis_pekerjaan (user_id, kode, nama, kategori_biaya, legacy_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, kode) DO UPDATE
           SET nama = EXCLUDED.nama,
               kategori_biaya = EXCLUDED.kategori_biaya,
               legacy_id = COALESCE(EXCLUDED.legacy_id, yans_jenis_pekerjaan.legacy_id),
               deleted_at = NULL,
               updated_at = now()`,
        [userId, kode, nama, kategori, legacyId]
      );
      synced++;
    }
  }
  return synced;
}

export default async (req, context) => {
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

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const kind = url.searchParams.get("kind");
      if (!KINDS.includes(kind)) return errorResponse(400, "invalid_kind", "Kind tidak dikenal.");
      const items = await listKind(user.id, kind);
      return json({ kind, items });
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      const kind = body.kind;
      if (!KINDS.includes(kind)) return errorResponse(400, "invalid_kind", "Kind tidak dikenal.");
      if (!Array.isArray(body.items)) return errorResponse(400, "invalid_input", "items harus array.");
      const synced = await upsertItems(user.id, kind, body.items);
      const items = await listKind(user.id, kind);
      return json({ kind, synced, items });
    }
    return errorResponse(405, "method_not_allowed", "Gunakan GET atau POST.");
  } catch (e) {
    return safeDbError(e);
  }
};
