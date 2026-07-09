#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Radar 1 — Tender Seragam.

Memantau SINYAL pengadaan seragam (pemerintah, pemda, BUMN, swasta) dari
Google News RSS, plus prosesor file export OCDS Opentender (diunduh manual)
untuk intelijen harga historis.

Sumber yang dipakai:
  1. Google News RSS per kata kunci (hl=id, gl=ID). Ini sinyal awal dari
     pemberitaan, BUKAN daftar tender resmi yang lengkap.
  2. File export OCDS dari opentender.net (data publik UU 14/2018, lisensi
     ODbL), diproses lewat --ocds. Data LKPP hanya sampai tahap penetapan
     pemenang, bukan realisasi kontrak — harga bersifat indikatif.

Output: radar/data/tenders.json
Jalankan: python radar/scrapers/tender.py
          python radar/scrapers/tender.py --ocds path/ke/export-ocds.json

Hanya memakai pustaka standar Python (tanpa pip install).
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
OUTPUT_FILE = DATA_DIR / "tenders.json"

REQUEST_TIMEOUT = 20
USER_AGENT = "Mozilla/5.0 (compatible; RadarSeragam/1.0; +https://github.com)"

KEYWORDS = [
    "pengadaan seragam",
    "pengadaan pakaian dinas",
    "tender seragam",
    "pengadaan wearpack",
    "pengadaan kain seragam",
    "pengadaan batik dinas",
    "pengadaan seragam sekolah",
    "pengadaan seragam PDH",
    "pengadaan seragam PDL",
]

# Kata kunci judul paket seragam untuk filter data OCDS.
OCDS_TITLE_KEYWORDS = [
    "seragam", "pakaian dinas", "wearpack", "batik dinas",
    "pdh", "pdl", "kain seragam",
]

# --- Klasifikasi jenis klien (heuristik dari teks judul; tebakan, bukan fakta) ---

_JENIS_KLIEN_RULES = [
    ("sekolah", [
        "sekolah", "siswa", "murid", " sd ", " smp ", " sma ", " smk ",
        "madrasah", "santri", "pondok pesantren",
    ]),
    ("bumn", [
        "bumn", "pln", "pertamina", "pt kai", "kereta api indonesia",
        "telkom", "pelindo", "bulog", "antam", "pgn", "angkasa pura",
        "pupuk indonesia", "bank mandiri", "bri ", "bni ", "persero",
    ]),
    ("pemerintah", [
        "dinas", "pemkab", "pemkot", "pemprov", "pemda", "kementerian",
        "kemenag", "kemendik", "pakaian dinas", "pdh", "pdl", "asn",
        "dprd", "polres", "polda", "polri", "tni", "kodim", "korem",
        "kelurahan", "kecamatan", "bupati", "wali kota", "walikota",
        "gubernur", "satpol", "sekretariat daerah", "setda", "bkpsdm",
        "kejaksaan", "pengadilan", "kpu", "bawaslu", "linmas",
    ]),
    ("swasta", [
        "perusahaan", "pabrik", "hotel", "rumah sakit swasta", "karyawan pt",
    ]),
]


def tebak_jenis_klien(judul):
    """Tebak jenis klien dari judul. Urutan aturan menentukan prioritas."""
    teks = " %s " % judul.lower()
    for jenis, kata_list in _JENIS_KLIEN_RULES:
        for kata in kata_list:
            if kata in teks:
                return jenis
    return "tidak_diketahui"


# Judul berita Indonesia memakai Title Case, sehingga kata kerja/keterangan
# berkapital sering ikut tertangkap regex nama instansi. Pangkas dari buntut.
_BUKAN_NAMA = {
    "kembali", "bakal", "akan", "segera", "larang", "minta", "siap", "siapkan",
    "gratis", "beri", "berikan", "bagikan", "salurkan", "gelar", "resmi",
    "mulai", "wajib", "belum", "sudah", "jadi", "buka", "dorong", "usul",
    "kaji", "tunda", "batal", "batalkan", "ingatkan", "sebut", "klaim",
    "janji", "janjikan", "pastikan", "cek", "sorot", "soroti", "sidak",
    "terima", "serahkan", "anggarkan", "alokasikan", "imbau", "tegaskan",
    "ancam", "copot", "target", "targetkan", "lelang", "lelangkan", "tender",
    "umumkan", "rilis", "rencanakan", "hingga", "usai", "soal", "terkait",
    "disorot", "dikritik", "didesak", "diminta", "tanggapi", "klarifikasi",
}


def _pangkas_bukan_nama(nama):
    """Potong pada stopword pertama; None bila nama tersisa < 2 kata."""
    words = nama.split()
    for i, w in enumerate(words):
        if i > 0 and w.lower().strip(".,") in _BUKAN_NAMA:
            words = words[:i]
            break
    if len(words) < 2:
        return None
    return " ".join(words)


