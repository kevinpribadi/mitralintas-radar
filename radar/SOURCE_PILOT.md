# Official Source Acquisition Pilot

## TLS dan refresh aman J.2C.3

Live HTTPS BKPM pada Node memerlukan operating-system CA store. Verifikasi TLS tetap aktif; system CA
bukan TLS bypass. Workflow manual hanya menerapkan `--use-system-ca` pada step fetch BKPM dan tidak
memengaruhi test. `KEMENPERIN_IMC_NEWS` tetap `REJECTED` dengan `TLS_CERT_EXPIRED`, tidak selectable,
tidak di-fetch, dan tidak masuk snapshot, health refresh BKPM, atau trigger build.

Untuk refresh lokal gunakan `node radar/scripts/run_source_refresh_safe.js`. Output selalu berada di
`.source-refresh-work/manual`, sedangkan snapshot production hanya menjadi last-known-good read-only.
Jangan memakai fetcher langsung untuk production dan jangan pernah menonaktifkan verifikasi TLS.

## Tujuan

Source Pilot menguji apakah berita dan siaran pers dari domain resmi dapat diambil sebagai HTML statis, divalidasi, dan dinormalisasi secara aman. Fase J.2B tetap mempertahankan snapshot pada lapisan karantina, lalu membacanya sebagai corpus tambahan opsional untuk Trigger Radar. File tender, event, review queue, qualification readiness, dan human feedback tidak digabung atau diubah.

Item pilot bukan peluang dan bukan bukti bahwa organisasi akan membeli produk Mitra Lintas. Semua classification hint memerlukan review manusia.

## Sumber Pilot

Registry berada di `radar/config/source_registry.json` dan dibatasi maksimal dua sumber:

- `BKPM_PRESS_RELEASES`: siaran pers resmi Kementerian Investasi dan Hilirisasi/BKPM pada `www.bkpm.go.id`.
- `KEMENPERIN_IMC_NEWS`: berita resmi Industrial Manufacturing Center Kemenperin pada `imc.kemenperin.go.id`.

Setiap sumber dapat dimatikan secara independen dengan `enabled_for_pilot`. Host, listing URL, path yang diizinkan, jenis sumber, sasaran classification hint, dan strategi parser dicatat dalam registry. Redirect dan canonical URL di luar exact official domain tidak diikuti.

Keputusan integrasi trigger tidak diturunkan dari health runtime. Registry mempunyai status config
yang dapat diaudit: `ACCEPTED_FOR_TRIGGER_PILOT`, `PILOT_ONLY`, `DISABLED`, dan `REJECTED`.
J.2B menetapkan `BKPM_PRESS_RELEASES` sebagai `ACCEPTED_FOR_TRIGGER_PILOT` setelah acceptance
gate J.2A. `KEMENPERIN_IMC_NEWS` berstatus `REJECTED` dengan alasan
`TLS_CERT_EXPIRED`; itemnya tidak boleh masuk Trigger Radar.

## Preflight dan Fail-Closed

Fetcher memeriksa HTTPS, status HTTP, content type HTML, robots policy, halaman login, link detail statis, dan kemampuan parser tanpa browser automation. Status sumber adalah:

- `HEALTHY`: HTML statis dapat diproses dan field wajib lengkap.
- `DEGRADED`: item valid tetap tersedia, tetapi metadata opsional atau sebagian detail memiliki warning yang dapat diaudit.
- `UNAVAILABLE`: sumber tidak dapat diakses atau tidak menghasilkan item valid.
- `BLOCKED`: akses dilarang robots, login, atau respons 401/403/429.
- `UNSUPPORTED_DYNAMIC_PAGE`: tidak ada link detail statis yang dapat digunakan.
- `INVALID_CONFIGURATION`: konfigurasi sumber tidak valid.

Hanya sumber `HEALTHY` atau `DEGRADED` yang dapat menghasilkan item. Tidak ada login, cookie, credential, proxy, CAPTCHA bypass, penonaktifan verifikasi TLS, browser automation, atau fallback ke search engine.

## Batas Akses

Request dilakukan sequential dengan user agent publik yang tercatat. Default registry menetapkan interval minimal 1.000 ms, timeout 15.000 ms, maksimal 50 item per sumber, dan maksimal 25 detail request per sumber. Network error transient dan HTTP 5xx mendapat maksimal satu retry; 403, 429, dan robots restriction tidak di-retry agresif.

## Mode Eksekusi

Live mode:

```powershell
node .\radar\scripts\fetch_source_pilot.js
```

Offline fixture mode:

```powershell
$env:RADAR_SOURCE_OFFLINE = "1"
node .\radar\scripts\fetch_source_pilot.js
```

Environment variables yang tersedia:

- `RADAR_SOURCE_REGISTRY`
- `RADAR_SOURCE_PILOT_OUTPUT`
- `RADAR_SOURCE_HEALTH_OUTPUT`
- `RADAR_SOURCE_MAX_ITEMS`
- `RADAR_SOURCE_TIMEOUT_MS`
- `RADAR_SOURCE_FIXTURE_DIR`
- `RADAR_SOURCE_OFFLINE`
- `RADAR_SOURCE_CODES`

Fixture di `radar/tests/fixtures/sources/` diberi label sintetis secara eksplisit. Fixture digunakan untuk test deterministic dan bukan response dump produksi.

## Normalisasi dan Provenance

Output karantina berada di:

- `radar/docs/data/source_pilot_items.json`
- `radar/docs/data/source_pilot_health.json`

Item hanya menyimpan field audit minimum: stable ID, source code, judul, link, tanggal publik jika tersedia, organization hint jika eksplisit, excerpt maksimal 500 karakter, provenance, quality status, classification hint, dan content hash. HTML mentah tidak disimpan.

