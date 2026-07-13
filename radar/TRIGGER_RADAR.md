# Trigger Radar V1

Trigger Radar mendeteksi peristiwa pada data tender dan event yang sudah tersedia. Trigger
merupakan indikasi awal yang dapat mendahului kebutuhan tekstil atau apparel. Trigger bukan
bukti bahwa organisasi memiliki kebutuhan, akan membeli, atau layak menjadi peluang.

Sistem bersifat deterministic, tidak memakai AI/API eksternal, tidak menambah sumber scraping,
tidak membuat opportunity score, dan tidak melakukan outreach. Seluruh hasil memerlukan review
manusia.

## Trigger taxonomy

Taxonomy machine-readable berada di `config/trigger_taxonomy.json`. Sepuluh kategori V1:

- `DIRECT_PROCUREMENT`: pengadaan atau tender disebut langsung.
- `FACILITY_OPENING`: fasilitas atau lokasi operasi baru dibuka.
- `BUSINESS_EXPANSION`: kapasitas, operasi, fasilitas, atau armada diperluas.
- `MASS_RECRUITMENT`: penambahan tenaga kerja atau onboarding skala besar.
- `REBRANDING_OR_IDENTITY_CHANGE`: brand, logo, atau identitas berubah.
- `CORPORATE_OR_INSTITUTIONAL_EVENT`: kegiatan atau perayaan organisasi.
- `SPORTS_OR_COMMUNITY_EVENT`: kegiatan olahraga atau komunitas.
- `GRADUATION_OR_EDUCATION_EVENT`: wisuda, orientasi, penerimaan, atau tahun ajaran.
- `SAFETY_OR_OPERATIONAL_PROGRAM`: keselamatan kerja atau program operasi lapangan.
- `HISTORICAL_PROCUREMENT_PATTERN`: perkara, audit, atau referensi pengadaan historis.

Setiap entry memiliki code, label, description, trigger class, positive terms, phrase terms,
negative terms, product hypotheses, dan allowed actions. Beberapa kategori juga memiliki
`required_any_terms` agar keyword umum hanya cocok bila konteks minimum terlihat.

Product hypotheses adalah dugaan kategori produk untuk diverifikasi. Nilai tersebut berasal
langsung dari taxonomy, bukan klaim kebutuhan pada organisasi yang diberitakan.

## Trigger classes

- `direct`: data menyebut sinyal pengadaan secara langsung.
- `indirect`: data menyebut peristiwa yang secara masuk akal dapat mendahului kebutuhan produk,
  tetapi kebutuhan produk belum terkonfirmasi.
- `historical`: data berfungsi sebagai perkara, audit, pola, atau referensi masa lalu.

Satu item boleh memiliki beberapa trigger. Primary trigger dipilih secara deterministic dan
berbasis konteks. Direct menjadi primary bila terdapat pengadaan aktif, tender terbuka, RUP,
atau proses pengadaan berjalan. Historical menjadi primary bila judul terutama membahas audit,
korupsi, penyidikan, perkara, temuan, kelebihan bayar, atau penyimpangan. Historical tetap dapat
disimpan sebagai secondary trigger. Setelah aturan kontekstual tersebut, class precedence,
strength, urutan taxonomy, dan trigger code menjadi tie-breaker. Aturan ini bukan ranking
komersial dan bukan opportunity score.

## Timing status

Setiap signal memiliki satu `timing_status`:

- `FUTURE_OR_OPEN`: kegiatan akan datang, pendaftaran/tender terbuka, atau event date setelah
  reference date deterministic.
- `CURRENT_OR_UNCLEAR`: waktu belum cukup jelas atau berada pada reference date yang sama.
- `COMPLETED_OR_PAST`: kegiatan telah selesai atau event date sudah lewat.
- `HISTORICAL_REFERENCE`: primary trigger berupa referensi historis.
- `INFORMATIONAL_OR_EDITORIAL`: konten informasional yang masih memiliki trigger lain di luar
  kategori event yang disuppress.

