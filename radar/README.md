# Radar Seragam — PT Mitra Lintas

Sistem radar untuk menemukan peluang penjualan seragam lebih awal dari dua kanal:

1. **Radar Tender** ([scrapers/tender.py](scrapers/tender.py)) — sinyal pengadaan seragam
   (pemerintah, pemda, BUMN, swasta) dari Google News RSS, plus prosesor data historis
   OCDS Opentender untuk intelijen harga.
2. **Radar Event** ([scrapers/event.py](scrapers/event.py)) — event (fun run, family day,
   gathering, HUT instansi) yang berpotensi butuh jersey/kaos/seragam panitia.

Keduanya menulis JSON ke [data/](data/), dibaca oleh dashboard statis
[docs/index.html](docs/index.html) (vanilla JS, tanpa framework). Radar ini **komplementer**
terhadap pipeline pengadaan Fase 1 — radar menemukan peluang, deal yang diputuskan untuk
dikejar dicatat ke pipeline. Folder `pipeline/` (Fase 1) tidak disentuh sistem ini.

## Cara jalan lokal

Butuh Python 3.10+ (hanya pustaka standar — **tanpa** `pip install`).

```bash
# 1. Jalankan scraper (menulis radar/data/tenders.json dan events.json)
python radar/scrapers/tender.py
python radar/scrapers/event.py

# 2. Sajikan dashboard (fetch JSON butuh HTTP, bukan file://)
python -m http.server 8765 --directory radar
# buka http://localhost:8765/docs/index.html
```

Intelijen harga historis (opsional): unduh manual file export OCDS dari
[opentender.net](https://opentender.net) (export bersifat per-LPSE per-tahun; data publik
UU 14/2018, lisensi ODbL), lalu:

```bash
python radar/scrapers/tender.py --ocds path/ke/export-ocds.json
# menulis radar/data/harga_historis.json
```

Data LKPP hanya mencatat sampai tahap **penetapan pemenang**, bukan realisasi kontrak —
semua harga bersifat **indikatif**.

Validasi data dan arsip agregat bulanan (opsional, dipakai workflow setelah scrape):

```bash
node radar/scripts/guard_data.js
node radar/scripts/archive_summary.js
# menulis radar/archive/monthly/YYYY-MM.json dan radar/archive/last-known-good.json
```

Threshold guard bisa diubah lewat environment variable:
`RADAR_MIN_TENDER_ITEMS`, `RADAR_MIN_EVENT_ITEMS`, dan `RADAR_MAX_DROP_RATIO`.
Lokasi input/output arsip bisa diubah lewat `RADAR_DATA_DIR`, `RADAR_ARCHIVE_DIR`,
`RADAR_LKG_FILE`, dan `RADAR_ARCHIVE_PERIOD`.

## Review queue manual

Review queue membantu menemukan item tender/event yang perlu diperiksa manusia karena
kualitas datanya meragukan. Outputnya adalah
[docs/data/review_queue.json](docs/data/review_queue.json), dibaca dashboard pada panel
**Perlu Review Manual**.

Jalankan lokal setelah `tenders.json` dan `events.json` tersedia:

```bash
node radar/scripts/build_review_queue.js
```

Environment variable:

- `RADAR_DATA_DIR`: folder input, default `radar/data`.
- `RADAR_REVIEW_OUTPUT`: file output, default `radar/docs/data/review_queue.json`.
- `RADAR_REVIEW_MAX_ITEMS`: batas item queue yang ditulis, default `500`.
- `RADAR_OLD_ITEM_DAYS`: ambang item lama, default `1095` hari.

Issue code yang dipakai:

- `MISSING_TITLE`: judul kosong.
- `TITLE_TOO_SHORT`: judul terlalu pendek dan tidak informatif.
- `MISSING_SOURCE`: sumber kosong.
- `MISSING_LINK`: link sumber kosong.
- `MALFORMED_RSS_TITLE`: judul RSS tampak belum bersih dari suffix sumber/domain.
- `LONG_TITLE_WITHOUT_SPACES`: judul panjang tanpa spasi, biasanya artefak feed.
- `DUPLICATE_NORMALIZED_TITLE`: judul sama setelah normalisasi konservatif.
- `SUSPECTED_ORGANIZATION_EXTRACTION`: nama instansi/penyelenggara perlu diperiksa.
- `SUSPECTED_LOCATION_EXTRACTION`: lokasi terdeteksi perlu diperiksa.
- `OLD_ITEM`: tanggal berhasil diparse dan melewati ambang umur.
- `INVALID_DATE`: field tanggal berisi teks tetapi tidak bisa diparse.
- `INCOMPLETE_CORE_FIELDS`: field inti judul/sumber/link belum lengkap.

Item yang masuk queue **belum tentu salah**. Queue tidak menghapus data, tidak memperbaiki
data otomatis, tidak mengubah scoring, tidak menolak peluang, tidak mengirim pesan, dan
tidak membuat keputusan komersial. Keputusan tetap dilakukan manusia. Tanggal atau lokasi
kosong saja tidak dianggap error.

## Setup GitHub Actions + GitHub Pages