# Pola nama instansi yang bisa diekstrak dari judul berita. Hanya menampilkan
# yang benar-benar muncul di teks sumber — dilarang memfabrikasi nama.
_INSTANSI_PATTERNS = [
    re.compile(r"\b(Dinas [A-Z][A-Za-z]*(?: [A-Za-z][a-z]+){0,4})"),
    re.compile(r"\b(Kementerian [A-Z][A-Za-z]*(?: [A-Za-z][a-z]+){0,4})"),
    re.compile(r"\b(Pem(?:kab|kot|prov|da) [A-Z][a-z]+(?: [A-Z][a-z]+)?)"),
    re.compile(r"\b(Pemerintah (?:Kabupaten|Kota|Provinsi|Daerah) [A-Z][a-z]+(?: [A-Z][a-z]+)?)"),
    re.compile(r"\b((?:Kabupaten|Kota|Provinsi) [A-Z][a-z]+(?: [A-Z][a-z]+)?)"),
    re.compile(r"\b(DPRD [A-Z][a-z]+(?: [A-Z][a-z]+)?)"),
    re.compile(r"\b(Pol(?:res|da|sek) [A-Z][a-z]+(?: [A-Z][a-z]+)?)"),
    re.compile(r"\b(PT\.? [A-Z][A-Za-z]+(?: [A-Z][A-Za-z()]+){0,3})"),
    re.compile(r"\b(Setda [A-Z][a-z]+(?: [A-Z][a-z]+)?)"),
    re.compile(r"\b(Kejaksaan (?:Negeri|Tinggi) [A-Z][a-z]+)"),
]


def deteksi_instansi(judul):
    """Ekstrak nama instansi dari judul bila ada; None bila tidak terdeteksi."""
    for pattern in _INSTANSI_PATTERNS:
        m = pattern.search(judul)
        if m:
            nama = _pangkas_bukan_nama(m.group(1).strip())
            if nama:
                return nama
    return None


def _bersihkan_judul(judul, sumber_media):
    """
    Judul Google News berformat "Judul artikel - Nama Media", dan sebagian
    media (mis. jaringan disway.id) juga menulis domainnya di ekor judul
    artikelnya sendiri — jadi ekornya bisa berlapis. Buang ekor berulang
    selama ekornya sama dengan nama media atau berbentuk domain.
    """
    while " - " in judul:
        head, tail = judul.rsplit(" - ", 1)
        tail = tail.strip()
        is_domain = re.fullmatch(r"[A-Za-z0-9.\-]+\.[a-z]{2,}", tail)
        is_source = sumber_media and tail.lower() == sumber_media.lower()
        if is_domain or is_source:
            judul = head.strip()
        else:
            break
    return judul


def _google_news_rss_url(keyword):
    q = urllib.parse.quote(keyword)
    return (
        "https://news.google.com/rss/search?q=%s&hl=id&gl=ID&ceid=ID:id" % q
    )


