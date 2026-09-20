// Google OAuth callback. GET /api/auth/google/callback
// Validates the signed state (CSRF), exchanges the code server-side (secret stays
// in env), upserts the user with a stable identity (provider + provider_user_id),
// and posts the session to the opener popup.
import { isDbConfigured, runMigrations, q, issueSession } from "./_db.mjs";
import { isGoogleConfigured, verifyState, clearStateCookie, exchangeCode, fetchUserInfo } from "./_google.mjs";
import { safeDbError } from "./_http.mjs";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function page(status, bodyHtml, payload, extraHeaders = {}) {
  const payloadScript = payload
    ? `<script type="application/json" id="p">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>`
    : "";
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Konveksi YANS — Google Sign-In</title></head>
     <body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
     <div id="p-container" style="max-width:32rem;padding:2rem;text-align:center;color:#0f172a">${bodyHtml}</div>
     ${payloadScript}
     <script>
       try {
         var el = document.getElementById('p');
         if (el && window.opener) {
           window.opener.postMessage({ type: 'yans-google-auth', payload: JSON.parse(el.textContent) }, '*');
           setTimeout(function () { window.close(); }, 400);
         } else if (el) {
           setTimeout(function () { window.location.href = '/'; }, 800);
         }
       } catch (e) {}
     </script>
     </body></html>`,
    { status, headers: Object.assign({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, extraHeaders) }
  );
}

export default async (req, context) => {
  const stateCookie = clearStateCookie();
  try {
    if (!isDbConfigured() || !isGoogleConfigured()) {
      return page(503, "Google login belum dikonfigurasi di server. (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET belum ada.)", null, { "Set-Cookie": stateCookie });
    }
    const url = new URL(req.url);
    if (!verifyState(req, url.searchParams.get("state"))) {
      return page(400, "Sesi login Google tidak valid atau kedaluwarsa. Tutup jendela ini dan coba lagi.", null, { "Set-Cookie": stateCookie });
    }
    if (url.searchParams.get("error")) {
      return page(400, "Login Google dibatalkan. Silakan coba lagi.", null, { "Set-Cookie": stateCookie });
    }
    const code = url.searchParams.get("code");
    if (!code) return page(400, "Kode otorisasi tidak ditemukan.", null, { "Set-Cookie": stateCookie });

    if (isDbConfigured()) await runMigrations();

    const tokens = await exchangeCode(code, req, context);
    if (!tokens.access_token) return page(502, "Gagal menukar kode otorisasi dengan Google.", null, { "Set-Cookie": stateCookie });
    const info = await fetchUserInfo(tokens.access_token);
    if (!info.sub || !info.email) return page(502, "Profil Google tidak lengkap.", null, { "Set-Cookie": stateCookie });

    // Stable identity: (provider, provider_user_id). Link by email when possible.
    const byProvider = await q(
      `SELECT id, username, email, name, provider, is_active, permissions
         FROM app_users WHERE provider = 'google' AND provider_user_id = $1 LIMIT 1`,
      [info.sub]
    );
    let u = byProvider[0];
    if (!u) {
      const byEmail = await q(
        `SELECT id, username, email, name, provider, is_active, permissions
           FROM app_users WHERE lower(email) = lower($1) LIMIT 1`,
        [info.email]
      );
      if (byEmail[0]) {
        const upd = await q(
          `UPDATE app_users
              SET provider = 'google', provider_user_id = $2, email = $3,
                  name = COALESCE(NULLIF(name, ''), $4), updated_at = now()
            WHERE id = $1
          RETURNING id, username, email, name, provider, is_active, permissions`,
          [byEmail[0].id, info.sub, info.email, info.name || info.email]
        );
        u = upd[0];
      } else {
        const ins = await q(
          `INSERT INTO app_users (email, name, provider, provider_user_id, permissions)
           VALUES ($1, $2, 'google', $3, '[]'::jsonb)
           RETURNING id, username, email, name, provider, is_active, permissions`,
          [info.email, info.name || info.email, info.sub]
        );
        u = ins[0];
      }
    }
    if (!u.is_active) return page(403, "Akun ini tidak aktif. Hubungi administrator.", null, { "Set-Cookie": stateCookie });

    const token = await issueSession(u.id, "google");
    return page(200, "Login berhasil. Jendela ini akan tertutup otomatis.", { user: u, token }, { "Set-Cookie": stateCookie });
  } catch (e) {
    return safeDbError(e);
  }
};
