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

## Fase H: qualification readiness

Fase H menambahkan definisi Qualified Opportunity dan penilaian kesiapan berbasis aturan.
Outputnya adalah [docs/data/qualification_readiness.json](docs/data/qualification_readiness.json),
dibaca dashboard pada panel **Kesiapan Kualifikasi Peluang**. Fase ini tidak otomatis
menjadikan item sebagai Qualified Opportunity.

Istilah yang dipakai:

- **Raw Signal**: item tender/event yang baru ditemukan dan belum dinilai.
- **Qualification Readiness**: rekomendasi deterministik apakah item siap diperiksa manusia.
- **Qualified Opportunity**: item yang memenuhi syarat dan sudah disetujui manusia; status ini
  belum diterapkan pada Fase H.

Definisi lengkap ada di [QUALIFIED_OPPORTUNITY.md](QUALIFIED_OPPORTUNITY.md). Prinsipnya:
source harus traceable, judul informatif, organisasi jelas, need/trigger terlihat di data,
product fit masuk akal, timing belum jelas terlewat, next action netral tersedia, dan human
approval tetap wajib.

State readiness:

- `READY_FOR_HUMAN_QUALIFICATION`: siap ditinjau manusia untuk kualifikasi.
- `NEEDS_MORE_INFORMATION`: masih ada bukti sumber, organisasi, kebutuhan, atau waktu yang
  belum cukup.
- `NEEDS_DATA_REVIEW`: review queue menunjukkan issue high/medium atau kualitas data gagal.
- `EXPIRED_OR_HISTORICAL`: tanggal valid sudah melewati ambang historical.
- `LOW_PRODUCT_RELEVANCE`: tidak ada hubungan produk yang cukup masuk akal berdasarkan aturan
  saat ini.

State `QUALIFIED`, `WON`, `LOST`, dan `REJECTED` sengaja tidak dipakai karena itu keputusan
manusia atau fase berikutnya.

Checks yang dievaluasi per item:

- `SOURCE_TRACEABLE`
- `TITLE_INFORMATIVE`
- `ORGANIZATION_IDENTIFIABLE`
- `NEED_EVIDENCE_PRESENT`
- `PRODUCT_FIT_PLAUSIBLE`
- `TIMING_ACTIONABLE`
- `DATA_QUALITY_ACCEPTABLE`
- `NEXT_ACTION_POSSIBLE`

Reason code utama:

- `SOURCE_MISSING`, `SOURCE_INVALID`, `TITLE_UNINFORMATIVE`
- `ORGANIZATION_UNCLEAR`, `NEED_EVIDENCE_WEAK`, `PRODUCT_NEED_UNCONFIRMED`,
  `PRODUCT_FIT_WEAK`
- `DATE_EXPIRED`, `DATE_UNKNOWN`, `QUALITY_REVIEW_REQUIRED`
- `NEXT_ACTION_UNCLEAR`, `READY_FOR_HUMAN_REVIEW`, `HISTORICAL_REFERENCE`

Jalankan lokal setelah `tenders.json`, `events.json`, dan `review_queue.json` tersedia:

```bash
node radar/scripts/build_review_queue.js
node radar/scripts/build_qualification_readiness.js
```

Environment variable qualification readiness:

- `RADAR_DATA_DIR`: folder input `tenders.json` dan `events.json`, default `radar/data`.
- `RADAR_REVIEW_QUEUE_FILE`: input review queue, default `radar/docs/data/review_queue.json`.
- `RADAR_QUALIFICATION_RULES_FILE`: config aturan, default `radar/config/qualification_rules.json`.
- `RADAR_QUALIFICATION_OUTPUT`: file output, default `radar/docs/data/qualification_readiness.json`.
- `RADAR_QUALIFICATION_MAX_ITEMS`: batas item output bila diperlukan; default `0` berarti semua.
- `RADAR_QUALIFICATION_EXPIRED_DAYS`: override ambang historical; default dari config.

