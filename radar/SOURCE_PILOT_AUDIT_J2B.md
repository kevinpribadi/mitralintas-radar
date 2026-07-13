# Audit Manual Source Pilot J.2B

Audit ini mencakup seluruh 10 item BKPM pada snapshot committed. Audit tidak mengubah output
builder. Organization hint ditampilkan apa adanya; nilai kosong tidak diisi dengan publisher.
Hipotesis produk bukan kebutuhan terkonfirmasi dan selalu perlu verifikasi manusia.

## 1. Bidik Investor Australia, Wamen Investasi Tawarkan Kerjasama Pangan dan Infrastruktur

- Published date: `2026-06-30`
- Organization hint: `(kosong)`
- Detected triggers / primary: tidak ada / `—`
- Matched evidence dan field: `—`
- Timing status: `CURRENT_OR_UNCLEAR` (audit manual; bukan signal)
- Suggested action: tidak ada pada output; verifikasi trigger hanya bila ditinjau manusia
- Product hypotheses: `—`
- Keputusan audit: `NOT_A_TRIGGER`

## 2. Wamen Todotua: Indonesia dan Australia Berada pada Momentum Tepat Perkuat Kemitraan Investasi

- Published date: `2026-06-30`
- Organization hint: `(kosong)`
- Detected triggers / primary: tidak ada / `—`
- Matched evidence dan field: `—`
- Timing status: `CURRENT_OR_UNCLEAR` (audit manual; bukan signal)
- Suggested action: tidak ada pada output; verifikasi trigger hanya bila ditinjau manusia
- Product hypotheses: `—`
- Keputusan audit: `NOT_A_TRIGGER`

## 3. Investor Australia Minati Peluang Rantai Pasok Baterai RI

- Published date: `2026-06-29`
- Organization hint: `(kosong)`
- Detected triggers / primary: `FACILITY_DEVELOPMENT` / `FACILITY_DEVELOPMENT`
- Matched evidence dan field: `pembangunan fasilitas` — `excerpt` — “rencana investasi pembangunan fasilitas precursor Cathode Active Material (pCAM)”
- Timing status: `CURRENT_OR_UNCLEAR`
- Suggested action: `VERIFY_TIMING`
- Product hypotheses (perlu verifikasi): pakaian kerja proyek; wearpack; safety apparel; seragam operasional masa depan
- Keputusan audit: `TRUE_TRIGGER`

## 4. Menteri Rosan: Kolaborasi Riset dan Industri Jadi Kunci Hilirisasi Bernilai Tambah

- Published date: `2026-06-27`
- Organization hint: `(kosong)`
- Detected triggers / primary: tidak ada / `—`
- Matched evidence dan field: `—`
- Timing status: `CURRENT_OR_UNCLEAR` (audit manual; bukan signal)
- Suggested action: tidak ada pada output; verifikasi trigger hanya bila ditinjau manusia
- Product hypotheses: `—`
- Keputusan audit: `NOT_A_TRIGGER`

## 5. Keminveshil/BKPM: Kepercayaan Investor Global Tetap Terjaga

- Published date: `2026-06-26`
- Organization hint: `(kosong)`
- Detected triggers / primary: tidak ada / `—`
- Matched evidence dan field: `—`
- Timing status: `CURRENT_OR_UNCLEAR` (audit manual; bukan signal)
- Suggested action: tidak ada pada output; verifikasi trigger hanya bila ditinjau manusia
- Product hypotheses: `—`
- Keputusan audit: `NOT_A_TRIGGER`

## 6. Dorong Hilirisasi Perkebunan, Wamen Investasi Percepat Pabrik Bioetanol 60 Ribu Kilo Liter di Lampung

- Published date: `2026-06-09`
- Organization hint: `(kosong)`
- Detected triggers / primary: tidak ada / `—`
- Matched evidence dan field: `—`
- Timing status: `CURRENT_OR_UNCLEAR` (audit manual; bukan signal)
- Suggested action: tidak ada pada output; verifikasi tahap proyek dan trigger
- Product hypotheses: `—` (belum boleh disimpulkan)
- Keputusan audit: `PLAUSIBLE_BUT_UNCONFIRMED`

## 7. Tanjung Carat Diproyeksikan Jadi Simpul Baru Konektivitas Logistik di Sumatera Selatan