Tanggal hanya berasal dari metadata publik sumber. Waktu retrieval tidak digunakan sebagai tanggal publik. Publisher tidak otomatis dianggap sebagai organisasi target. Jika organisasi target tidak eksplisit, `organization_hint` dikosongkan dan statusnya `unknown`.

Classification hint non-final yang diperbolehkan:

- `FACILITY_OPENING_CANDIDATE`
- `BUSINESS_EXPANSION_CANDIDATE`
- `MASS_RECRUITMENT_CANDIDATE`
- `OTHER_OFFICIAL_NEWS`

Hint hanya menggunakan frasa eksplisit, menyimpan evidence dari HTML sumber, dan selalu memiliki `human_review_required: true`. Tidak ada numeric score, ranking komersial, atau klaim kebutuhan produk.

## Deduplikasi

Deduplikasi dilakukan secara berurutan:

1. canonical URL exact;
2. content hash;
3. normalized title dan source code.

Artikel yang hanya membahas organisasi yang sama tidak digabungkan. Jumlah duplikat dan alasan deduplikasi dicatat dalam output.

## Last-Known-Good

Penulisan JSON bersifat atomic. Jika seluruh sumber gagal pada live mode, health report tetap ditulis, tetapi output item non-empty terakhir dipertahankan. Jika belum ada last-known-good, proses gagal dengan error dan tidak membuat output kosong yang seolah valid. Kegagalan satu sumber tidak menghapus hasil valid sumber lain.

## Hasil Pilot J.2A

Pada preflight J.2A, listing BKPM dapat diakses sebagai HTML statis dan menyediakan link detail serta tanggal publik. Sumber dipertahankan sebagai `DEGRADED` karena dua halaman menerbitkan canonical host yang tidak sesuai exact allowlist; canonical tersebut tidak diikuti dan URL detail resmi yang sudah diverifikasi digunakan dengan warning audit.

IMC Kemenperin berstatus `UNAVAILABLE` karena sertifikat HTTPS situs kedaluwarsa saat preflight. Fetcher tidak menonaktifkan validasi TLS dan tidak mencoba bypass.

## Integrasi Snapshot J.2B

Trigger builder membaca snapshot committed `source_pilot_items.json`, bukan menjalankan fetcher.
Hanya source dengan status config `ACCEPTED_FOR_TRIGGER_PILOT` yang dievaluasi. BKPM mempunyai
10 item valid; title, link, date, excerpt, dan provenance tersedia, sedangkan seluruh
`organization_hint` kosong. Publisher BKPM tidak digunakan sebagai buyer.

Detection pilot menggunakan `title` dan `excerpt`, menyimpan field asal evidence, provenance
resmi, dan kewajiban review manusia. Snapshot yang hilang tidak membuat item palsu dan tidak
menggagalkan build production. Registry invalid membuat integrasi pilot fail-closed. Workflow
boleh menjalankan builder dan test terhadap snapshot committed, tetapi tidak menjalankan
`fetch_source_pilot.js`, tidak membuat request BKPM, dan tidak mengubah schedule.

## Keterbatasan dan Tahap Berikutnya

Parser static HTML dapat gagal ketika markup sumber berubah atau halaman berpindah ke rendering dinamis. Classification hint sengaja sempit dan dapat menghasilkan false negative. Organization hint sering kosong karena publisher bukan organisasi target.

Live acquisition tetap tidak dijalankan terjadwal. J.2B hanya mengintegrasikan snapshot BKPM yang
diterima ke output trigger gabungan dengan count production terpisah. Organization extraction
masih terbatas (0/10 pada snapshot), sehingga seluruh signal memerlukan audit manual dan verifikasi
organisasi, timing, trigger, serta kebutuhan produk.

Audit per item, termasuk keputusan `TRUE_TRIGGER`, `PLAUSIBLE_BUT_UNCONFIRMED`, dan
`NOT_A_TRIGGER`, tersedia di `SOURCE_PILOT_AUDIT_J2B.md`. Audit tersebut bersifat pelaporan dan
tidak digunakan untuk mengubah hasil deterministic builder.

## Controlled refresh J.2C

Snapshot quarantine dapat diperbarui sebagai proposal melalui workflow manual **Source Pilot Refresh**.
Input source hanya BKPM yang accepted; Kemenperin tidak selectable dan tetap ditolak karena
`TLS_CERT_EXPIRED`. Live fetch menulis proposed items dan health hanya ke direktori temporary runner.
Committed `source_pilot_items.json`, `source_pilot_health.json`, serta last-known-good tidak ditimpa.

Proposal divalidasi fail-closed untuk access/HTTP/content type/allowlist, minimum valid item, output
kosong, link dan provenance 100%, metadata invalid/fabricated, date completeness di bawah threshold,
duplicate abnormal, source Kemenperin, serta perubahan file committed. Artifact mencakup diff dan laporan
order-independent yang mobile-friendly, tetapi tidak memuat raw source HTML. Tidak ada scheduled fetch
atau penerimaan otomatis. Lihat [SOURCE_REFRESH.md](SOURCE_REFRESH.md) untuk prosedur audit dan
penerimaan manual.

Missing organization/date bukan integrity failure. Nilai kosong dengan status `unknown`/`missing`
dipertahankan apa adanya, dihitung, dan diberi warning tanpa menggunakan publisher, retrieval time,
atau inference sebagai pengganti. Metadata invalid/fabricated, link/provenance invalid, serta date
completeness di bawah default gate 70% tetap fail-closed. Seluruh missing metadata dan trigger timing
terkait tetap memerlukan verifikasi manusia.
