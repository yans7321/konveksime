# Project Guide

## Architecture

This is a static, single-page ERP application. `index.html` contains the complete original markup, application state, business logic, and rendering functions. `styles.css` is an additive presentation layer that modernizes the interface without changing application content or behavior.

Phase 1 added a server-side foundation WITHOUT changing the original app:
- `app-api.js` (deferred, loaded after the inline script) wraps the existing `handleLogin`/`handleRegister`/`handleLogout` with server-first calls and automatic localStorage fallback. It also syncs `pekerja`/`perusahaan` to the database after sign-in.
- `netlify/functions/*.mjs` + `netlify.toml` provide `/api/auth`, `/api/sync`, `/api/health` and Google OAuth against the existing Netlify PostgreSQL database. Credentials come only from environment variables.
- localStorage remains the source of truth in Phase 1; the database is a per-user mirror. Never delete or bulk-migrate localStorage data here.

## Key files

- `index.html`: page structure and all ERP behavior (keep edits minimal and additive).
- `app-api.js`: API bridge (auth hooks, Google sign-in, pekerja/perusahaan sync). Runs in page scope alongside the inline script.
- `netlify/functions/`: server-side API (never import in browser code; never put credentials here).
- `styles.css`: MIUI-inspired visual system, responsive rules, interaction states, and print refinements.
- `docs/PHASE1.md`: technical notes for the database/auth foundation.
- `.netlify/results.md`: delivery summary generated for the current task.

## Conventions

- Keep all user-facing copy and existing data fields unchanged unless the user explicitly requests content edits.
- Make visual changes in `styles.css` where possible instead of rewriting application markup.
- Preserve existing element IDs and inline event handlers because the JavaScript relies on them. `app-api.js` relies on the global `handleLogin`/`handleRegister`/`handleLogout`/`deletePekerja`/`deletePerusahaan` bindings.
- Maintain mobile behavior at the `767px` breakpoint and keep print-specific invoice behavior intact.
- All SQL must use parameterized queries; every data query must be scoped by the session's `user_id`. Never place credentials in frontend code, `index.html`, or localStorage.
- Verify JS changes with `npm test` (in-memory driver + HTTP integration; no real DB needed).

## Non-obvious decisions

The project intentionally keeps the source application's CDN dependencies and browser storage behavior. The redesign is isolated in a stylesheet so the original operational logic remains auditable and unchanged.
