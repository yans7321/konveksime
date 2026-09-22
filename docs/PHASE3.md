# Phase 3 — Ambil Jahit / Tailoring Pickup Foundation

Lanjutan Phase 2. Modul Ambil Jahit (tab2) kini menjadi **transaction layer**
antara Pekerjaan dan produksi: setiap pengambilan tercatat, terkontrol, dan
jumlahnya selalu klop terhadap sisa pekerjaan.

## Tujuan

```
Pekerjaan (Phase 2, yans_pekerjaan)
  →  Ambil Jahit (transaksi, yans_tailoring_pickups)
      →  jumlah tersedia menurun secara live
          →  riwayat pengambilan permanen
```

Aturan inti: **jumlah harus klop**. Total 100, sudah diambil 40 → tersedia 60.
Tidak ada jalur yang bisa mengambil 61 — validasinya ada di backend, bukan hanya
di frontend.

## Data model (migration 0003_tailoring_pickups)

`yans_tailoring_pickups` — id (bigserial PK), `user_id`, `job_id →
yans_pekerjaan(id)` (ON DELETE CASCADE), `quantity` (integer, CHECK > 0),
`picked_up_at` (date), `tukang`, `jenis`, `catatan`, `legacy_id` (UNIQUE
per-user; pengait baris mirror localStorage), timestamps, `deleted_at`
(soft delete). Index `(user_id, job_id, deleted_at)`.

Keputusan penting: **available quantity tidak pernah disimpan**. Selalu
dihitung ulang dari database:

```
available = yans_pekerjaan.jumlah_order − SUM(pickups.quantity)   (live)
```

Dengan begitu angka tidak mungkin drift/sinkron dari log transaksi, dan
manipulasi frontend tidak berpengaruh — nilai yang dikirim client hanya
`jobId` dan `quantity`; sisanya dihitung server.

## Workflow & API

| Endpoint | Fungsi |
|---|---|
| `GET /api/tailoring-pickups?available=1` | Snapshot semua pekerjaan milik sesi dengan `taken` live; **hanya yang available > 0** yang dikembalikan |
| `GET /api/tailoring-pickups?jobId=1&available=1` | Snapshot satu pekerjaan |
| `GET /api/tailoring-pickups` | Riwayat transaksi (terbaru dulu, maks 500), lengkap job code + perusahaan |
| `GET /api/tailoring-pickups?jobId=1` | Riwayat satu pekerjaan |
| `POST /api/tailoring-pickups` | Transaksi pengambilan `{jobId, quantity, pickedUpAt?, tukang?, jenis?, legacyId?}` |

Routing `/api/tailoring-pickups` → `pickups` function di `netlify.toml`.

### Jalur POST (wajib berurutan)

1. Autentikasi sesi (Bearer) → `user_id` dari sesi, bukan dari client.
2. Validasi `quantity`: **integer positif** — `0`, negatif, desimal (`10.5`),
   string non-numerik, kosong, dan melebihi 10⁹ semuanya ditolak (`400
   invalid_quantity`).
3. `withTransaction`: BEGIN → **`pg_advisory_xact_lock(user:pickup:jobId)`** →
   hitung availability live → validasi ceiling → INSERT/UPDATE → hitung ulang →
   COMMIT. Lock per-job membuat dua request bersamaan (atau double-submit)
   terserialisasi; yang kedua melihat angka yang sudah diperbarui.
4. Job tidak ada / bukan milik user → `404 not_found` (tanpa membocorkan
   detail).
5. `quantity > available` → `409 insufficient_quantity` dengan pesan
   *"Jumlah pengambilan melebihi jumlah pekerjaan yang masih tersedia."* plus
   `total/taken/available`. **Database tidak berubah** (INSERT tidak dijalankan).

### Edit via legacyId

Bridge frontend mengirim `legacyId` saat mengedit baris mirror lama. Server
memperlakukannya sebagai UPDATE baris yang sama: kuantitas lama **kembali ke
pool** sebelum ceiling dihitung (tersedia 60 + ambil lama 30 → edit ke 50
sah; edit ke 91 ditolak). `duplicate_legacy` (409) menjaga integritas bila
legacy id menunjuk transaksi job lain. Ruang legacy id adalah per-user.

## Ownership isolation

Pola Phase 1/2 dipertahankan: setiap query difilter `user_id` dari sesi.
Test membuktikan: A tidak bisa POST ke job milik B (404 meski job ID
diketahui), tidak bisa membaca availability job B (404), riwayat A dan B
saling terpisah, dan tidak ada filtering berbasis frontend.

## Frontend (app-pickups.js, aditif)

- Panel **Pekerjaan Tersedia** di atas tab2: kolom Pekerjaan / Perusahaan /
  Total / Sudah Diambil / Tersedia / aksi **Ambil Jahit**. Angka dari server.
- **Riwayat Transaksi Pengambilan** di bawah tabel lama: Tanggal, Pekerjaan,
  Perusahaan, Tukang, Jumlah, ID transaksi. Panel muat-ulang manual.
- **Max hint** pada form: `Tersedia: 60 pcs — maksimal pengambilan 60 pcs.`,
  diperbarui saat memilih job / mengetik kode. Feedback frontend adalah
  kenyamanan; backend tetap validator final.
- Setelah transaksi sukses: availability + riwayat langsung dimuat ulang, dan
  status menampilkan total/diambil/tersedia terbaru. Job dengan available 0
  otomatis hilang dari daftar tersedia (riwayat tetap ada).
- Fallback lokal penuh saat offline/belum login — perilaku lama tidak berubah.

## Testing (tests/phase3.mjs + regresi)

Happy path (100→30→70), multiple pickups (30+20=50), exact quantity (50→0,
job keluar dari daftar tersedia), over quantity (51 dari 50 → 409, DB utuh),
zero/negative/decimal/non-numeric/overflow → 400, job tidak ada → 404,
ownership isolation dua user, riwayat tercatat lengkap, edit legacyId
(termasuk ceiling & duplicate_legacy), unauthenticated → 401, HTTP routing.
Regresi: `npm test` = Phase 1 + 2 + 3 + HTTP integration, **7/7 PASS**.

## Known limitations

- Upload foto nota masih menunggu storage provider (warisan Phase 2).
- Pengambilan masih agregat per transaksi; rincian per warna/ukuran tersimpan
  di mirror lokal (`variants`) dan baru menjadi struktur server di phase
  produksi lanjutan.
- History endpoint dibatasi 500 baris terbaru (cukup untuk Phase 3; paging
  menyusul bila dibutuhkan).
- Tidak ada pembatalan pengambilan via API di Phase 3 (soft delete tabel sudah
  siap; UI pembatalan bukan scope Phase 3).