Tanggal event eksplisit hanya diambil dari field event `tanggal`. Field `published` tetap dapat
ditampilkan sebagai metadata, tetapi tidak dianggap event date. Reference date berasal dari
`generated_at` input terbaru, bukan wall-clock saat builder berjalan. Phrase future/completed
berada di taxonomy dan phrase spesifik seperti `akan gelar` atau `telah menggelar` tidak
disimpulkan dari kata `gelar` saja.

## Evidence strength

- `STRONG`: direct/historical phrase eksplisit ditemukan serta source, link, dan tanggal valid.
- `MODERATE`: trigger jelas melalui phrase, tetapi kebutuhan produk tidak eksplisit; atau terdapat
  kombinasi beberapa keyword yang didukung sumber traceable.
- `WEAK`: hanya keyword generik atau konteks bukti terbatas.

Strength bersifat kategorikal dan tidak dikonversi menjadi angka. Evidence excerpt selalu berupa
substring dari judul input. Sistem tidak menyusun kalimat yang seolah-olah berasal dari sumber.

## Negative rules

Negative terms berada di taxonomy, bukan disisipkan sebagai aturan domain tersembunyi di builder.
Contohnya:

- `ekspansi kredit` tidak menjadi `BUSINESS_EXPANSION`.
- `pembukaan perdagangan` tidak menjadi `FACILITY_OPENING`.
- `rekrutmen politik` tidak menjadi `MASS_RECRUITMENT`.
- konteks perkara atau korupsi dapat menjadi historical primary tanpa menghapus direct secondary.
- kata `run` saja tidak digunakan sebagai trigger olahraga.
- `HUT` tanpa phrase kegiatan lain tetap berstrength `WEAK`.
- artikel rekomendasi, listicle, tema, hidden gem, tips, hoaks, dan konten editorial lain tidak
  dianggap event organisasi/olahraga aktual.
- `investasi` dan `tenaga kerja` tanpa phrase operasional eksplisit tidak cukup untuk menjadi
  expansion atau mass recruitment.

Negative rules mengurangi false positive, tetapi tidak menggantikan verifikasi manusia.

## Output dan count

Builder menulis `docs/data/trigger_signals.json`. Semua tender/event dihitung pada
`evaluated_total`; hanya item dengan minimal satu trigger disimpan di `items`. Item lainnya
dihitung dalam `items_without_trigger`.

`trigger_counts` menghitung seluruh trigger yang cocok. `class_counts`, `strength_counts`, dan
`timing_counts` menghitung primary trigger/item sehingga masing-masing distribusi menjumlah ke
`signal_total`. `suppressed_editorial_total` mencatat item dengan event trigger yang dibuang oleh
aturan editorial. Item tersebut tidak menjadi signal kecuali memiliki trigger lain yang valid.

Stable item ID menggunakan identitas yang sama dengan review queue dan qualification readiness.
Output disortir secara netral berdasarkan type, title, source, stable ID, lalu index input. Tidak
ada ranking komersial.

## Suggested actions

Action yang diizinkan:

- `VERIFY_TRIGGER`
- `VERIFY_ORGANIZATION`
- `VERIFY_TIMING`
- `VERIFY_PRODUCT_NEED`
- `OPEN_OFFICIAL_SOURCE`
- `ADD_TO_WATCHLIST`
- `PREPARE_FOR_HUMAN_QUALIFICATION`

Future/open signal dapat diarahkan ke persiapan qualification atau verifikasi organisasi/produk.
Current/unclear diarahkan ke verifikasi waktu/trigger, completed ke watchlist/verifikasi waktu,
dan historical ke watchlist/verifikasi trigger. Tidak ada contact, email, WhatsApp, offer, bid,
atau pricing otomatis.

## Menjalankan lokal

```bash
node radar/scripts/build_trigger_signals.js
node radar/scripts/test_trigger_signals.js
```

Environment variables:

- `RADAR_DATA_DIR`: folder input tender/event, default `radar/data`.
- `RADAR_TRIGGER_TAXONOMY_FILE`: taxonomy, default `radar/config/trigger_taxonomy.json`.
- `RADAR_TRIGGER_OUTPUT`: output, default `radar/docs/data/trigger_signals.json`.

`generated_at` diambil dari timestamp input terbaru dan tidak memakai waktu eksekusi. Penulisan
JSON dilakukan secara atomik, sehingga input identik menghasilkan output dan hash identik.
