# Phase 2 — Pekerjaan / Job Management Foundation

Lanjutan Phase 1. Aplikasi lama tetap utuh; modul Pekerjaan (tab1) kini punya
jalur persistence ke PostgreSQL tanpa mengubah alur kerja yang sudah ada.

## Arsitektur

```
Browser (index.html + app-jobs.js bridge)
  │  fetch /api/jobs, /api/job-accessories, /api/job-documents (Bearer token)
  ▼
Netlify Functions (jobs.mjs, job-items.mjs)
  │  parameterized queries, user_id dari sesi (bukan dari client)
  ▼
PostgreSQL Netlify (tabel migration 0002_jobs)
```

- localStorage TETAP source of truth untuk UI. Database adalah mirror per-user
  dengan ID stabil (`dbId` di sisi lokal). Ini sesuai aturan Phase 1/2: tidak ada
  migrasi massal, tidak ada penghapusan data lama.
- Offline / belum login / DB tidak terkonfigurasi → aplikasi berjalan persis
  seperti sebelumnya (localStorage saja), dengan catatan status kecil di form.
- `app-jobs.js` mem-bungkus (hook) fungsi global yang sudah ada:
  `saveOrderKantor`, `editOrderKantor`, `deleteItem`, `cancelEdit`. Handler
  asli selalu dijalankan dulu; mirror ke server hanya terjadi jika local save
  benar-benar terjadi. File bytes TIDAK PERNAH dikirim ke API.

## Endpoint (semuanya session-authenticated)

| Endpoint | Fungsi |
|---|---|
| `GET /api/jobs` | List pekerjaan milik sesi (soft-deleted disembunyikan) |
| `GET /api/jobs?id=1` | Satu pekerjaan; `?accessories=1&documents=1` menyertakan anak |
| `POST /api/jobs` | Buat pekerjaan (kode duplikat per-user → `409 duplicate_job_code`) |
| `PUT /api/jobs?id=1` | Update partial (total_nilai dihitung ulang konsisten) |
| `DELETE /api/jobs?id=1` | Soft delete |
| `GET/POST/PUT/DELETE /api/job-accessories` | Asesoris dinamis per job; upsert by `(user, job, nama)` — simpan ulang tidak menduplikasi |
| `GET/POST/DELETE /api/job-documents` | Metadata dokumen/nota; upsert by `(user, job, file_name)` |

Routing ditambahkan di `netlify.toml`. Semua query parameterized dan scoped
`user_id` dari Bearer session; job diakses hanya setelah ownership diverifikasi.

## Tabel (migration 0002_jobs, idempotent)

- `yans_pekerjaan` — `id` (bigserial PK), `user_id`, `job_code`, `perusahaan_id`
  → `yans_perusahaan(id)` (master yang sama, tidak ada tabel perusahaan kedua),
  `legacy_id` (ID localStorage), `nama_pekerjaan`, `tanggal_masuk`, `deadline`,
  `jumlah_order`, `harga_per_pcs`, `total_nilai`, `catatan`, `status`
  (`aktif|selesai|arsip`), `variants` (jsonb — rincian warna/ukuran), timestamps,
  `deleted_at`. UNIQUE `(user_id, job_code)` dan `(user_id, legacy_id)` —
  nomor pekerjaan unik per user, bukan global; simpan ulang tidak duplikat.
- `yans_job_accessories` — `id`, `user_id`, `job_id`, `nama_asesoris`, `satuan`,
  `jumlah`, `catatan`, timestamps, `deleted_at`. UNIQUE `(user_id, job_id,
  nama_asesoris)` — dinamis, tidak hard-code jenis (Kancing/Sleting/Karet/dll).
- `yans_job_documents` — `id`, `user_id`, `job_id`, `file_name`, `mime_type`,
  `size_bytes`, `storage_ref`, `uploaded_at`, `deleted_at`. Metadata saja —
  TIDAK ada binary/base64 di database.

## Foto Nota — dependency yang disengaja

Phase 2 sengaja TIDAK mengikat storage provider. Form nota menyimpan nama
file/mime/size secara lokal, dan setelah job tersimpan ke server metadatanya
didaftarkan ke `/api/job-documents` (`storage_ref` masih `null`). Ketika storage
provider (mis. Netlify Blob/S3-compatible) dikonfigurasi nanti, hanya perlu:
upload binary ke provider → isi `storage_ref`. Tidak ada perubahan skema.

## Bridge frontend (app-jobs.js)

- Setelah sign-in: pull `/api/jobs` → baris server dicermin ke `db.tab1`
  (mapping `yans_dbmap_pekerjaan`: serverId → localId). Baris lokal yang sudah
  punya `dbId` di-refresh, bukan diduplikasi.
- Simpan/ubah: handler lokal asli berjalan dulu; jika row terbentuk, mirror ke
  server (POST/PUT), simpan `dbId` + mapping, lalu sinkron asesoris & nota.
  Edit mempertahankan `dbId` (handler asli membangun ulang object row).
- Perusahaan dikirim sebagai server ID dari mapping Phase 1; jika belum ada,
  server me-resolve by name dari master `yans_perusahaan` hasil sync sign-in.
- Hapus: konfirmasi asli tetap berjalan; server soft delete hanya jika baris
  lokal benar-benar terhapus.

## Perintah

```bash
npm test             # Phase 1 + Phase 2 (CRUD, isolation, validasi, routing HTTP)
npm run db:migrate   # migration manual 0001 + 0002 (butuh DATABASE_URL)
npm run serve        # dev server mirip Netlify (tanpa DB → mode fallback)
```
