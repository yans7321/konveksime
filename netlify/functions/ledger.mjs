// Phase 6 — Ledger modules (expenses / kasbon / aset), session-authenticated.
// One function serves three independent, simple ledgers. Endpoint selection by
// `module` query param:
//   GET    /api/ledger?module=expenses[&id=1]           -> list / one row
//   POST   /api/ledger  {module, tanggal, ..., legacyId}  -> create (or
//           update in place when legacyId exists — mirrors localStorage edits)
//   PUT    /api/ledger  {module, id, ...fields}         -> update by server id
//   DELETE /api/ledger?module=expenses&id=1             -> soft delete
//
// Business meaning is kept exactly as the app's localStorage model:
//   expenses: {tanggal, kategori, keterangan, nominal>0}
//   kasbon:   {tanggal, keterangan, jumlah>0}
//   aset:     {tanggal, nama, harga>0}
// Every statement is parameterized; user_id ALWAYS comes from the session,
// never from the request body. No transaction/advisory lock needed: rows are
// independent (no derived quantities), matching the storages/pickups pattern
// only where cross-row invariants exist — here none do.
import { isDbConfigured, runMigrations, q, resolveSession } from "./_db.mjs";
import { json, errorResponse, readJson, safeDbError } from "./_http.mjs";

const MAX_AMOUNT = 1_000_000_000_000; // 1e12 — generous ceiling for rupiah amounts
const MODULES = {
  expenses: {
    table: "yans_expenses",
    fields: ["tanggal", "kategori", "keterangan", "nominal"],
    required: ["keterangan", "nominal"],
  },
  kasbon: {
    table: "yans_kasbon",
    fields: ["tanggal", "keterangan", "jumlah"],
    required: ["keterangan", "jumlah"],
  },
  aset: {
    table: "yans_aset",
    fields: ["tanggal", "nama", "harga"],
    required: ["nama", "harga"],
  },
};

function cleanId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

// Amounts arrive from number inputs (parseFloat client-side) — accept a number
// or a plain numeric string, reject 0 / negative / NaN / other junk. Stored as
// numeric(16,2), returned as Number to keep the localStorage mirror shape.
function cleanAmount(v) {
  let n = null;
  if (typeof v === "number" && Number.isFinite(v)) n = v;
  else if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) n = Number(v.trim());
  if (n === null || n <= 0 || n > MAX_AMOUNT) return null;
  return n;
}

function cleanStr(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function cleanDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : v;
}

// Validate + normalize payload per module. Returns {values} or {error}.
function buildValues(mod, body, partial) {
  const cfg = MODULES[mod];
  const values = {};
  // All three ledger modules carry a tanggal column.
  {
    const tanggal = cleanDate(body.tanggal);
    if (tanggal === null && (!partial || body.tanggal !== undefined)) return { error: "Tanggal harus format YYYY-MM-DD." };
    values.tanggal = tanggal;
  }
  if (mod === "expenses") {
    const kategori = cleanStr(body.kategori, 40) || "Lain-lain";
    const keterangan = cleanStr(body.keterangan, 200);
    const nominal = cleanAmount(body.nominal);
    if (partial) {
      if (body.kategori !== undefined) values.kategori = kategori;
      if (body.keterangan !== undefined) values.keterangan = keterangan;
      if (body.nominal !== undefined) {
        if (nominal === null) return { error: "Nominal harus angka positif." };
        values.nominal = nominal;
      }
    } else {
      if (!keterangan) return { error: "Keterangan wajib diisi." };
      if (nominal === null) return { error: "Nominal harus angka positif." };
      values.kategori = kategori;
      values.keterangan = keterangan;
      values.nominal = nominal;
    }
  } else if (mod === "kasbon") {
    const keterangan = cleanStr(body.keterangan, 200);
    const jumlah = cleanAmount(body.jumlah);
    if (partial) {
      if (body.keterangan !== undefined) values.keterangan = keterangan;
      if (body.jumlah !== undefined) {
        if (jumlah === null) return { error: "Jumlah harus angka positif." };
        values.jumlah = jumlah;
      }
    } else {
      if (!keterangan) return { error: "Keterangan wajib diisi." };
      if (jumlah === null) return { error: "Jumlah harus angka positif." };
      values.keterangan = keterangan;
      values.jumlah = jumlah;
    }
  } else {
    const nama = cleanStr(body.nama, 150);
    const harga = cleanAmount(body.harga);
    if (partial) {
      if (body.nama !== undefined) values.nama = nama;
      if (body.harga !== undefined) {
        if (harga === null) return { error: "Harga harus angka positif." };
        values.harga = harga;
      }
    } else {
      if (!nama) return { error: "Nama aset wajib diisi." };
      if (harga === null) return { error: "Harga harus angka positif." };
      values.nama = nama;
      values.harga = harga;
    }
  }
  return { values };
}

