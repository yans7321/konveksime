// Phase 1 self-test (run: node tests/phase1.mjs)
// Exercises auth + sync function logic end-to-end against an in-memory SQL
// emulator (no real PostgreSQL, no credentials). Covers:
//   1. migrations are idempotent
//   2. register / login / me / logout (scrypt password hashes, bearer sessions)
//   3. pekerja & perusahaan sync: upsert is idempotent (no duplicates),
//      per-user isolation (user B never sees user A's rows)
//   4. input validation rejects bad payloads
//   5. safeDbError never leaks driver details
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://test-local"; // satisfy isDbConfigured()

const { _useTestDriver, runMigrations } = await import("../netlify/functions/_db.mjs");
const authMod = await import("../netlify/functions/auth.mjs");
const syncMod = await import("../netlify/functions/sync.mjs");
const httpMod = await import("../netlify/functions/_http.mjs");

// ---------- In-memory SQL emulator (just enough for our statements) ----------
function makeDriver() {
  const users = new Map(); // id -> row
  const sessions = new Map(); // token_hash -> row
  const pekerja = new Map(); // `${user_id}|${nama}` -> row
  const perusahaan = new Map();
  let nextId = { users: 1, pekerja: 1, perusahaan: 1 };

  const like = (s, pat) => new RegExp("^" + pat.replace(/[%_]/g, (c) => "\\" + c).split("%").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");

  return {
    async query(text, params = []) {
      const t = text.replace(/\s+/g, " ").trim();

      if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(t)) return [];
      if (/pg_advisory_xact_lock/.test(t)) return [];
      if (/CREATE TABLE IF NOT EXISTS yans_migrations/.test(t)) return [];
      if (/SELECT name FROM yans_migrations/.test(t)) return [{ name: "0001_foundation_tables" }, { name: "0002_jobs" }, { name: "0003_tailoring_pickups" }];
      if (/INSERT INTO yans_migrations/.test(t)) return [];

      if (/SELECT id FROM app_users WHERE lower\(username\) = lower\(\$1\)/.test(t)) {
        const found = [...users.values()].filter((u) => u.username.toLowerCase() === String(params[0]).toLowerCase());
        return found.map((u) => ({ id: u.id }));
      }
      if (/INSERT INTO app_users \(username, name, password_hash, provider, permissions\)/.test(t)) {
        const row = {
          id: nextId.users++, username: params[0], name: params[1], password_hash: params[2],
          provider: "local", is_active: true, permissions: JSON.parse(params[3]),
          email: null, created_at: new Date(), updated_at: new Date(),
        };
        users.set(row.id, row);
        return [row];
      }
      if (/SELECT id, username, email, name, password_hash/.test(t)) {
        const found = [...users.values()].filter((u) => u.username.toLowerCase() === String(params[0]).toLowerCase());
        return found.slice(0, 1);
      }
      if (/INSERT INTO app_sessions/.test(t)) {
        sessions.set(params[0], { token_hash: params[0], user_id: params[1], provider: params[2], expires_at: new Date(Date.now() + 864e5) });
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

      if (/INSERT INTO yans_pekerja \(user_id, nama, legacy_id\)/.test(t)) {
        const key = params[0] + "|" + params[1];
        const ex = pekerja.get(key);
        if (ex) {
          if (params[2] != null) ex.legacy_id = params[2];
          ex.deleted_at = null;
          return [];
        }
        pekerja.set(key, { id: nextId.pekerja++, user_id: params[0], nama: params[1], legacy_id: params[2], deleted_at: null });
        return [];
      }
      if (/SELECT id, nama, legacy_id AS "legacyId"/.test(t)) {
        return [...pekerja.values()]
          .filter((r) => r.user_id === params[0] && !r.deleted_at)
          .sort((a, b) => a.id - b.id)
          .map((r) => ({ id: r.id, nama: r.nama, legacyId: r.legacy_id, createdAt: new Date(), updatedAt: new Date() }));
      }
      if (/INSERT INTO yans_perusahaan \(user_id, nama, pic, telepon, catatan, legacy_id\)/.test(t)) {
        const key = params[0] + "|" + params[1];
        const ex = perusahaan.get(key);
        if (ex) {
          ex.pic = params[2]; ex.telepon = params[3]; ex.catatan = params[4];
          if (params[5] != null) ex.legacy_id = params[5];
          ex.deleted_at = null;
          return [];
        }
        perusahaan.set(key, { id: nextId.perusahaan++, user_id: params[0], nama: params[1], pic: params[2], telepon: params[3], catatan: params[4], legacy_id: params[5], deleted_at: null });
        return [];
      }
      if (/SELECT id, nama, pic, telepon, catatan, legacy_id AS "legacyId"/.test(t)) {
        return [...perusahaan.values()]
          .filter((r) => r.user_id === params[0] && !r.deleted_at)
          .sort((a, b) => a.id - b.id)
          .map((r) => ({ id: r.id, nama: r.nama, pic: r.pic, telepon: r.telepon, catatan: r.catatan, legacyId: r.legacy_id, createdAt: new Date(), updatedAt: new Date() }));
      }
      if (/INSERT INTO yans_jenis_pekerjaan/.test(t)) return [];
      if (/SELECT id, kode, nama, kategori_biaya/.test(t)) return [];

      throw new Error("SQL emulator: unsupported statement: " + t.slice(0, 120));
    },
  };
}

function req(method, body, token, url = "https://yans.test/api/x") {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", "Bearer " + token);
  return {
    method,
    headers,
    url,
    json: async () => body,
  };
}

test("migrations + full auth/sync flow", async (t) => {
  const driver = makeDriver();
  _useTestDriver(driver);
  await runMigrations(); // must not throw
  await runMigrations(); // idempotent

  const auth = authMod.default;
  const sync = syncMod.default;

  // --- register ---
  let res = await auth(req("POST", { action: "register", name: "Pemilik YANS", username: "pemilik", password: "rahasia123" }), {});
  assert.equal(res.status, 200);
  const reg = await res.json();
  assert.ok(reg.token && reg.user.id && reg.user.username === "pemilik");
  const tokenA = reg.token;
  const idA = reg.user.id;

  // duplicate username
  res = await auth(req("POST", { action: "register", name: "x", username: "PEMILIK", password: "aaaa" }), {});
  assert.equal(res.status, 409);

  // invalid input
  res = await auth(req("POST", { action: "register", name: "", username: "y", password: "aaaa" }), {});
  assert.equal(res.status, 400);

  // --- login (wrong + right) ---
  res = await auth(req("POST", { action: "login", username: "pemilik", password: "salah" }), {});
  assert.equal(res.status, 401);
  res = await auth(req("POST", { action: "login", username: "pemilik", password: "rahasia123" }), {});
  assert.equal(res.status, 200);
  const login = await res.json();
  assert.ok(login.token);

  // --- me ---
  res = await auth(req("POST", { action: "me" }, tokenA), {});
  const me = await res.json();
  assert.equal(me.user.id, idA);

  // --- pekerja sync (user A) ---
  res = await sync(req("POST", { kind: "pekerja", items: [{ nama: "Pak Budi" }, { nama: "Bu Sari" }] }, tokenA));
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.items.length, 2);

  // idempotent re-upsert: no duplicates
  res = await sync(req("POST", { kind: "pekerja", items: [{ nama: "Pak Budi" }, { nama: "Bu Sari" }] }, tokenA));
  body = await res.json();
  assert.equal(body.items.length, 2, "re-upsert must not duplicate pekerja");

  // --- perusahaan sync + update path ---
  res = await sync(req("POST", { kind: "perusahaan", items: [{ nama: "Toko Maju", pic: "Rina", telepon: "0812", catatan: "" }] }, tokenA));
  body = await res.json();
  assert.equal(body.items.length, 1);
  res = await sync(req("POST", { kind: "perusahaan", items: [{ nama: "Toko Maju", pic: "Rina V2", telepon: "0813" }] }, tokenA));
  body = await res.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].pic, "Rina V2");
  assert.equal(body.items[0].telepon, "0813");

  // --- per-user isolation ---
  let resB = await auth(req("POST", { action: "register", name: "User Lain", username: "userb", password: "bbb22222" }), {});
  const tokenB = (await resB.json()).token;
  res = await sync(req("POST", { kind: "pekerja", items: [{ nama: "Pak Budi" }] }, tokenB));
  body = await res.json();
  assert.equal(body.items.length, 1); // only B's own row

  // A still sees exactly their two rows
  res = await sync(req("GET", null, tokenA, "https://yans.test/api/sync?kind=pekerja"), null);
  body = await res.json();
  assert.equal(body.items.length, 2);

  // --- unauthorized / bad input ---
  res = await sync(req("POST", { kind: "pekerja", items: [] }, null));
  assert.equal(res.status, 401);
  res = await sync(req("POST", { kind: "hacker", items: [] }, tokenA));
  assert.equal(res.status, 400);
  res = await sync(req("POST", { kind: "pekerja", items: "not-array" }, tokenA));
  assert.equal(res.status, 400);

  // --- logout invalidates the session ---
  res = await auth(req("POST", { action: "logout" }, tokenA), {});
  assert.equal(res.status, 200);
  res = await auth(req("POST", { action: "me" }, tokenA), {});
  body = await res.json();
  assert.equal(body.user, null);

  // --- safeDbError never leaks internals ---
  const safe = httpMod.safeDbError(new Error("password authentication failed for user xyz at 10.0.0.1"));
  assert.equal((await safe.json()).message, "Terjadi kesalahan database. Coba lagi nanti.");
  assert.equal(safe.status, 500);
});

test("google state CSRF verification", async () => {
  const g = await import("../netlify/functions/_google.mjs");
  const fakeReq = (cookie, state) => ({
    headers: new Headers(
      Object.assign(
        { "x-forwarded-proto": "https", host: "yans.test" },
        cookie ? { cookie } : {}
      )
    ),
  });
  const st = g.createState(fakeReq(null, null));
  // valid: same nonce in cookie and param
  assert.equal(g.verifyState(fakeReq(`yans_g_state=abc`, "x"), null), false);
  const cookie = st.cookie.split(";")[0]; // "yans_g_state=<nonce>"
  assert.equal(g.verifyState(fakeReq(cookie), st.value), true);
  assert.equal(g.verifyState(fakeReq(cookie), st.value + "x"), false);
  assert.equal(g.verifyState(fakeReq(cookie), "deadbeef." + st.value.split(".")[1]), false);
  assert.equal(g.verifyState(fakeReq("yans_g_state=other"), st.value), false);
  assert.equal(g.verifyState(fakeReq(null), st.value), false);
});