Tidak ada numeric opportunity scoring pada Fase H. Sistem tidak memberi nilai tambahan karena
pembeli Pemerintah/BUMN, tidak mengambil kontak pribadi, tidak mengirim outreach, tidak membuat
harga, dan tidak memperkirakan nilai proyek tanpa bukti. Suggested next action yang muncul hanya
tindakan netral seperti verifikasi sumber, organisasi, timing, kebutuhan produk, review kualitas
data, buka sumber, tambah watchlist, atau siapkan untuk review manusia.

Product fit dibagi menjadi tiga kondisi:

- Explicit product fit: istilah apparel/tekstil eksplisit seperti seragam, pakaian dinas,
  baju dinas, wearpack, kaos, polo, jaket, rompi, batik, jersey, atau tekstil ditemukan;
  `product_fit_plausible = pass`.
- Indirect product need unconfirmed: event/trigger seperti fun run, jalan sehat, family
  gathering, HUT, festival, konferensi, seminar, wisuda, ekspansi, rebranding, pembukaan
  cabang, peluncuran armada, atau safety campaign ditemukan tetapi produk belum disebut;
  `product_fit_plausible = unknown`, reason `PRODUCT_NEED_UNCONFIRMED`, dan next action
  `VERIFY_PRODUCT_NEED`.
- Weak product fit: tidak ada explicit product fit dan tidak ada indirect trigger yang cukup;
  `product_fit_plausible = fail`, reason `PRODUCT_FIT_WEAK`.

Organization fallback berdasarkan audit schema aktual:

- Tender: `instansi_terdeteksi`.
- Event: `penyelenggara`.

Field seperti `organization`, `organizer`, `instansi`, `nama_instansi`, `buyer`, `agency`,
`institution`, dan `entity` tidak ditemukan dalam dataset saat ini, sehingga tidak dipakai
sebagai fallback aktif. Source/media publisher tidak dipakai sebagai organisasi.

## Fase I: Human Feedback Loop V1

Human Feedback Loop memungkinkan reviewer memberi keputusan manual pada item qualification
readiness tanpa mengubah rekomendasi sistem. Dokumentasi lengkap tersedia di
[HUMAN_FEEDBACK.md](HUMAN_FEEDBACK.md), sedangkan aturan machine-readable berada di
[config/human_feedback_rules.json](config/human_feedback_rules.json).

Cara menggunakan fitur review:

1. Buka panel **Keputusan Reviewer** dan pilih **Review** pada item, atau gunakan
   **Review Berikutnya** untuk membuka item `UNREVIEWED` menurut prioritas readiness.
2. Pilih human decision, minimal satu reason, alias singkat, dan field wajib sesuai state.
3. Pilih **Simpan Keputusan**. Machine readiness tetap read-only dan history lama tetap ada.

Human decision yang tersedia adalah `QUALIFIED`, `NEEDS_RESEARCH`, `WATCHLIST`, dan
`NOT_RELEVANT`. `UNREVIEWED` adalah default virtual dan tidak disimpan. `QUALIFIED` hanya
dapat dibuat oleh manusia; tidak ada automatic qualification atau numeric scoring.

Feedback disimpan sementara pada localStorage browser:

- Storage root: `mitralintas_radar_feedback_v1`.
- Alias reviewer: `mitralintas_radar_reviewer_v1`.

Data tidak tersinkron ke browser, perangkat, atau user lain. Gunakan **Export Feedback**
untuk backup `mitralintas-feedback-YYYY-MM-DD.json`. Gunakan **Import Feedback** untuk
memvalidasi dan melihat preview record valid, invalid, baru, konflik, dan orphaned sebelum
konfirmasi merge. Import menggabungkan history berdasarkan event ID dan mempertahankan
record orphaned untuk export berikutnya.

Untuk membersihkan feedback lokal secara aman, export backup terlebih dahulu, lalu gunakan
DevTools browser pada halaman dashboard: **Application/Storage -> Local Storage**, hapus hanya
key `mitralintas_radar_feedback_v1` dan, bila perlu, `mitralintas_radar_reviewer_v1`, kemudian
reload halaman. Dashboard sengaja tidak menyediakan tombol delete-all pada pilot ini.