- Published date: `2026-05-13`
- Organization hint: `(kosong)`
- Detected triggers / primary: tidak ada / `—`
- Matched evidence dan field: `—`
- Timing status: `CURRENT_OR_UNCLEAR` (audit manual; bukan signal)
- Suggested action: tidak ada pada output; verifikasi scope fasilitas dan tahap proyek
- Product hypotheses: `—` (belum boleh disimpulkan)
- Keputusan audit: `PLAUSIBLE_BUT_UNCONFIRMED`

## 8. Kementerian Investasi dan Hilirisasi Dukung Percepatan 13 Proyek Hilirisasi Strategis Tahap II

- Published date: `2026-04-29`
- Organization hint: `(kosong)`
- Detected triggers / primary: `FACILITY_DEVELOPMENT` / `FACILITY_DEVELOPMENT`
- Matched evidence dan field: `groundbreaking` — `excerpt` — “pelaksanaan groundbreaking 13 proyek hilirisasi tahap II”
- Timing status: `CURRENT_OR_UNCLEAR`
- Suggested action: `VERIFY_TIMING`
- Product hypotheses (perlu verifikasi): pakaian kerja proyek; wearpack; safety apparel; seragam operasional masa depan
- Keputusan audit: `TRUE_TRIGGER`

## 9. Investasi Awal Tahun Tumbuh 7,2%, Pemerintah Implementasikan KBLI yang Lebih Adaptif

- Published date: `2026-04-23`
- Organization hint: `(kosong)`
- Detected triggers / primary: tidak ada / `—`
- Matched evidence dan field: `—`
- Timing status: `CURRENT_OR_UNCLEAR` (audit manual; bukan signal)
- Suggested action: tidak ada pada output; verifikasi trigger hanya bila ditinjau manusia
- Product hypotheses: `—`
- Keputusan audit: `NOT_A_TRIGGER`

## 10. Proyek Bioetanol Lampung Memasuki Tahap Baru

- Published date: `2026-04-20`
- Organization hint: `(kosong)`
- Detected triggers / primary: `FACILITY_DEVELOPMENT` / `FACILITY_DEVELOPMENT`
- Matched evidence dan field: `konstruksi proyek` — `excerpt` — “Konstruksi proyek yang diharapkan mulai pada kuartal III 2026”
- Timing status: `CURRENT_OR_UNCLEAR`
- Suggested action: `VERIFY_TIMING`
- Product hypotheses (perlu verifikasi): pakaian kerja proyek; wearpack; safety apparel; seragam operasional masa depan
- Keputusan audit: `TRUE_TRIGGER`

## False-positive risks

- Tiga detected trigger membuktikan aktivitas pengembangan fasilitas, tetapi belum membuktikan
  buyer, organisasi target, kebutuhan apparel, volume, pengadaan, atau waktu pembelian.
- Item 8 menggabungkan 13 proyek; detail organisasi/fasilitas per proyek tidak tersedia pada
  excerpt, sehingga tidak boleh diperlakukan sebagai satu buyer atau satu kebutuhan.
- Istilah `konstruksi proyek` dapat terlalu umum pada sumber lain. Negative terms dan scope pilot
  mengurangi risiko, tetapi review konteks fasilitas fisik tetap wajib.

Tidak ada detected item yang dinilai `NOT_A_TRIGGER` pada audit ini; jadi tidak ada false positive
terkonfirmasi, hanya risiko false positive di atas.

## False-negative risks

- Item 6 masuk `PLAUSIBLE_BUT_UNCONFIRMED`: judul menyebut percepatan pabrik bioetanol dan
  excerpt masih menyebut penjajakan pengembangan, tetapi tidak ada phrase tahap konstruksi yang
  cukup eksplisit untuk taxonomy saat ini.
- Item 7 masuk `PLAUSIBLE_BUT_UNCONFIRMED`: ada MoU integrasi pembangunan jalan tol menuju
  pelabuhan baru, tetapi scope `FACILITY_DEVELOPMENT` sengaja tidak diperluas ke setiap proyek
  infrastruktur agar false positive tetap konservatif.

Kedua risiko false negative tersebut sengaja tidak mengubah output pada implementasi J.2B.
