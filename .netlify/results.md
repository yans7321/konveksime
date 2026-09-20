# Hasil Pengerjaan — Phase 1: Database & Authentication Foundation

## Ringkasan

Fondasi backend/database ditambahkan secara aditif tanpa mengubah perilaku
aplikasi yang sudah berjalan. Semua data tetap di localStorage (source of truth
Phase 1); pekerja & perusahaan kini juga dimirror ke PostgreSQL Netlify per user
setelah sign-in. Login/register/logout lama tetap berfungsi penuh, dengan
fallback otomatis ke localStorage bila server/database tidak tersedia.

## Files changed

Baru:
- `netlify.toml` — routing `/api/*` → functions, esbuild bundler, header no-store.
- `netlify/functions/_db.mjs` — pool pg, scrypt password, sesi bearer (hash SHA-256),
  migrations idempoten + advisory lock, test seam.
- `netlify/functions/_http.mjs` — helper JSON/error, sanitasi permission,
  `safeDbError` (tidak membocorkan detail DB).
- `netlify/functions/auth.mjs` — register/login/logout/me.
- `netlify/functions/sync.mjs` — upsert idempoten pekerja/perusahaan
  (+ `jenis_pekerjaan` disiapkan untuk Phase 2).
- `netlify/functions/google-start.mjs`, `google-callback.mjs`, `_google.mjs` —
  OAuth Google (state HMAC + cookie HttpOnly, tukar code server-side,
  identitas stabil provider_user_id, auto-link email).
- `netlify/functions/health.mjs` — status konfigurasi.
- `netlify/functions/_migrate.mjs` — migration runner manual.
- `app-api.js` — bridge frontend: hook auth + fallback, Google popup, sync,
  tombstone delete.
- `tests/phase1.mjs`, `tests/http.test.mjs`, `tests/dev-server.mjs` — test.
- `docs/PHASE1.md` — dokumentasi teknis.
- `package.json`, `package-lock.json`, `.gitignore`.

Diubah (minimal):
- `index.html` — 1 baris `<script src="app-api.js" defer>` + tombol
  "Continue with Google" di form login. Tidak ada menu/fitur yang diubah/dihapus.
- `README.md`, `AGENTS.md`, `.netlify/results.md` — dokumentasi.

## Database

Tabel (migration `0001_foundation_tables`, idempoten, primary key + timestamps):
`app_users`, `app_sessions`, `yans_pekerja`, `yans_perusahaan`,
`yans_jenis_pekerjaan` (master Phase 2, kosong), `yans_workbook_state` (jsonb
per user+kind untuk phase berikutnya). Password disimpan sebagai scrypt hash;
token sesi disimpan sebagai hash SHA-256.

## Security

- 100% parameterized queries; tidak ada SQL dari input user.
- Kredensial DB & Google hanya via environment variables server-side.
- Error DB digeneralisasi (`safeDbError`); health endpoint hanya melaporkan
  status konfigurasi.
- OAuth state di-sign HMAC dan diverifikasi terhadap cookie HttpOnly (CSRF).
- Semua query data difilter `user_id` dari sesi (isolasi antar user).
- Input divalidasi + dibatasi panjangnya di server.

## Existing functionality

Login, register, logout, member management, pekerja, perusahaan, seluruh tab
operasional, dan localStorage tidak diubah. `npm test` (3 suite) + pengecekan
sintaks seluruh JS (inline & file) lulus; preview berjalan dan endpoint
merespons benar (mode tanpa DB → fallback).

## Konfigurasi manual yang diperlukan (Netlify)

1. `NETLIFY_DATABASE_URL` — otomatis tersedia bila Netlify DB terhubung ke site;
   bila belum: Site configuration → Environment variables, tambahkan connection
   string PostgreSQL yang sudah ada.
2. Google login (opsional): buat OAuth client di Google Cloud Console
   (Web application), redirect URI `https://<domain>/api/auth/google/callback`,
   lalu set `GOOGLE_CLIENT_ID` dan `GOOGLE_CLIENT_SECRET` di environment
   variables Netlify. Tanpa ini, tombol Google menampilkan pesan konfigurasi
   (bukan error), dan login email/password tetap normal.

## Status

Selesai dan terverifikasi sejauh kemampuan lingkungan ini (test in-memory +
HTTP integration + preview live). Koneksi ke PostgreSQL produksi dan OAuth
Google memerlukan environment variables di atas untuk diaktifkan.
