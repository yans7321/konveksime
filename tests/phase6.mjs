// Phase 6 self-test (run: node --test tests/phase6.mjs)
// Exercises the ledger (expenses / kasbon / aset) API end-to-end against an
// in-memory SQL emulator (no real PostgreSQL, no credentials). Covers:
//   - create with legacyId (the bridge path), list, get-one
//   - idempotent re-save via legacyId: update-in-place (updated=true), no dupes
//   - update by server id (PUT, partial)
//   - soft delete + list empties afterwards
//   - ownership isolation: another user gets 404 on GET/PUT/DELETE
//   - validation: amounts must be > 0; required text fields non-empty
//   - invalid module -> 400; unauthenticated -> 401; unknown id -> 404
//   - HTTP routing through the Netlify-like dev server (401 without session)
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://test-local"; // satisfy isDbConfigured()

const { _useTestDriver } = await import("../netlify/functions/_db.mjs");
const authMod = await import("../netlify/functions/auth.mjs");
const ledgerMod = await import("../netlify/functions/ledger.mjs");
const { startServer } = await import("./dev-server.mjs");

// ---------- In-memory SQL emulator (only what ledger.mjs needs) ----------
function makeDriver() {
  const users = new Map();
  const sessions = new Map();
  const tables = { yans_expenses: new Map(), yans_kasbon: new Map(), yans_aset: new Map() };
  let nextId = 1;
  const now = () => new Date();

  return {
    async query(text, params = []) {
      const t = text.replace(/\s+/g, " ").trim();

      if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(t)) return [];
      if (/pg_advisory_xact_lock/.test(t)) return [];
      if (/CREATE TABLE IF NOT EXISTS yans_migrations/.test(t)) return [];
      if (/^CREATE (TABLE|UNIQUE INDEX|INDEX)/.test(t)) return [];
      if (/SELECT name FROM yans_migrations/.test(t)) {
        return [
          { name: "0001_foundation_tables" }, { name: "0002_jobs" },
          { name: "0003_tailoring_pickups" }, { name: "0004_storages" },
          { name: "0006_ledger_modules" },
        ];
      }
      if (/INSERT INTO yans_migrations/.test(t)) return [];

      // ---------- auth (Phase 1 statements) ----------
      if (/SELECT id FROM app_users WHERE lower\(username\) = lower\(\$1\)/.test(t)) {
        return [...users.values()].filter((u) => u.username.toLowerCase() === String(params[0]).toLowerCase()).map((u) => ({ id: u.id }));
      }
      if (/INSERT INTO app_users/.test(t)) {
        const row = { id: nextId++, username: params[0], name: params[1], password_hash: params[2], provider: "local", is_active: true, permissions: JSON.parse(params[3]), email: null };
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

      // ---------- ledger: legacy id lookup ----------
      if (/^SELECT id FROM (yans_expenses|yans_kasbon|yans_aset) WHERE/.test(t)) {
        const store = tables[t.match(/^SELECT id FROM (yans_expenses|yans_kasbon|yans_aset)/)[1]];
        const wherePart = t.slice(t.indexOf(" WHERE "));
        const uP = Number(wherePart.match(/user_id = \$(\d+)/)[1]);
        const lP = Number(wherePart.match(/legacy_id = \$(\d+)/)[1]);
        return [...store.values()].filter((r) => r.user_id === params[uP - 1] && r.legacy_id === params[lP - 1] && !r.deleted_at).slice(0, 1);
      }

      // ---------- ledger: INSERT ... RETURNING ----------
      if (/^INSERT INTO (yans_expenses|yans_kasbon|yans_aset) \(/.test(t)) {
        const store = tables[t.match(/^INSERT INTO (yans_expenses|yans_kasbon|yans_aset)/)[1]];
        const row = { id: nextId++, user_id: params[0], created_at: now(), updated_at: now(), deleted_at: null };
        const cols = t.match(/^INSERT INTO \w+ \((.+?)\)/)[1].split(",").map((c) => c.trim());
        cols.forEach((c, i) => { if (c !== "user_id") row[c] = params[i]; });
        store.set(row.id, row);
        return [row];
      }

      // ---------- ledger: UPDATE ... RETURNING (update-in-place & soft delete) ----------
      if (/^UPDATE (yans_expenses|yans_kasbon|yans_aset) SET/.test(t)) {
        const store = tables[t.match(/^UPDATE (yans_expenses|yans_kasbon|yans_aset)/)[1]];
        const wherePart = t.slice(t.indexOf(" WHERE "));
        const idP = Number(wherePart.match(/id = \$(\d+)/)[1]);
        const uP = Number(wherePart.match(/user_id = \$(\d+)/)[1]);
        const row = store.get(params[idP - 1]);
        if (!row || row.user_id !== params[uP - 1] || row.deleted_at) return [];
        const setPart = t.slice(t.indexOf(" SET ") + 5, t.indexOf(" WHERE "));
        if (/deleted_at = now\(\)/.test(setPart)) row.deleted_at = now();
        const pairRe = /(\w+) = \$(\d+)/g;
        let pm;
        while ((pm = pairRe.exec(setPart)) !== null) {
          if (pm[1] === "updated_at") continue;
          row[pm[1]] = params[Number(pm[2]) - 1];
        }
        row.updated_at = now();
        return [row];
      }

      // ---------- ledger: SELECT list / by id ----------
      if (/^SELECT id, tanggal, (kategori, keterangan, nominal|keterangan, jumlah|nama, harga), legacy_id, created_at(, updated_at)? FROM (yans_expenses|yans_kasbon|yans_aset)/.test(t)) {
        const store = tables[t.match(/FROM (yans_expenses|yans_kasbon|yans_aset)/)[1]];
        const wherePart = t.slice(t.indexOf(" WHERE "));
        const uP = Number(wherePart.match(/user_id = \$(\d+)/)[1]);
        const idM = wherePart.match(/(?:^|AND )id = \$(\d+)/);
        let rows = [...store.values()].filter((r) => r.user_id === params[uP - 1] && !r.deleted_at);
        if (idM) rows = rows.filter((r) => r.id === params[Number(idM[1]) - 1]);
        rows.sort((a, b) => b.id - a.id);
        if (/LIMIT 1000/.test(t)) rows = rows.slice(0, 1000);
        return rows;
      }

      throw new Error("SQL emulator: unsupported statement: " + t.slice(0, 120));
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
  const res = await authMod.default(
    makeReq("POST", { url: "https://yans.test/api/auth", body: { action: "register", name: username, username, password: "password123" } })
  );
  const data = await res.json();
  assert.equal(res.status, 200, "register harus sukses");
  return data.token;
}

// Full CRUD roundtrip for one module.
async function crudModule(mod, fields, amountField) {
  const token = await register("u_" + mod + "_" + Date.now());
  const base = "https://yans.test/api/ledger?module=" + mod;

  // create — the bridge always sends the local (localStorage) id as legacyId
  const legacyId = 1000 + Math.floor(Math.random() * 100000);
  let res = await ledgerMod.default(makeReq("POST", { url: base, token, body: { ...fields, legacyId } }));
  assert.equal(res.status, 201, "create " + mod);
  const created = (await res.json()).item;
  assert.ok(created.id, "server id ada");
  assert.equal(created.legacyId, legacyId);
  assert.equal(Number(created[amountField]), Number(fields[amountField]));

  // idempotent re-save with the same legacyId -> update in place, no duplicate.
  // Fresh create -> 201; legacy update-in-place -> 200 + updated=true.
  const changed = { ...fields, legacyId, [amountField]: Number(fields[amountField]) + 500 };
  res = await ledgerMod.default(makeReq("POST", { url: base, token, body: changed }));
  assert.equal(res.status, 200, "re-save legacyId harus update");
  const secondBody = await res.json();
  assert.equal(secondBody.updated, true, "harus upsert, bukan insert baru");
  assert.equal(secondBody.item.id, created.id, "legacyId harus update baris yang sama");
  assert.equal(Number(secondBody.item[amountField]), Number(fields[amountField]) + 500);

  // get-one by server id
  res = await ledgerMod.default(makeReq("GET", { url: base + "&id=" + created.id, token }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).item.id, created.id);

  // list contains exactly one row (no duplicate from the re-save)
  res = await ledgerMod.default(makeReq("GET", { url: base, token }));
  const listed = await res.json();
  assert.equal(listed.items.length, 1, "list " + mod + " harus 1 row");

  // PUT partial update by server id
  res = await ledgerMod.default(makeReq("PUT", { url: base, token, body: { id: created.id, [amountField]: 999 } }));
  assert.equal(res.status, 200, "put " + mod);
  assert.equal(Number((await res.json()).item[amountField]), 999);

  // ownership: user B never sees or touches user A's row (404, no existence leak)
  const tokenB = await register("u2_" + mod + "_" + Date.now());
  res = await ledgerMod.default(makeReq("GET", { url: base + "&id=" + created.id, token: tokenB }));
  assert.equal(res.status, 404, "isolation GET " + mod);
  res = await ledgerMod.default(makeReq("PUT", { url: base, token: tokenB, body: { id: created.id, [amountField]: 1 } }));
  assert.equal(res.status, 404, "isolation PUT " + mod);
  res = await ledgerMod.default(makeReq("DELETE", { url: base + "&id=" + created.id, token: tokenB }));
  assert.equal(res.status, 404, "isolation DELETE " + mod);

  // delete by owner -> soft delete, list empties
  res = await ledgerMod.default(makeReq("DELETE", { url: base + "&id=" + created.id, token }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted, true);
  res = await ledgerMod.default(makeReq("GET", { url: base, token }));
  assert.equal((await res.json()).items.length, 0, "list kosong setelah delete");
}

test("expenses CRUD + legacyId edit + isolation", async () => {
  await crudModule("expenses", { tanggal: "2026-09-24", kategori: "Operasional", keterangan: "Listrik bengkel", nominal: 150000 }, "nominal");
});

test("kasbon CRUD + legacyId edit + isolation", async () => {
  await crudModule("kasbon", { tanggal: "2026-09-24", keterangan: "Kasbon Pak Budi", jumlah: 250000 }, "jumlah");
});

test("aset CRUD + legacyId edit + isolation", async () => {
  await crudModule("aset", { tanggal: "2026-09-24", nama: "Mesin Jahit 1", harga: 3500000 }, "harga");
});

test("validasi amount: 0, negatif, dan non-numerik ditolak", async () => {
  const token = await register("val_user_" + Date.now());
  const base = "https://yans.test/api/ledger?module=expenses";
  for (const bad of [0, -5000, "abc", null]) {
    const res = await ledgerMod.default(makeReq("POST", { url: base, token, body: { keterangan: "x", nominal: bad } }));
    assert.equal(res.status, 400, "nominal " + JSON.stringify(bad) + " harus ditolak");
  }
  const res2 = await ledgerMod.default(makeReq("POST", { url: base, token, body: { keterangan: "", nominal: 100 } }));
  assert.equal(res2.status, 400, "keterangan kosong ditolak");
});

test("modul tidak dikenal ditolak 400; unauthenticated 401; id tidak ditemukan 404", async () => {
  const token = await register("edge_user_" + Date.now());
  let res = await ledgerMod.default(makeReq("GET", { url: "https://yans.test/api/ledger?module=hack", token }));
  assert.equal(res.status, 400);
  res = await ledgerMod.default(makeReq("GET", { url: "https://yans.test/api/ledger?module=expenses" }));
  assert.equal(res.status, 401);
  res = await ledgerMod.default(makeReq("DELETE", { url: "https://yans.test/api/ledger?module=expenses&id=999999", token }));
  assert.equal(res.status, 404);
});

test("HTTP routing: /api/ledger terdaftar dan auth berjalan", async () => {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(base + "/api/ledger?module=expenses");
    assert.equal(res.status, 401); // routing OK, auth menolak
    res = await fetch(base + "/api/ledger?module=expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keterangan: "x", nominal: 10 }),
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
