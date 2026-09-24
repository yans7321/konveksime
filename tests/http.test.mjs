// HTTP-level integration test using the Netlify-like dev server (real routing,
// real function invocation, real Request/Response objects) with the in-memory
// SQL driver injected into the functions' module graph. Verifies:
//   - routing /api/auth, /api/sync, /api/health, /api/auth/google
//   - register -> token -> sync pekerja/perusahaan -> me -> logout
//   - per-user isolation over HTTP
//   - static hosting of index.html / app-api.js / styles.css
// Run: node --test tests/http.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://test-local"; // satisfy isDbConfigured()

const { _useTestDriver } = await import("../netlify/functions/_db.mjs");
const { startServer } = await import("./dev-server.mjs");

function makeDriver() {
  const users = new Map();
  const sessions = new Map();
  const pekerja = new Map();
  const perusahaan = new Map();
  let nextId = { users: 1, pekerja: 1, perusahaan: 1 };
  return {
    async query(text, params = []) {
      const t = text.replace(/\s+/g, " ").trim();
      if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(t)) return [];
      if (/pg_advisory_xact_lock/.test(t)) return [];
      if (/CREATE TABLE IF NOT EXISTS yans_migrations/.test(t)) return [];
      if (/SELECT name FROM yans_migrations/.test(t)) return [{ name: "0001_foundation_tables" }, { name: "0002_jobs" }, { name: "0003_tailoring_pickups" }, { name: "0004_storages" }, { name: "0006_ledger_modules" }, { name: "0007_shipments" }];
      if (/INSERT INTO yans_migrations/.test(t)) return [];
      if (/SELECT id FROM app_users WHERE lower\(username\)/.test(t)) {
        return [...users.values()].filter((u) => u.username.toLowerCase() === String(params[0]).toLowerCase()).map((u) => ({ id: u.id }));
      }
      if (/INSERT INTO app_users \(username, name, password_hash/.test(t)) {
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
      if (/DELETE FROM app_sessions/.test(t)) {
        sessions.delete(params[1]);
        return [];
      }
      if (/FROM app_sessions s\s+JOIN app_users u/.test(t)) {
        const s = sessions.get(params[0]);
        if (!s || s.expires_at <= new Date()) return [];
        const u = users.get(s.user_id);
        if (!u || !u.is_active) return [];
        return [{ id: u.id, username: u.username, email: u.email, name: u.name, provider: u.provider, is_active: u.is_active, permissions: u.permissions }];
      }
      if (/INSERT INTO yans_pekerja/.test(t)) {
        const key = params[0] + "|" + params[1];
        const ex = pekerja.get(key);
        if (ex) { if (params[2] != null) ex.legacy_id = params[2]; ex.deleted_at = null; return []; }
        pekerja.set(key, { id: nextId.pekerja++, user_id: params[0], nama: params[1], legacy_id: params[2], deleted_at: null });
        return [];
      }
      if (/SELECT id, nama, legacy_id AS "legacyId"/.test(t)) {
        return [...pekerja.values()].filter((r) => r.user_id === params[0] && !r.deleted_at).sort((a, b) => a.id - b.id)
          .map((r) => ({ id: r.id, nama: r.nama, legacyId: r.legacy_id }));
      }
      if (/INSERT INTO yans_perusahaan/.test(t)) {
        const key = params[0] + "|" + params[1];
        const ex = perusahaan.get(key);
        if (ex) { ex.pic = params[2]; ex.telepon = params[3]; ex.catatan = params[4]; if (params[5] != null) ex.legacy_id = params[5]; ex.deleted_at = null; return []; }
        perusahaan.set(key, { id: nextId.perusahaan++, user_id: params[0], nama: params[1], pic: params[2], telepon: params[3], catatan: params[4], legacy_id: params[5], deleted_at: null });
        return [];
      }
      if (/SELECT id, nama, pic, telepon, catatan, legacy_id AS "legacyId"/.test(t)) {
        return [...perusahaan.values()].filter((r) => r.user_id === params[0] && !r.deleted_at).sort((a, b) => a.id - b.id)
          .map((r) => ({ id: r.id, nama: r.nama, pic: r.pic, telepon: r.telepon, catatan: r.catatan, legacyId: r.legacy_id }));
      }
      if (/INSERT INTO yans_jenis_pekerjaan/.test(t)) return [];
      if (/SELECT id, kode, nama, kategori_biaya/.test(t)) return [];
      throw new Error("SQL emulator: unsupported statement: " + t.slice(0, 120));
    },
  };
}

test("HTTP integration: routing, auth flow, sync, isolation, static", async () => {
  _useTestDriver(makeDriver());
  const server = await startServer(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    // static hosting
    let res = await fetch(base + "/");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /app-api\.js" defer/);
    assert.match(html, /YansGoogleSignIn/);
    res = await fetch(base + "/app-api.js");
    assert.equal(res.status, 200);
    res = await fetch(base + "/styles.css");
    assert.equal(res.status, 200);

    // health reports db configured (test driver)
    res = await fetch(base + "/api/health");
    const health = await res.json();
    assert.equal(health.db.configured, true);
    assert.equal(health.db.ok, true);

    // google start without OAuth creds -> structured 503 (not a redirect)
    res = await fetch(base + "/api/auth/google");
    assert.equal(res.status, 503);
    const g = await res.json();
    assert.equal(g.error, "google_not_configured");

    // register over HTTP
    res = await fetch(base + "/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "register", name: "Pemilik", username: "pemilik", password: "rahasia123" }),
    });
    assert.equal(res.status, 200);
    const reg = await res.json();
    assert.ok(reg.token);
    const token = reg.token;

    // sync pekerja over HTTP (twice -> idempotent)
    const post = (path, body, tok) =>
      fetch(base + path, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, tok ? { Authorization: "Bearer " + tok } : {}),
        body: JSON.stringify(body),
      });
    res = await post("/api/sync", { kind: "pekerja", items: [{ nama: "Pak Budi" }, { nama: "Bu Sari" }] }, token);
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.items.length, 2);
    res = await post("/api/sync", { kind: "pekerja", items: [{ nama: "Pak Budi" }, { nama: "Bu Sari" }] }, token);
    body = await res.json();
    assert.equal(body.items.length, 2, "no duplicates on re-sync");

    // perusahaan upsert + update
    res = await post("/api/sync", { kind: "perusahaan", items: [{ nama: "Toko Maju", pic: "Rina" }] }, token);
    body = await res.json();
    assert.equal(body.items.length, 1);
    res = await post("/api/sync", { kind: "perusahaan", items: [{ nama: "Toko Maju", pic: "Rina V2", telepon: "0813" }] }, token);
    body = await res.json();
    assert.equal(body.items[0].pic, "Rina V2");
    assert.equal(body.items[0].telepon, "0813");

    // me over HTTP
    res = await fetch(base + "/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ action: "me" }),
    });
    body = await res.json();
    assert.equal(body.user.username, "pemilik");

    // second user isolation
    res = await post("/api/auth", { action: "register", name: "B", username: "userb", password: "bbb22222" });
    const tokenB = (await res.json()).token;
    res = await post("/api/sync", { kind: "pekerja", items: [{ nama: "Pak Budi" }] }, tokenB);
    body = await res.json();
    assert.equal(body.items.length, 1);
    res = await fetch(base + "/api/sync?kind=pekerja", { headers: { Authorization: "Bearer " + token } });
    body = await res.json();
    assert.equal(body.items.length, 2);

    // unauthorized
    res = await post("/api/sync", { kind: "pekerja", items: [] });
    assert.equal(res.status, 401);

    // logout invalidates
    res = await post("/api/auth", { action: "logout" }, token);
    assert.equal(res.status, 200);
    res = await fetch(base + "/api/sync?kind=pekerja", { headers: { Authorization: "Bearer " + token } });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});
