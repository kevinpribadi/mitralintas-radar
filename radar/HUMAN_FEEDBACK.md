# Human Feedback Loop V1

Human Feedback Loop V1 memungkinkan reviewer menilai item qualification readiness secara
manual di dashboard. Fitur ini adalah pilot lokal berbasis browser. Tidak ada backend,
database cloud, autentikasi, sinkronisasi antar-user, atau keputusan otomatis.

## Machine readiness dan human decision

Machine readiness berasal dari `qualification_readiness.json`, dihasilkan oleh aturan
deterministik, dan selalu read-only. State machine readiness adalah:

- `READY_FOR_HUMAN_QUALIFICATION`
- `NEEDS_MORE_INFORMATION`
- `NEEDS_DATA_REVIEW`
- `EXPIRED_OR_HISTORICAL`
- `LOW_PRODUCT_RELEVANCE`

Human decision hanya dibuat oleh reviewer. Keputusan disimpan terpisah dan tidak mengubah
machine readiness:

- `QUALIFIED`: reviewer menilai sinyal layak masuk persiapan peluang lebih lanjut.
- `NEEDS_RESEARCH`: bukti belum cukup dan perlu diverifikasi.
- `WATCHLIST`: belum actionable tetapi layak dipantau.
- `NOT_RELEVANT`: berdasarkan review manusia, item tidak layak ditindaklanjuti saat ini.
- `UNREVIEWED`: default virtual untuk item tanpa record feedback; state ini tidak disimpan.

`QUALIFIED` bukan jaminan penjualan, kebutuhan, kemenangan, atau kecocokan akhir. Status
sales seperti contacted, meeting, quotation, negotiation, won, dan lost berada di luar fase ini.

## Reason codes

Reason untuk `QUALIFIED`:

- `DIRECT_PROCUREMENT_NEED`
- `DIRECT_EVENT_NEED`
- `PRODUCT_FIT_CONFIRMED`
- `SOURCE_AND_ORGANIZATION_VERIFIED`
- `ACTIONABLE_TIMING`
- `OTHER_VERIFIED_REASON`

Reason untuk `NEEDS_RESEARCH`:

- `VERIFY_SOURCE`
- `VERIFY_ORGANIZATION`
- `VERIFY_TIMING`
- `VERIFY_PRODUCT_NEED`
- `VERIFY_EVENT_DETAILS`
- `VERIFY_QUANTITY`
- `VERIFY_LOCATION`
- `DATA_QUALITY_UNCERTAIN`

Reason untuk `WATCHLIST`:

- `EARLY_TRIGGER`
- `RECURRING_EVENT`
- `FUTURE_BUYING_WINDOW`
- `TIMING_NOT_READY`
- `POTENTIAL_FUTURE_NEED`
- `HISTORICAL_PATTERN`

Reason untuk `NOT_RELEVANT`:

- `NO_PRODUCT_FIT`
- `HISTORICAL_ONLY`
- `DUPLICATE_SIGNAL`
- `NON_COMMERCIAL_INFORMATION`
- `EXPIRED_OPPORTUNITY`
- `DATA_ARTIFACT`
- `ORGANIZATION_OUT_OF_SCOPE`
- `OTHER_NOT_RELEVANT`

Setiap keputusan memerlukan minimal satu reason yang sesuai dengan decision state.

## Next actions

Next action yang diperbolehkan hanya tindakan persiapan atau verifikasi netral:

- `VERIFY_SOURCE`
- `VERIFY_ORGANIZATION`
- `VERIFY_TIMING`
- `VERIFY_PRODUCT_NEED`
- `VERIFY_EVENT_DETAILS`
- `OPEN_OFFICIAL_SOURCE`
- `ADD_TO_WATCHLIST`
- `PREPARE_REQUIREMENT_BRIEF`
- `PREPARE_FOR_SALES_REVIEW`
- `REVIEW_LATER`

`QUALIFIED` dan `NEEDS_RESEARCH` wajib memiliki next action. `WATCHLIST` wajib memiliki
next action atau review date. `NOT_RELEVANT` tidak wajib memiliki next action. Tidak ada
aksi otomatis untuk mengirim pesan, menghubungi orang, mengirim bid, membuat offer, atau
menetapkan harga.

## Penyimpanan lokal

Feedback disimpan pada `localStorage` browser dengan key
`mitralintas_radar_feedback_v1`. Alias reviewer terakhir disimpan terpisah dengan key
`mitralintas_radar_reviewer_v1`. Record hanya berisi stable item ID, keputusan, reason,
alias, note, next action, review date, timestamp, dan audit history. Raw tender/event tidak
disalin ke penyimpanan feedback.

Feedback hanya tersedia pada browser dan perangkat yang sama. Jika `localStorage` tidak
tersedia, dashboard memakai penyimpanan in-memory selama sesi dan menampilkan peringatan.

Gunakan alias singkat atau inisial. Jangan memasukkan email, nomor telepon, NIK, kontak
pribadi, credential, atau data sensitif lain di note.

## Audit history

Penyimpanan keputusan pertama menambah event `DECISION_CREATED`. Setiap perubahan menambah
`DECISION_UPDATED`. History lama tidak dihapus dan event digabung berdasarkan `event_id`
saat import. Current state diambil dari record dengan `updated_at` terbaru.

## Export dan import

Export menghasilkan `mitralintas-feedback-YYYY-MM-DD.json` yang hanya berisi
`schema_version`, `exported_at`, feedback records, dan audit history. Simpan export sebagai
backup manual sebelum berpindah browser atau perangkat.

Import memvalidasi schema, decision state, reason, next action, alias, note, tanggal, dan
history. Dashboard menampilkan preview jumlah valid, invalid, baru, konflik, dan orphaned
sebelum reviewer mengonfirmasi penerapan. Import menggabungkan history dan tidak melakukan
replace-all. Record yang stable item ID-nya tidak ada pada qualification readiness aktif
tetap dipertahankan sebagai orphaned record, tidak tampil di daftar utama, dan ikut export.

## Keterbatasan pilot

- Tidak ada sinkronisasi antar-user atau perangkat.
- Tidak ada kontrol akses atau identitas terverifikasi; alias hanya metadata audit ringan.
- Membersihkan site data browser akan menghapus feedback lokal jika belum diekspor.
- Tidak ada workflow sales, outreach, pricing, scoring, atau keputusan otomatis.
- Migrasi ke private database dan akses terkontrol ditunda ke fase selanjutnya.

Aturan machine-readable berada di `config/human_feedback_rules.json`. Test dapat dijalankan
dengan:

```bash
node radar/scripts/test_human_feedback.js
```
