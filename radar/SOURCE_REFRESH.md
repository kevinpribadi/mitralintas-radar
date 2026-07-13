# Controlled Manual Source Refresh (J.2C)

## Tujuan dan batas keamanan

`Source Pilot Refresh` membuat proposal pembaruan snapshot BKPM beserta diff dan laporan audit.
Workflow hanya dapat dimulai manusia melalui `workflow_dispatch`. Hasilnya adalah artifact sementara,
bukan data produksi. Workflow tidak memiliki cron, schedule, auto-commit, push, Pull Request, atau
auto-merge, dan tidak pernah menulis ke snapshot atau trigger output committed.

BKPM (`BKPM_PRESS_RELEASES`) adalah satu-satunya source yang dapat dipilih karena status registry-nya
`ACCEPTED_FOR_TRIGGER_PILOT`. Kemenperin tetap `REJECTED` dengan alasan `TLS_CERT_EXPIRED`; workflow
tidak menawarkan atau mengambil source tersebut dan tidak menonaktifkan pemeriksaan TLS.

## Menjalankan refresh manual

1. Buka repository di GitHub, pilih tab **Actions**.
2. Pilih workflow **Source Pilot Refresh**.
3. Tekan **Run workflow**.
4. Pastikan branch yang hendak diaudit benar, isi input, lalu tekan tombol Run workflow GitHub.
5. Tunggu job selesai. Job yang gagal tetap dapat menyediakan artifact audit aman bila output sudah
   terbentuk; kegagalan berarti proposal tidak layak menggantikan last-known-good.

Arti input:

- `source_code`: hanya `BKPM_PRESS_RELEASES`.
- `max_items`: batas item proposal, minimum 1, maksimum 50, default 25.
- `max_detail_requests`: batas request halaman detail, minimum 1, maksimum 25, default 15.
- `run_trigger_build`: membangun dan membandingkan proposed trigger output di path sementara.
- `include_html_report`: menyertakan laporan HTML statis mobile-friendly.

## Mengunduh dan membuka artifact

Di halaman run, buka bagian **Artifacts**, unduh bundle `source-pilot-refresh-<run-id>`, lalu ekstrak
seluruh file dalam satu folder. Buka `source_refresh_report.html`; CSS dan JavaScript harus berada di
folder yang sama. Laporan tidak memerlukan internet, CDN, font eksternal, external API, atau framework.
Link **Buka sumber resmi** adalah satu-satunya navigasi keluar dan hanya dirender untuk URL HTTPS BKPM
yang lolos exact allowlist.

Artifact disimpan maksimal 14 hari. Bundle tidak memuat raw article HTML, response dump, cookie,
credential, authorization header, atau browser profile.

## Membaca snapshot diff

`source_snapshot_diff.json` bersifat deterministic, order-independent, dan mempertahankan baseline.
Bagian `added`, `removed`, `changed`, dan `unchanged` dibandingkan menggunakan stable ID. Posisi array
tidak dihitung sebagai perubahan. Changed item mencantumkan field dan reason:
`CONTENT_CHANGED`, `DATE_CHANGED`, `LINK_CHANGED`, `QUALITY_CHANGED`, `PROVENANCE_CHANGED`,
`ORGANIZATION_HINT_CHANGED`, atau `CLASSIFICATION_HINT_CHANGED`.

`removed` berarti item tidak muncul dalam proposal—bukan instruksi otomatis untuk menghapus baseline.
Periksa health, HTTP 200, content type HTML, jumlah valid/invalid/duplicate, link resmi, tanggal, serta
provenance sebelum mengambil keputusan.

### Missing, invalid, dan fabricated metadata

Quality gate membedakan tiga keadaan. Metadata `missing`/`unknown` berarti sumber tidak memberikan
bukti eksplisit; nilainya tetap kosong, dihitung, diberi warning, dan wajib diverifikasi manusia.
Kondisi ini bukan fabrication dan tidak otomatis menolak proposal. `ORGANIZATION_MISSING` menandai
organization hint kosong/unknown; publisher tidak pernah dipakai sebagai buyer.
`PUBLISHED_DATE_MISSING` menandai tanggal kosong dengan `date_status=missing`, tanpa membuat tanggal
pengganti dari retrieval time atau runtime. Item tersebut diberi penanda verifikasi timing.

