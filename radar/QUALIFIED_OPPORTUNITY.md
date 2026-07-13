# Qualified Opportunity Definition

Dokumen ini mendefinisikan istilah dan batas keputusan untuk Fase H. Fase ini tidak
mengubah raw signal menjadi Qualified Opportunity. Sistem hanya menilai kesiapan item untuk
diperiksa manusia.

## Raw Signal

Raw Signal adalah item tender atau event yang baru ditemukan dari data radar dan belum
dinilai secara komersial. Item ini dapat berupa berita, pengumuman, atau metadata awal.
Raw Signal belum boleh dianggap sebagai peluang penjualan, kebutuhan yang benar-benar ada,
atau target outreach.

## Qualification Readiness

Qualification Readiness adalah penilaian otomatis berbasis aturan untuk menjawab pertanyaan:
"apakah item ini cukup siap dibawa ke human qualification?" Outputnya berupa state,
checks, reason code, evidence ringkas, dan suggested next action yang netral.

Readiness bersifat draft-only, deterministik, dan dapat diaudit. Ia tidak membuat keputusan
Qualified, tidak memberi numeric opportunity score, tidak mengirim outreach, tidak membuat
harga, dan tidak memperkirakan nilai proyek tanpa bukti.

## Qualified Opportunity

Qualified Opportunity adalah item yang telah memenuhi hard requirements dan telah disetujui
manusia. Status ini belum diterapkan pada Fase H. Pada fase ini tidak ada state `QUALIFIED`,
`WON`, `LOST`, atau `REJECTED`.

## Prinsip Bukti

Setiap rekomendasi harus dapat ditelusuri ke sumber, field data, checks, reason code, dan
evidence yang tersimpan. Sistem tidak boleh mengarang trigger, organisasi, nilai proyek,
kontak pribadi, atau relevansi produk. Jika bukti belum cukup, state harus tetap berada di
readiness review, bukan keputusan final.

## Hard Requirements Calon Qualified Opportunity

Calon Qualified Opportunity harus memiliki:

1. source traceable;
2. informative title;
3. identifiable organization atau organizer;
4. explainable need atau trigger;
5. plausible product fit dengan produk Mitra Lintas;
6. timing yang belum jelas terlewat;
7. actionable next step;
8. human approval.

Butir 8 adalah keputusan manusia dan belum dilakukan pada Fase H.

## Jenis Sinyal

**Direct procurement signal** adalah sinyal yang secara eksplisit menyebut pengadaan,
lelang, pembelian, anggaran, penyedia, atau kebutuhan barang/jasa yang relevan.

**Direct event signal** adalah sinyal kegiatan seperti fun run, HUT, gathering, expo,
pameran, atau event lain yang dapat menjadi konteks kebutuhan pakaian event atau merchandise
tekstil, bila bukti produk memang cukup.

**Indirect/early trigger** adalah sinyal awal seperti pembukaan, ekspansi, perekrutan,
rebranding, atau kegiatan operasional yang mungkin menjadi pemicu kebutuhan, tetapi masih
perlu verifikasi lebih lanjut.

Pada readiness, event atau trigger seperti fun run, jalan sehat, gathering, HUT,
anniversary, festival, konferensi, seminar, wisuda, pembukaan cabang, ekspansi,
rebranding, peluncuran armada, atau safety campaign dapat menunjukkan kebutuhan produk yang
belum terkonfirmasi. Kondisi ini bukan product fit eksplisit dan tidak boleh otomatis masuk
`READY_FOR_HUMAN_QUALIFICATION`; sistem memberi reason `PRODUCT_NEED_UNCONFIRMED` dan next
action `VERIFY_PRODUCT_NEED`.

**Historical reference** adalah item bertanggal valid yang sudah melewati ambang historical
atau lebih tepat dipakai sebagai pembanding historis, bukan buying window aktif.

**Insufficient evidence** adalah item dengan sumber, judul, organisasi, trigger, product fit,
timing, atau next action yang belum cukup jelas untuk dibawa ke qualification manusia.

## Batasan

Readiness tidak menjamin kemenangan, tidak menjamin kebutuhan benar-benar ada, tidak
menjamin relevansi produk secara final, dan tidak menggantikan verifikasi sales. Readiness
juga bukan keputusan hukum, procurement, compliance, harga, atau kelayakan mengikuti tender.
