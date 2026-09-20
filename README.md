# Konveksi YANS ERP Control Center

Aplikasi web operasional Konveksi YANS untuk mengelola pekerjaan, pengambilan jahit, setoran, pengiriman, penggajian, kasbon, laporan, aset, arsip pekerja, dan akses anggota. Antarmuka menggunakan pendekatan visual MIUI yang modern dan responsif, sementara isi serta alur kerja dari dokumen sumber tetap dipertahankan.

## Teknologi

- HTML5, CSS3, dan JavaScript (static SPA di `index.html`)
- Tailwind CSS melalui CDN
- Font Awesome untuk ikon
- html2pdf.js untuk ekspor dokumen
- Web Storage (localStorage) sebagai penyimpanan utama browser
- Netlify Functions (`netlify/functions/*.mjs`) + PostgreSQL sebagai fondasi
  persistence sisi server (Phase 1) — lihat `docs/PHASE1.md`
- Autentikasi: email/password (scrypt di server) + Google OAuth (opsional)

## Menjalankan secara lokal

```bash
npm install
npm run serve        # dev server mirip Netlify di http://localhost:3000
```

Tanpa `DATABASE_URL`, aplikasi berjalan dalam mode fallback localStorage penuh
(periaku lama tetap utuh). Set `NETLIFY_DATABASE_URL`/`DATABASE_URL` untuk
mengaktifkan persistence server.

## Test

```bash
npm test             # self-test auth/sync/CSRF + integrasi HTTP
```

## Deploy (Netlify)

- Build: statis (`netlify.toml`, `publish = "."`), functions di-bundle otomatis.
- Routing `/api/*` didefinisikan di `netlify.toml`.
- Set environment variables di Netlify: `NETLIFY_DATABASE_URL` (dari Netlify DB),
  serta `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` bila Google login diinginkan.
- Migration dijalankan otomatis saat API pertama kali dipakai, atau manual via
  `npm run db:migrate`.
