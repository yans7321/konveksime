// Health check. GET /api/health
// Reports configuration status only; never exposes credentials or connection details.
import { isDbConfigured } from "./_db.mjs";
import { isGoogleConfigured } from "./_google.mjs";
import { json } from "./_http.mjs";

export default async () => {
  let db = { configured: false, ok: false };
  if (isDbConfigured()) {
    db.configured = true;
    try {
      await runMigrationsSafe();
      db.ok = true;
      db.migrated = true;
    } catch {
      db.ok = false;
    }
  }
  return json({ ok: true, db, google: { configured: isGoogleConfigured() } });
};

async function runMigrationsSafe() {
  const mod = await import("./_db.mjs");
  return mod.runMigrations();
}
