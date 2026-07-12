# Inges — Input Gesek

PWA untuk input otomatis rekap cek fisik dari listing penjualan ke Google Sheets "Rekap Cek Fisik".

## Cara kerja singkat

- **Import Otomatis** — upload CSV listing export data penjualan. Inges mengelompokkan transaksi per tanggal, membentuk range nomor faktur, dan menghitung debit = jumlah faktur × 2 pcs. Setiap tanggal ditulis sebagai 1 baris baru di sheet bulan berjalan.
- **Input Manual** — form untuk mencatat penambahan stok cek fisik (Credit) dari SP-DRI, SP-CF, atau sumber lain, langsung ke sheet yang sama.
- Kolom **Saldo** selalu ditulis sebagai formula (`=F{prev}+D{row}-E{row}`), mengikuti pola yang sudah dipakai di spreadsheet — bukan angka hardcode, jadi tetap konsisten kalau ada koreksi manual di kemudian hari.
- App otomatis mendeteksi sheet/tab bulan aktif (misal "JULI 2026") berdasarkan tanggal hari ini.

---

## Setup wajib sebelum dipakai (sekali saja)

### 1. Buat OAuth Client ID di Google Cloud Console

1. Buka [console.cloud.google.com](https://console.cloud.google.com), buat project baru (atau pakai yang sudah ada).
2. Aktifkan **Google Sheets API**: menu *APIs & Services → Library* → cari "Google Sheets API" → **Enable**.
3. Buka *APIs & Services → OAuth consent screen*:
   - User type: **External** (kalau akun bukan Google Workspace) atau **Internal** (kalau pakai Workspace CDN).
   - Isi nama app "Inges", email support, dsb.
   - Scopes: tambahkan `.../auth/spreadsheets` dan `.../auth/userinfo.email`.
   - Tambahkan email-email karyawan yang boleh pakai sebagai **Test user** (kalau masih mode Testing).
4. Buka *APIs & Services → Credentials → Create Credentials → OAuth client ID*:
   - Application type: **Web application**.
   - Authorized JavaScript origins: tambahkan `https://ragashputra.github.io`
   - (Kalau testing lokal, tambahkan juga `http://localhost:5500` atau port lokal yang dipakai.)
   - Klik **Create**, salin **Client ID** yang muncul (format: `xxxxx.apps.googleusercontent.com`).

### 2. Masukkan Client ID ke app

Buka `app.js`, baris paling atas:

```js
const GOOGLE_CLIENT_ID = 'PASTE_OAUTH_CLIENT_ID_DISINI.apps.googleusercontent.com';
```

Ganti dengan Client ID dari langkah 1.

### 3. Bagikan akses spreadsheet

Pastikan akun Google yang dipakai login (dan akun karyawan lain yang akan pakai) sudah punya akses **Editor** ke spreadsheet "Rekap Cek Fisik 2025 - PGR" di Google Drive (Share seperti biasa).

### 4. Deploy ke GitHub Pages

```bash
# di dalam folder inges/
git init
git add .
git commit -m "Inges — Input Gesek"
git branch -M main
git remote add origin https://github.com/ragashputra/inges.git
git push -u origin main
```

Lalu di repo GitHub: *Settings → Pages → Source: Deploy from branch → main / (root)*.
App akan tersedia di `https://ragashputra.github.io/inges/`.

### 5. Login pertama kali

Buka app → tombol **Masuk dengan Google** → pilih akun → izinkan akses Sheets.
Setelah login, app akan minta **Spreadsheet ID** (sekali saja, tersimpan di perangkat) — tempel dari URL spreadsheet:

```
https://docs.google.com/spreadsheets/d/  1ScmxyYlMuJroAmsIidTuCH9sm1U0N1ZRCO5kHOGZRhE  /edit
                                          └──────────────── ini yang ditempel ────────────────┘
```

---

## Catatan teknis

- **Nama sheet aktif**: app mencari tab dengan nama `<BULAN PANJANG> <TAHUN>` (contoh "JULI 2026") sesuai 2 tab terbaru di file rekap. Kalau penamaan bulan depan beda formatnya (spreadsheet lama pakai "JUN 25" dua digit, yang baru "JULI 2026" empat digit), pastikan tab bulan berjalan sudah dibuat manual dengan format serupa **sebelum** dipakai — app tidak membuat tab baru otomatis.
- **Format nomor faktur range**: `0001-0005/PGR/VI/2026` → ditulis sebagai `1-5/PGR/VI/2026` (nomor depan-belakang tanpa leading zero, mengikuti gaya input manual di data historis).
- **1 faktur = 2 pcs cek fisik** — logika ini hardcoded sesuai spesifikasi (sepasang cek fisik per unit terjual). Kalau kebijakan berubah, cari `day.debit = sorted.length * 2` di `app.js`.
- **Service worker** hanya meng-cache app shell (HTML/JS/manifest) untuk load instan — panggilan ke Google API tidak pernah di-cache, selalu real-time.
- **Data sensitif**: token akses OAuth disimpan di `localStorage` perangkat (expire otomatis ~1 jam, refresh transparan saat dipakai lagi). Tidak ada server backend — semua komunikasi langsung dari browser ke Google API.

## Struktur file

```
inges/
├── index.html      # UI & markup
├── app.js          # logic: OAuth, parsing CSV, Sheets API
├── manifest.json   # PWA manifest
├── sw.js           # service worker (app-shell caching)
└── icons/          # icon PWA (192/512, termasuk maskable)
```
