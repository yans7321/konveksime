// Shared authentication endpoints for the ERP.
// POST /api/auth  { action: "login" | "register" | "logout" | "me" }
import { runMigrations, isDbConfigured, q, hashPassword, verifyPassword, issueSession, resolveSession, hashToken } from "./_db.mjs";
import { json, errorResponse, readJson, isNonEmptyString, sanitizePermissions, safeDbError } from "./_http.mjs";

const DEFAULT_PERMS = [
  "tab1",
  "tab2",
  "tab3",
  "tab5",
  "tab4",
  "kasbon",
  "tab6",
  "tab7",
  "aset",
  "arsip",
  "member",
];

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    name: u.name,
    provider: u.provider,
    permissions: u.permissions || [],
  };
}

export default async (req, context) => {
  // Idempotent migrations run on first API use; safe to call repeatedly.
  if (isDbConfigured()) {
    try {
      await runMigrations();
    } catch (e) {
      return safeDbError(e);
    }
  }

  const body = await readJson(req);
  const action = body.action;

  try {
    if (action === "register") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!isNonEmptyString(name, 100) || !isNonEmptyString(username, 50) || password.length < 4 || password.length > 200) {
        return errorResponse(400, "invalid_input", "Nama, username, dan password wajib diisi (password min. 4 karakter).");
      }
      const existing = await q("SELECT id FROM app_users WHERE lower(username) = lower($1)", [username]);
      if (existing.length > 0) {
        return errorResponse(409, "username_taken", "Username sudah terdaftar.");
      }
      const inserted = await q(
        `INSERT INTO app_users (username, name, password_hash, provider, permissions)
         VALUES ($1, $2, $3, 'local', $4::jsonb)
         RETURNING id, username, email, name, provider, is_active, permissions`,
        [username, name, hashPassword(password), JSON.stringify(DEFAULT_PERMS)]
      );
      const u = inserted[0];
      const token = await issueSession(u.id, "local");
      return json({ user: publicUser(u), token });
    }

    if (action === "login") {
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!username || !password) {
        return errorResponse(400, "invalid_input", "Username dan password wajib diisi.");
      }
      const found = await q(
        `SELECT id, username, email, name, password_hash, provider, is_active, permissions
           FROM app_users
          WHERE lower(username) = lower($1)
          LIMIT 1`,
        [username]
      );
      const u = found[0];
      // Uniform failure message; don't reveal whether the username exists.
      if (!u || !u.is_active || !verifyPassword(password, u.password_hash)) {
        return errorResponse(401, "invalid_credentials", "Username atau password salah.");
      }
      const token = await issueSession(u.id, "local");
      return json({ user: publicUser(u), token });
    }

    if (action === "logout") {
      const user = isDbConfigured() ? await resolveSession(req) : null;
      if (user) {
        const auth = req.headers.get("authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        if (token) {
          await q("DELETE FROM app_sessions WHERE user_id = $1 AND token_hash = $2", [
            user.id,
            hashToken(token),
          ]);
        }
      }
      return json({ ok: true });
    }

    if (action === "me") {
      if (!isDbConfigured()) return json({ user: null });
      const user = await resolveSession(req);
      return json({ user: user ? publicUser(user) : null });
    }

    return errorResponse(400, "unknown_action", "Unknown auth action.");
  } catch (e) {
    return safeDbError(e);
  }
};
