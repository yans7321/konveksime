# Phase 1 — Database & Authentication Foundation

Dokumentasi teknis implementasi Phase 1. Aplikasi lama (static SPA + localStorage)
tetap utuh; fondasi ini menambahkan persistence sisi server secara aditif.

## Arsitektur

```
Browser (index.html + app-api.js)
  │  fetch /api/* (Bearer token)
  ▼
Netlify Functions (netlify/functions/*.mjs)
  │  parameterized queries (node-postgres)
  ▼
PostgreSQL Netlify (connection string dari environment variables)
```

- Kredensial database HANYA dibaca dari environment variables di sisi server
  (`netlify/functions/_db.mjs`). Tidak ada credential di frontend/localStorage/source.
- Semua SQL memakai parameterized queries (`$1, $2, ...`). Tidak ada string
  concatenation yang menerima input user.
- Tabel dipisah per user dengan kolom `user_id`; setiap query sync difilter
  `WHERE user_id = $1` dari sesi, sehingga user hanya bisa mengakses datanya sendiri.

## Endpoint

| Endpoint | Fungsi |
|---|---|
| `POST /api/auth` | `action`: `register`, `login`, `logout`, `me` |
| `GET /api/auth/google` | Mulai OAuth Google (302 ke Google + cookie state) |
| `GET /api/auth/google/callback` | Callback OAuth; tukar code → sesi |
| `GET /api/sync?kind=…` | List `pekerja` / `perusahaan` / `jenis_pekerjaan` milik sesi |
| `POST /api/sync` | Upsert idempoten `{ kind, items: [...] }` |
| `GET /api/health` | Status konfigurasi (tanpa membocorkan credential) |

Routing `/api/*` → functions didefinisikan di `netlify.toml` (redirects eksplisit).

## Tabel (migration 0001_foundation_tables)

- `app_users` — user/account: `username`, `email`, `name`, `password_hash`
  (scrypt, format `s2$salt$hash`), `provider` (`local`/`google`),
  `provider_user_id`, `is_active`, `permissions` (jsonb), `created_at`,
  `updated_at`.
- `app_sessions` — bearer token (disimpan sebagai SHA-256 hash), `user_id`,
  `provider`, `expires_at` (30 hari).
- `yans_pekerja` — `user_id`, `nama`, `legacy_id`, timestamps, `deleted_at`
  (soft delete); UNIQUE `(user_id, nama)` — mencegah duplikat saat sync ulang.
- `yans_perusahaan` — `user_id`, `nama`, `pic`, `telepon`, `catatan`, `legacy_id`;
  UNIQUE `(user_id, nama)`.
- `yans_jenis_pekerjaan` — master jenis pekerjaan untuk Phase 2; `kode`,
  `nama`, `kategori_biaya` (`produksi` | `lainnya`) — memisahkan biaya produksi
  dari pengeluaran lain (fondasi P&L). Data TIDAK diisi otomatis di Phase 1.
- `yans_workbook_state` — jsonb per `(user_id, kind)` untuk state bisnis
  (Pekerjaan, Ambil Jahit, Storan, Kiriman, dst.) pada phase berikutnya.

Rantai data Phase 2 yang disiapkan (tanpa implementasi):
`USER → PERUSAHAAN (pemberi kerja) → PEKERJAAN/JOB → AMBIL JAHIT → STORAN/QC → KIRIMAN`,
dengan transaksi upah merujuk master `yans_jenis_pekerjaan`.

## Migrations

- Dijalankan otomatis (idempoten) saat function API pertama kali dipakai.
- Bisa juga manual: `npm run db:migrate` (butuh `NETLIFY_DATABASE_URL` /
  `DATABASE_URL` di environment).
- Aman dijalankan berulang & dari banyak lambda bersamaan: tercatat di tabel
  `yans_migrations` + `pg_advisory_xact_lock` untuk serialisasi.

## Login yang sudah ada tetap jalan

- `app-api.js` membungkus `handleLogin`/`handleRegister`/`handleLogout` yang lama.
- Server tersedia → login/register via API (password di-hash scrypt di server).
- Server tidak tersedia (503 / offline) ATAU kredensial 401 (akun lama yang belum
  ada di database) → otomatis fallback ke handler localStorage asli.
- Setelah login server sukses, data pekerja & perusahaan disinkronkan ke DB
  (upsert by `user_id + nama`; tombstone localStorage mencegah baris terhapus
  dibuat ulang).

## Google Login

- Popup `/api/auth/google` → 302 ke Google dengan `state` HMAC-signed yang juga
  disimpan di cookie HttpOnly (proteksi CSRF); callback memverifikasi keduanya.
- Code ditukar server-side; client secret tidak pernah menyentuh browser.
- Identitas stabil: `provider='google'` + `provider_user_id` (Google `sub`),
  dan auto-link by email ke akun existing.
- Session yang sama dengan login email/password (bearer token), sehingga data
  ERP bisa dikaitkan ke account yang sama.

## Perintah

```bash
npm install          # install pg
npm test             # self-test (auth/sync/state) + HTTP integration
npm run db:migrate   # migration manual (butuh DATABASE_URL)
npm run serve        # dev server mirip Netlify (tanpa DB → mode fallback)
```
