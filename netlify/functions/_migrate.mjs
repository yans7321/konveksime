// Standalone migration runner (also usable locally):
//   node netlify/functions/_migrate.mjs
// Requires the PostgreSQL connection string in the environment.
import { runMigrations, isDbConfigured } from "./_db.mjs";

if (!isDbConfigured()) {
  console.error("No PostgreSQL connection env var found (NETLIFY_DATABASE_URL / DATABASE_URL).");
  process.exit(1);
}

runMigrations()
  .then((applied) => {
    console.log(
      applied.length ? `Applied migrations: ${applied.join(", ")}` : "Migrations up to date."
    );
    process.exit(0);
  })
  .catch((e) => {
    console.error("Migration failed:", e.message);
    process.exit(1);
  });