def _fetch_url(url):
    """Ambil konten URL. Retry 1x setelah jeda 2 detik bila gagal pertama."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return resp.read()
    except (urllib.error.URLError, OSError):
        time.sleep(2)
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return resp.read()


def _parse_pubdate(raw):
    if not raw:
        return None
    try:
        return parsedate_to_datetime(raw).astimezone(timezone.utc).isoformat()
    except (TypeError, ValueError):
        return None


def _write_json_atomic(path, data):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def fetch_keyword(keyword):
    """Ambil dan parse satu feed Google News RSS. Melempar exception bila gagal."""
    xml_bytes = _fetch_url(_google_news_rss_url(keyword))
    root = ET.fromstring(xml_bytes)
    items = []
    for item in root.iter("item"):
        judul = (item.findtext("title") or "").strip()
        if not judul:
            continue
        sumber_media = None
        source_el = item.find("source")
        if source_el is not None and source_el.text:
            sumber_media = source_el.text.strip()
        judul = _bersihkan_judul(judul, sumber_media)
        items.append({
            "keyword": keyword,
            "judul": judul,
            "instansi_terdeteksi": deteksi_instansi(judul),
            "jenis_klien_tebakan": tebak_jenis_klien(judul),
            "link": (item.findtext("link") or "").strip(),
            "sumber": "google_news_rss" + (
                " (%s)" % sumber_media if sumber_media else ""
            ),
            "published": _parse_pubdate(item.findtext("pubDate")),
        })
    return items


def scrape_tenders():
    """Jalankan semua kata kunci. Kegagalan per kata kunci dicatat di errors."""
    all_items = []
    errors = []
    for keyword in KEYWORDS:
        try:
            all_items.extend(fetch_keyword(keyword))
        except (urllib.error.URLError, ET.ParseError, OSError, ValueError) as e:
            errors.append("keyword '%s': %s" % (keyword, e))

    # Dedup by judul (dinormalisasi)
    seen = set()
    deduped = []
    for it in all_items:
        key = re.sub(r"\s+", " ", it["judul"].lower()).strip()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(it)

    deduped.sort(key=lambda x: x["published"] or "", reverse=True)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sumber_catatan": (
            "Sinyal dari Google News RSS — bukan daftar tender resmi yang "
            "lengkap dan tidak real-time atas semua LPSE."
        ),
        "errors": errors,
        "items": deduped,
    }


# --- Prosesor export OCDS Opentender (unduhan manual) -----------------------

def _ocds_amount(node, *path):
    """Ambil nilai amount dari path bersarang; None bila tidak ada."""
    cur = node
    for p in path:
        if not isinstance(cur, dict) or p not in cur:
            return None
        cur = cur[p]
    if isinstance(cur, dict):
        cur = cur.get("amount")
    return cur if isinstance(cur, (int, float)) else None


def process_ocds_export(path):
    """
    Proses file export OCDS (release package) dari opentender.net yang
    diunduh manual (export bersifat per-LPSE per-tahun — endpoint TIDAK
    di-hardcode di sini, unduh sendiri dari situsnya).

    Menyaring paket yang judulnya mengandung kata kunci seragam dan
    mengembalikan intelijen harga: pagu, HPS, dan nilai penetapan pemenang.

    PENTING: data LKPP hanya mencatat sampai tahap penetapan pemenang,
    bukan realisasi kontrak — semua harga bersifat INDIKATIF.
    """
    with open(path, encoding="utf-8") as f:
        package = json.load(f)

    releases = package.get("releases", [])
    if not releases and isinstance(package, list):
        releases = package  # sebagian export berupa array release langsung

    records = []
    for rel in releases:
        tender = rel.get("tender", {}) or {}
        judul = (tender.get("title") or "").strip()
        if not judul:
            continue
        judul_lower = judul.lower()
        if not any(k in judul_lower for k in OCDS_TITLE_KEYWORDS):
            continue

        buyer = (rel.get("buyer") or {}).get("name")
        nilai_penetapan = None
        for award in rel.get("awards", []) or []:
            nilai_penetapan = _ocds_amount(award, "value")
            if nilai_penetapan is not None:
                break

        records.append({
            "ocid": rel.get("ocid"),
            "judul_paket": judul,
            "instansi": buyer,
            "tahun": (rel.get("date") or "")[:4] or None,
            "nilai_pagu": _ocds_amount(rel, "planning", "budget", "amount"),
            "nilai_hps": _ocds_amount(tender, "value"),
            "nilai_penetapan_pemenang": nilai_penetapan,
            "catatan": "Indikatif — LKPP mencatat sampai penetapan pemenang, "
                       "bukan realisasi kontrak.",
        })

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sumber": "opentender.net (OCDS, lisensi ODbL) — export manual: %s" % path,
        "errors": [],
        "records": records,
    }


# --- Sumber yang SENGAJA tidak diimplementasikan ----------------------------

def fetch_inaproc_isb():
    """
    STUB — JANGAN dipakai tanpa akses terverifikasi.

    API resmi INAPROC/ISB membutuhkan role "Data Integrator" yang TIDAK bisa
    diajukan oleh pelaku pengadaan LPSE biasa dan memerlukan surat resmi ke
    LKPP. Membangun fitur di atas endpoint ini tanpa akses hanya menghasilkan
    kode mati. Implementasikan hanya setelah akses resmi diperoleh.
    """
    raise NotImplementedError(
        "Akses API INAPROC/ISB butuh role Data Integrator via surat resmi ke "
        "LKPP. Belum tersedia — jangan dibangun di atas asumsi."
    )


def scrape_spse_instances():
    """
    STUB — sengaja tidak diimplementasikan.

    Scraping langsung ratusan instance SPSE rapuh: struktur HTML berbeda
    antar versi SPSE dan antar LPSE, mudah berubah, dan tidak ada jaminan
    stabilitas. Gunakan sinyal RSS + export OCDS Opentender saja.
    """
    raise NotImplementedError(
        "Scraping massal instance SPSE terlalu rapuh (struktur beda antar "
        "versi). Tidak dibangun by design."
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description="Radar Tender Seragam")
    parser.add_argument(
        "--ocds", metavar="FILE",
        help="Proses file export OCDS opentender.net (unduhan manual) dan "
             "tulis intelijen harga ke radar/data/harga_historis.json",
    )
    args = parser.parse_args(argv)

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if args.ocds:
        try:
            result = process_ocds_export(args.ocds)
        except (OSError, json.JSONDecodeError) as e:
            result = {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "sumber": "opentender.net (OCDS) — export manual: %s" % args.ocds,
                "errors": ["gagal memproses export OCDS: %s" % e],
                "records": [],
            }
        out = DATA_DIR / "harga_historis.json"
        _write_json_atomic(out, result)
        print("Tulis %s (%d paket seragam)" % (out, len(result["records"])))
        return 0

    result = scrape_tenders()
    _write_json_atomic(OUTPUT_FILE, result)
    print("Tulis %s (%d item, %d error)" % (
        OUTPUT_FILE, len(result["items"]), len(result["errors"])
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