Workflow: [.github/workflows/radar.yml](../.github/workflows/radar.yml) — berada di **root
repo** (bukan `radar/.github/`) karena GitHub hanya mengeksekusi workflow di lokasi itu.

1. Push repo ini ke GitHub.
2. **Settings → Actions → General → Workflow permissions**: pilih *Read and write
   permissions* (workflow commit JSON hasil scraping).
3. **Settings → Pages → Source**: pilih **GitHub Actions**.
4. Workflow berjalan otomatis tiap hari pukul 05:00 WIB, atau manual via tab
   **Actions → radar → Run workflow**. Ia menjalankan kedua scraper, commit JSON terbaru,
   menyalin JSON ke `radar/docs/data/`, dan mendeploy `radar/docs/` ke GitHub Pages.

## Cara pakai dashboard

- Dua tab: **Tender** dan **Event**, dengan filter jenis klien/segmen, wilayah/kata kunci,
  dan rentang waktu terbit.
- Tombol **"Siapkan draft WhatsApp/Email"** per item membuka teks draft untuk **disalin dan
  dikirim manual** (link `wa.me` / `mailto:`). Tidak ada pengiriman otomatis.
- **Ekspor JSON/CSV** mengekspor item sesuai filter aktif.
- Panel **"Ringkasan Harian untuk Pimpinan"**: rangkuman deterministik (jumlah sinyal baru
  per jenis klien, event mendatang, item prioritas) siap-tempel ke WhatsApp/email. Angka
  dihitung apa adanya dari data — bila kosong ditulis "0 item", tidak pernah dikarang.
  Aturan prioritas dinyatakan terbuka: sinyal tender ≤ 48 jam dengan nama instansi
  terdeteksi, **tanpa** bobot ekstra untuk segmen mana pun.

## Batasan

1. **Benturan kepentingan (keputusan pemilik, bukan sistem).** Target Pemerintah/BUMN
   adalah area sensitif bagi pemilik karena perannya di legislatif. Dashboard menandai item
   segmen Pemerintah/BUMN dengan badge merah "area sensitif" dan menyediakan toggle
   **"Sembunyikan Pemerintah/BUMN"**. Sistem **tidak** memberi bobot/prioritas ekstra ke
   segmen itu; keputusan mengejar sepenuhnya manual.
2. **Outreach & data pribadi (UU PDP 27/2022).** Sistem hanya menyiapkan **draft** untuk
   dikirim manusia secara manual, dan hanya ke kontak resmi yang dipublikasikan
   penyelenggara untuk kerjasama. Tidak ada blast otomatis dan tidak ada scraping kontak
   personal. Item dari RSS tidak membawa kontak — field `kontak_resmi` kosong dan
   dilengkapi manual dari kanal resmi penyelenggara.
3. **Keterbatasan sumber.** Radar berbasis Google News RSS adalah **sinyal awal dari
   pemberitaan**, bukan cakupan tender resmi yang menyeluruh, dan tidak real-time atas
   semua LPSE. Jangan mengandalkannya sebagai satu-satunya kanal; anggap sebagai radar
   dini, bukan daftar lengkap.

### Sumber yang sengaja TIDAK dipakai

- **API resmi INAPROC/ISB** — butuh role *Data Integrator* yang tidak bisa diajukan pelaku
  pengadaan LPSE dan memerlukan surat resmi ke LKPP. Ada stub `fetch_inaproc_isb()` yang
  sengaja `NotImplementedError` sampai akses resmi diperoleh.
- **Scraping langsung ratusan instance SPSE** — rapuh, struktur HTML beda antar versi.
  Stub `scrape_spse_instances()` sengaja tidak diimplementasikan.
- **Kalender lari publik (schedules.run / kalenderlari / ruanglari)** — struktur HTML tidak
  stabil/terdokumentasi, jadi tidak dipakai di jadwal harian. Kerangka
  `fetch_kalender_lari()` disediakan di `event.py` dengan panduan bila mau diaktifkan
  setelah verifikasi manual.

## Future scope (di luar MVP — jangan bangun sekarang)

- **Peluang ekspor / tender luar negeri** — sumber dan regulasi berbeda total; ditunda ke
  fase lanjutan.

## Asumsi yang diambil

- Klasifikasi `jenis_klien_tebakan` / `segmen` adalah **heuristik kata kunci dari judul
  berita** — tebakan awal untuk triase, bukan fakta. Nama instansi/penyelenggara hanya
  ditampilkan bila benar-benar terdeteksi di teks sumber; bila tidak, ditulis
  "(tidak terdeteksi)" — tidak pernah difabrikasi.
- Untuk item RSS, `link`/`link_resmi` menunjuk ke **artikel berita** (via Google News),
  bukan situs resmi tender/event; situs resmi ditelusuri manual dari artikelnya.
- Struktur folder mengikuti spesifikasi, kecuali workflow yang harus di root
  `.github/workflows/` (batasan GitHub).
- Folder `pipeline/` Fase 1 belum ada di repo ini saat radar dibangun; bila Fase 1 tinggal
  di tempat lain, pindahkan ke `pipeline/` tanpa perubahan apa pun pada radar.