function rowToItem(mod, r) {
  const base = {
    id: r.id,
    dbId: r.id,
    legacyId: r.legacy_id,
    tanggal: r.tanggal,
    createdAt: r.created_at,
  };
  if (mod === "expenses") return { ...base, kategori: r.kategori, keterangan: r.keterangan, nominal: Number(r.nominal) };
  if (mod === "kasbon") return { ...base, keterangan: r.keterangan, jumlah: Number(r.jumlah) };
  return { ...base, nama: r.nama, harga: Number(r.harga) };
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
  const mod = url.searchParams.get("module");
  if (!MODULES[mod]) {
    return errorResponse(400, "invalid_module", "Module tidak dikenal. Gunakan expenses / kasbon / aset.");
  }
  const cfg = MODULES[mod];
  const method = req.method;

  if (method === "GET") {
    const id = cleanId(url.searchParams.get("id"));
    try {
      if (id) {
        const rows = await q(
          `SELECT id, tanggal, ${mod === "expenses" ? "kategori, keterangan, nominal" : mod === "kasbon" ? "keterangan, jumlah" : "nama, harga"}, legacy_id, created_at
             FROM ${cfg.table}
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [id, user.id]
        );
        if (!rows[0]) return errorResponse(404, "not_found", "Data tidak ditemukan.");
        return json({ item: rowToItem(mod, rows[0]) });
      }
      const rows = await q(
        `SELECT id, tanggal, ${mod === "expenses" ? "kategori, keterangan, nominal" : mod === "kasbon" ? "keterangan, jumlah" : "nama, harga"}, legacy_id, created_at
           FROM ${cfg.table}
          WHERE user_id = $1 AND deleted_at IS NULL
          ORDER BY id DESC
          LIMIT 1000`,
        [user.id]
      );
      return json({ items: rows.map((r) => rowToItem(mod, r)) });
    } catch (e) {
      return safeDbError(e);
    }
  }

  if (method === "POST" || method === "PUT") {
    const body = await readJson(req);
    const partial = method === "PUT";
    let id = cleanId(body.id);
    if (method === "PUT" && !id) return errorResponse(400, "invalid_input", "id wajib untuk update.");
    const built = buildValues(mod, body, partial);
    if (built.error) return errorResponse(400, "invalid_input", built.error);
    const values = built.values;
    try {
      if (method === "PUT") {
        const sets = [];
        const params = [];
        for (const f of Object.keys(values)) {
          params.push(values[f]);
          sets.push(`${f} = $${params.length}`);
        }
        if (sets.length === 0) return errorResponse(400, "invalid_input", "Tidak ada field yang diupdate.");
        params.push(id, user.id);
        const rows = await q(
          `UPDATE ${cfg.table}
              SET ${sets.join(", ")}, updated_at = now()
            WHERE id = $${params.length - 1} AND user_id = $${params.length} AND deleted_at IS NULL
            RETURNING id, tanggal, ${mod === "expenses" ? "kategori, keterangan, nominal" : mod === "kasbon" ? "keterangan, jumlah" : "nama, harga"}, legacy_id, created_at, updated_at`,
          params
        );
        if (!rows[0]) return errorResponse(404, "not_found", "Data tidak ditemukan.");
        return json({ item: rowToItem(mod, rows[0]) });
      }

      // POST: create. A client-sent legacyId (localStorage row id) makes edits
      // from the existing UI update in place instead of duplicating rows.
      const legacyId = cleanId(body.legacyId);
      let existing = null;
      if (legacyId) {
        const ex = await q(
          `SELECT id FROM ${cfg.table} WHERE user_id = $1 AND legacy_id = $2 AND deleted_at IS NULL LIMIT 1`,
          [user.id, legacyId]
        );
        if (ex[0]) existing = ex[0];
      }
      if (existing) {
        const fields = Object.keys(values);
        const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(", ");
        const params = [...fields.map((f) => values[f]), existing.id, user.id];
        const rows = await q(
          `UPDATE ${cfg.table}
              SET ${sets}, updated_at = now()
            WHERE id = $${params.length - 1} AND user_id = $${params.length}
            RETURNING id, tanggal, ${mod === "expenses" ? "kategori, keterangan, nominal" : mod === "kasbon" ? "keterangan, jumlah" : "nama, harga"}, legacy_id, created_at, updated_at`,
          params
        );
        return json({ item: rowToItem(mod, rows[0]), updated: true });
      }
      const fields = ["user_id", ...Object.keys(values)];
      const params = [user.id, ...Object.keys(values).map((f) => values[f])];
      if (legacyId) {
        fields.push("legacy_id");
        params.push(legacyId);
      }
      const placeholders = fields.map((_, i) => `$${i + 1}`).join(", ");
      const cols = fields.join(", ");
      const rows = await q(
        `INSERT INTO ${cfg.table} (${cols})
         VALUES (${placeholders})
         RETURNING id, tanggal, ${mod === "expenses" ? "kategori, keterangan, nominal" : mod === "kasbon" ? "keterangan, jumlah" : "nama, harga"}, legacy_id, created_at, updated_at`,
        params
      );
      return json({ item: rowToItem(mod, rows[0]) }, 201);
    } catch (e) {
      return safeDbError(e);
    }
  }

  if (method === "DELETE") {
    const id = cleanId(url.searchParams.get("id"));
    if (!id) return errorResponse(400, "invalid_input", "id wajib untuk delete.");
    try {
      const rows = await q(
        `UPDATE ${cfg.table} SET deleted_at = now(), updated_at = now()
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
          RETURNING id`,
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
