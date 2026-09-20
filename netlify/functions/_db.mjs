// Server-side only. Never imported by browser code.
// Credentials come exclusively from environment variables (Netlify DB / env vars).
import crypto from "node:crypto";
import pg from "pg";

// PostgreSQL int8 (bigint) values must arrive as JS numbers so IDs stay usable
// in the frontend mirror (legacy ids are Date.now()-based, far below 2^53).
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

let pool = null;

function resolveConnString() {
  return (
    process.env.NETLIFY_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.NETLIFY_DB_URL ||
    process.env.NETLIFY_POSTGRES_URL ||
    process.env.POSTGRES_URL ||
    null
  );
}

export function isDbConfigured() {
  return Boolean(resolveConnString());
}

export function getPool() {
  if (!pool) {
    const cs = resolveConnString();
    if (!cs) throw new Error("DB_NOT_CONFIGURED");
    pool = new pg.Pool({
      connectionString: cs,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 15000,
      connectionTimeoutMillis: 8000,
    });
    pool.on("error", () => {
      pool = null;
    });
  }
  return pool;
}

// Parameterized query helper. Never interpolate user input into SQL strings.
export async function q(text, params) {
  if (testDriver) return testDriver.query(text, params);
  const res = await getPool().query(text, params);
  return res.rows;
}

// Test-only seam: allows the self-test to inject an in-memory driver instead of
// pg. Never set in production; no behavior change when unset.
let testDriver = null;
export function _useTestDriver(driver) {
  testDriver = driver;
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `s2$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [tag, salt, hash] = String(stored).split("$");
  if (tag !== "s2" || !salt || !hash) return false;
  const calc = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(calc, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function issueSession(userId, provider) {
  const token = crypto.randomBytes(32).toString("hex");
  await q(
    "INSERT INTO app_sessions (token_hash, user_id, provider) VALUES ($1, $2, $3)",
    [hashToken(token), userId, provider || "local"]
  );
  return token;
}

// Reads the bearer token and resolves the active user. Returns null when invalid.
export async function resolveSession(req) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const rows = await q(
    `SELECT u.id, u.username, u.email, u.name, u.provider, u.is_active, u.permissions
       FROM app_sessions s
       JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = $1::text
        AND s.expires_at > now()
        AND u.is_active = true
      LIMIT 1`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

// Idempotent, ordered migrations. Safe to run repeatedly (and concurrently:
// the advisory lock serializes workers so parallel lambdas cannot race).
const MIGRATIONS = [
  {
    name: "0001_foundation_tables",
    statements: [
      `CREATE TABLE IF NOT EXISTS app_users (
         id               bigserial PRIMARY KEY,
         username         text UNIQUE,
         email            text UNIQUE,
         name             text NOT NULL,
         password_hash    text,
         provider         text NOT NULL DEFAULT 'local',
         provider_user_id text,
         is_active        boolean NOT NULL DEFAULT true,
         permissions      jsonb NOT NULL DEFAULT '[]'::jsonb,
         created_at       timestamptz NOT NULL DEFAULT now(),
         updated_at       timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS app_sessions (
         token_hash text PRIMARY KEY,
         user_id    bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
         provider   text NOT NULL DEFAULT 'local',
         created_at timestamptz NOT NULL DEFAULT now(),
         expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
       )`,
      `CREATE TABLE IF NOT EXISTS yans_pekerja (
         id         bigserial PRIMARY KEY,
         user_id    bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
         nama       text NOT NULL,
         legacy_id  bigint,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         deleted_at timestamptz,
         CONSTRAINT yans_pekerja_user_nama_key UNIQUE (user_id, nama),
         CONSTRAINT yans_pekerja_user_legacy_key UNIQUE (user_id, legacy_id)
       )`,
      `CREATE TABLE IF NOT EXISTS yans_perusahaan (
         id         bigserial PRIMARY KEY,
         user_id    bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
         nama       text NOT NULL,
         pic        text,
         telepon    text,
         catatan    text,
         legacy_id  bigint,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         deleted_at timestamptz,
         CONSTRAINT yans_perusahaan_user_nama_key UNIQUE (user_id, nama),
         CONSTRAINT yans_perusahaan_user_legacy_key UNIQUE (user_id, legacy_id)
       )`,
      `CREATE TABLE IF NOT EXISTS yans_jenis_pekerjaan (
         id             bigserial PRIMARY KEY,
         user_id        bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
         kode           text NOT NULL,
         nama           text NOT NULL,
         kategori_biaya text NOT NULL DEFAULT 'produksi' CHECK (kategori_biaya IN ('produksi','lainnya')),
         legacy_id      bigint,
         is_active      boolean NOT NULL DEFAULT true,
         created_at     timestamptz NOT NULL DEFAULT now(),
         updated_at     timestamptz NOT NULL DEFAULT now(),
         deleted_at     timestamptz,
         CONSTRAINT yans_jenis_user_kode_key UNIQUE (user_id, kode),
         CONSTRAINT yans_jenis_user_legacy_key UNIQUE (user_id, legacy_id)
       )`,
      `CREATE TABLE IF NOT EXISTS yans_workbook_state (
         user_id    bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
         kind       text NOT NULL,
         payload    jsonb NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT yans_workbook_state_pk PRIMARY KEY (user_id, kind)
       )`,
    ],
  },
];

export async function runMigrations() {
  if (!isDbConfigured()) throw new Error("DB_NOT_CONFIGURED");
  const client = testDriver
    ? { query: async (text, params) => ({ rows: await testDriver.query(text, params) }), release: () => {} }
    : await getPool().connect();
  try {
    await client.query("BEGIN");
    // Serialize concurrent lambda cold-starts; released at COMMIT/ROLLBACK.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('yans_migrations'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS yans_migrations (
         name       text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const { rows } = await client.query("SELECT name FROM yans_migrations");
    const done = new Set(rows.map((r) => r.name));
    const applied = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.name)) continue;
      for (const stmt of m.statements) {
        await client.query(stmt);
      }
      await client.query("INSERT INTO yans_migrations (name) VALUES ($1)", [m.name]);
      applied.push(m.name);
    }
    await client.query("COMMIT");
    return applied;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
