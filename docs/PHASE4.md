# Phase 4 — Storan (Setoran Hasil Jahit)

Fondasi transaksi **Storan**: penerimaan hasil jahitan dari pekerjaan yang sudah
diambil melalui **Ambil Jahit** (Phase 3). Mengikuti pola arsitektur Phase 1–3
tanpa mengubah perilaku lama.

## Konsep

```
PEKERJAAN (Phase 2)
   ↓
AMBIL JAHIT (Phase 3, yans_tailoring_pickups)
   ↓
STORAN (Phase 4, yans_storages)
   ↓
HASIL JAHIT TERCATAT (belum_distor berkurang)
```

Aturan klop (dihitung **di server**, tidak pernah dari frontend):

```
jumlah_diambil  = SUM(yans_tailoring_pickups.quantity)
jumlah_stor     = SUM(yans_storages.quantity)
belum_distor    = jumlah_diambil - jumlah_stor
```

Storan hanya valid untuk pekerjaan yang sudah pernah diambil. Jika
`jumlah_diambil = 0`, job tidak muncul sebagai storable dan POST ditolak `404`.

## Contoh flow (dipakai sebagai test)

```
Total pekerjaan : 100
Ambil Jahit     : 40   →  diambil 40, belum stor 40
Stor            : 15   →  diambil 40, stor 15,  belum 25
Stor            : 25   →  diambil 40, stor 40,  belum 0
Stor            : 1    →  409 insufficient_storable_quantity
```

## Migration

`0004_storages` (idempotent, ditambahkan ke `MIGRATIONS` di `netlify/functions/_db.mjs`):

- `yans_storages`: `id` (bigserial PK), `user_id` (FK app_users), `job_id`
  (FK yans_pekerjaan), `quantity integer CHECK (quantity > 0)`, `stored_at date`,
  `legacy_id` (UNIQUE per user, untuk mirror frontend), `created_at`, `updated_at`,
  `deleted_at` (soft delete).
- Index: `yans_storage_user_job_idx (user_id, job_id, deleted_at)`.

Migration lama tidak diubah; `runMigrations()` dijalankan otomatis oleh API dan
aman dijalankan berulang (advisory lock `yans_migrations`).

## API — `/api/storages`

Sesi wajib (Bearer token); `user_id` selalu dari session, tidak pernah dari body.

| Endpoint | Fungsi |
|---|---|
| `GET ?storable=1` | Daftar pekerjaan yang sudah diambil dan masih punya sisa (`notStoredQuantity > 0`), lengkap dengan `totalQuantity / takenQuantity / storedQuantity / notStoredQuantity` live dari DB |
| `GET ?storable=1&jobId=N` | Snapshot satu job (404 jika bukan milik user atau belum pernah diambil) |
| `GET [?jobId=N]` | Riwayat transaksi storan (terbaru dulu, maks 500) |
| `POST {jobId, quantity, storedAt?}` | Transaksi stor; mendukung `legacyId` untuk edit-in-place dari mirror frontend |

Validasi backend POST (di dalam `withTransaction` + advisory lock per-job
`{user}:storage:{jobId}`, sama seperti Phase 3):

1. `jobId` valid dan milik user (selain itu → `404`, tidak membocorkan keberadaan resource).
2. Job punya pickup (`taken > 0`) → selain itu `404 not_found` ("Ambil Jahit dulu").
3. `quantity` integer positif (`0`, negatif, desimal, string tak valid, NaN → `400 invalid_quantity`).
4. `quantity <= belum_distor + (existing ? old_qty : 0)` → selain itu
   `409 insufficient_storable_quantity` dengan pesan
   "Jumlah stor melebihi jumlah pekerjaan yang belum distor."
5. Insert/update atomic; response memuat snapshot terbaru (`storage`, `job`).

Dua request bersamaan tidak mungkin over-store: salah satu dijamin `409`
(diuji di `tests/phase4.mjs`).

## Frontend bridge — `app-storages.js`

Pola sama dengan `app-pickups.js` (Phase 3):

- `db.tab3` (localStorage) tetap source of truth UI; perilaku lama tidak berubah.
- Hook `saveStoranJahit` memirror transaksi ke `/api/storages` saat ada sesi:
  job server di-resolve via `yans_dbmap_pekerjaan` / `dbJobId` / job code pada
  daftar storable; `dbStorageId` (legacy id) disimpan agar edit tidak duplikat.
- Panel **Pekerjaan Belum Distor** (`table-t3-storable`) menampilkan angka live
  server; fallback angka lokal bila offline (dengan catatan status).
- Panel **Riwayat Transaksi Storan** (`table-t3-history`) append-only dari server.
- Hint `t3-max-hint` menampilkan batas maksimal stor dari angka server.
- `deleteItem('tab3')` / `switchTab('tab3')` me-refresh panel.

Markup di `index.html` bersifat aditif (ID baru, tanpa mengubah UI lama).

## Isolasi user

Semua query difilter `user_id` dari session. Job milik user lain → `404`,
riwayat tidak pernah tercampur (diuji).

## Test

`tests/phase4.mjs` (driver in-memory, tanpa PostgreSQL/credential):

1. Flow klop lengkap (40 → 15 → 25 → tolak 1), validasi quantity, pickup-first,
   storable list, ownership isolation, riwayat, edit legacy id.
2. Concurrent double submission: persis satu `201`, satu `409`, riwayat 1 baris.
3. Routing HTTP `/api/storages` + auth 401.

Jalankan semua fase: `npm test` (10/10 pass).