Metadata invalid mempunyai nilai/status yang tidak memenuhi kontrak dan menjadi critical error, seperti
`ORGANIZATION_INVALID` atau `PUBLISHED_DATE_INVALID`. Metadata fabricated adalah nilai yang berasal
dari publisher/inference/runtime, tidak terdapat pada source, atau ditandai fabricated; proposal ditolak
dengan `ORGANIZATION_FABRICATION_DETECTED`, `PUBLISHED_DATE_FABRICATION_DETECTED`, atau
`EXCERPT_FABRICATION_DETECTED`.

Kelengkapan tanggal dihitung dari tanggal ISO valid dibagi seluruh proposed item. Default configurable
gate `RADAR_SOURCE_MINIMUM_DATE_COMPLETENESS_PERCENT` adalah 70. Kelengkapan minimal 70% dapat masuk
`REVIEW_REQUIRED`; nilai di bawah 70% menghasilkan `DATE_COMPLETENESS_BELOW_THRESHOLD` dan
`REJECT_PROPOSAL`. Satu atau beberapa missing date tidak ditolak selama threshold masih terpenuhi.

## Membaca trigger diff

`trigger_diff.json` membandingkan committed dan proposed trigger output tanpa memperhitungkan urutan.
Bagian utamanya adalah signal pilot baru/dihapus, perubahan klasifikasi, timing, evidence, dan
`production_semantic_changes`. Nilai production semantic changes harus 0. Stable ID production tidak
boleh berubah. Semua signal pilot baru wajib memiliki provenance dan review manusia; numeric score dan
outreach tetap dilarang.

## Arti rekomendasi

- `REVIEW_REQUIRED`: proposal memiliki perubahan material dan tidak melanggar gate; reviewer manusia
  tetap harus memeriksa seluruh perubahan. Status ini juga dipakai untuk missing organization/date atau
  classification hint unknown yang masih berada di atas quality threshold.
- `REJECT_PROPOSAL`: ada error validasi, fetch/source health tidak layak, output kosong/abnormal,
  provenance/link tidak lengkap, metadata invalid/fabricated, quality di bawah threshold, source
  terlarang, atau production semantics berubah. Jangan mengganti last-known-good.
- `NO_MATERIAL_CHANGE`: proposal valid tetapi snapshot dan trigger tidak mempunyai perubahan material.

Tidak ada status automatic accept.

## Penerimaan snapshot setelah audit

Penerimaan dilakukan di luar workflow ini sebagai perubahan manual yang sengaja dibuat dan direview:

1. verifikasi artifact berasal dari run dan branch yang benar;
2. audit health, seluruh added/changed/removed item, trigger diff, evidence, dan production gate;
3. pastikan rekomendasi bukan `REJECT_PROPOSAL`;
4. salin proposed snapshot hanya dalam perubahan terpisah yang disetujui manusia;
5. bangun ulang trigger output secara lokal dari snapshot yang direview;
6. jalankan source pilot, trigger, human feedback, dan source refresh regression tests;
7. review diff Git sebelum commit terpisah. Jangan memasukkan artifact runtime ke repository.

Workflow J.2C sendiri tidak melakukan salah satu tindakan penerimaan tersebut.

## Penggunaan pada ponsel

Report memakai card layout dan filter full-width, target interaksi minimum 44px, text wrapping untuk URL
dan evidence, focus-visible, heading semantik, label form, serta status tekstual yang tidak bergantung
pada warna. Layout memiliki kontrak 360px, 390px, 768px, dan 1024px. Ekstrak bundle sebelum membuka
HTML agar asset lokal dapat dibaca. Beberapa aplikasi preview artifact memblokir JavaScript lokal;
jika demikian, buka file di browser perangkat. Laporan adalah file statis: filter hanya bekerja selama
halaman terbuka dan tidak menyimpan keputusan reviewer.

## Menjalankan test lokal

```bash
node radar/scripts/test_source_refresh.js
node radar/scripts/test_source_pilot.js
node radar/scripts/test_trigger_source_pilot.js
node radar/scripts/test_trigger_signals.js
node radar/scripts/test_human_feedback.js
```