Jika localStorage diblokir atau tidak tersedia, dashboard beralih ke in-memory fallback dan
feedback hanya bertahan selama sesi. Jangan menyimpan email, nomor telepon, NIK, credential,
atau data sensitif lain pada note. Pilot ini tidak memiliki backend, database cloud,
authentication, sinkronisasi, outreach otomatis, atau workflow sales.

Jalankan test lokal:

```bash
node --check radar/docs/js/human_feedback.js
node --check radar/scripts/test_human_feedback.js
node radar/scripts/test_human_feedback.js
```

## Fase J: Trigger Radar V1

Trigger Radar mendeteksi peristiwa yang dapat mendahului kebutuhan tekstil atau apparel pada
data tender/event yang sudah tersedia. Trigger adalah indikasi awal berbasis aturan, bukan bukti
kebutuhan atau pembelian. Dokumentasi lengkap tersedia di
[TRIGGER_RADAR.md](TRIGGER_RADAR.md), sedangkan taxonomy machine-readable berada di
[config/trigger_taxonomy.json](config/trigger_taxonomy.json).

Trigger dibagi menjadi kelas `direct`, `indirect`, dan `historical`, dengan evidence strength
non-numerik `STRONG`, `MODERATE`, dan `WEAK`. Satu item dapat memiliki beberapa trigger.
Primary trigger dipilih deterministic dengan aturan kontekstual. Pengadaan aktif dapat menjadi
direct primary meskipun terdapat historical secondary; artikel yang terutama membahas audit,
korupsi, penyidikan, atau penyimpangan tetap historical primary. Tie-breaker berikutnya memakai
class precedence, evidence strength, urutan taxonomy, dan trigger code. Aturan ini bukan ranking
komersial atau opportunity score.

Setiap signal memiliki timing status `FUTURE_OR_OPEN`, `CURRENT_OR_UNCLEAR`,
`COMPLETED_OR_PAST`, `HISTORICAL_REFERENCE`, atau `INFORMATIONAL_OR_EDITORIAL`. Timing memakai
field event date eksplisit dan phrase judul; published date tidak dianggap event date dan
reference date berasal dari `generated_at` input. Artikel editorial/listicle disuppress untuk
trigger event, sedangkan keyword generik investasi dan tenaga kerja tidak cukup untuk expansion
atau recruitment.

Invitation phrase (`ayo`, `mari`, `yuk`) dan planning phrase spesifik diperiksa sebelum completed
context. Verba seperti `ramaikan` atau `ikuti` tanpa invitation, completed phrase, actor/action,
atau passive quantity context tetap `CURRENT_OR_UNCLEAR`. Published date hanya dipakai sebagai
freshness guard 60 hari untuk phrase-based future signal. Signal stale diturunkan ke verifikasi
waktu, kecuali judul memuat tanggal future yang dapat dibuktikan terhadap reference date
deterministic.

Jalankan setelah data sumber tersedia:

```bash
node radar/scripts/build_trigger_signals.js
node radar/scripts/test_trigger_signals.js
```

Output ditulis atomik ke `docs/data/trigger_signals.json`. `generated_at` berasal dari timestamp
input terbaru sehingga dua run dengan input identik menghasilkan hash identik. Environment
variables yang tersedia:

- `RADAR_DATA_DIR`: folder input, default `radar/data`.
- `RADAR_TRIGGER_TAXONOMY_FILE`: taxonomy, default `radar/config/trigger_taxonomy.json`.
- `RADAR_TRIGGER_OUTPUT`: output, default `radar/docs/data/trigger_signals.json`.

Dashboard menampilkan maksimal 20 item awal pada panel **Trigger Kebutuhan**, dengan prioritas
future direct, future indirect, current/unclear, completed, lalu historical. Filter mencakup
kategori, class, evidence strength, timing status, dan type. Konten informational/editorial tidak
tampil pada initial list, tetapi suppression count tetap terlihat. Product hypotheses selalu
diberi label perlu verifikasi. Tidak ada scoring numerik, ranking penjualan, sumber scraping baru,
keputusan manusia otomatis, atau outreach pada Fase J.

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
