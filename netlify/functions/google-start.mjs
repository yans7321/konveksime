// Starts the Google OAuth flow. GET /api/auth/google
// Redirects to Google when configured, otherwise explains the required manual setup.
import { isDbConfigured, runMigrations } from "./_db.mjs";
import { isGoogleConfigured, buildAuthUrl, createState } from "./_google.mjs";
import { json, safeDbError } from "./_http.mjs";

export default async (req, context) => {
  if (isDbConfigured()) {
    try {
      await runMigrations();
    } catch (e) {
      return safeDbError(e);
    }
  }
  if (!isDbConfigured() || !isGoogleConfigured()) {
    return json(
      {
        error: "google_not_configured",
        message:
          "Google login belum aktif. Tambahkan environment variable GOOGLE_CLIENT_ID dan GOOGLE_CLIENT_SECRET di Netlify, lalu daftarkan redirect URI {site}/api/auth/google/callback di Google Cloud Console.",
      },
      503
    );
  }
  const state = createState(req);
  const auth = buildAuthUrl(req, context, state.value);
  return new Response(null, {
    status: 302,
    headers: { Location: auth, "Set-Cookie": state.cookie, "Cache-Control": "no-store" },
  });
};
