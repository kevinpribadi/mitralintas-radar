#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Radar 2 — Event.

Memantau event (lomba lari, fun run, gathering, family day, HUT instansi)
yang berpotensi butuh jersey/kaos/seragam panitia.

Sumber utama: Google News RSS (hl=id, gl=ID). Kalender lari publik
(schedules.run / kalenderlari / ruanglari) TIDAK di-scrape by default karena
struktur HTML-nya tidak stabil dan tidak terdokumentasi — bila suatu saat
mau dicoba, gunakan kerangka fetch_kalender_lari() di bawah dan verifikasi
strukturnya dulu secara manual.

Kebijakan kontak (UU PDP 27/2022): HANYA kontak resmi penyelenggara yang
dipublikasikan untuk kerjasama yang boleh disimpan. Item dari RSS tidak
membawa kontak — field kontak_resmi diisi None dan dilengkapi manual oleh
manusia setelah membuka link resminya. JANGAN pernah menambahkan scraping
kontak personal.

Output: radar/data/events.json
Jalankan: python radar/scrapers/event.py

Hanya memakai pustaka standar Python (tanpa pip install).
"""

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
OUTPUT_FILE = DATA_DIR / "events.json"

REQUEST_TIMEOUT = 20
USER_AGENT = "Mozilla/5.0 (compatible; RadarSeragam/1.0; +https://github.com)"

_TAHUN = datetime.now().year  # dipakai di keyword; otomatis diperbarui setiap tahun

KEYWORDS = [
    f"fun run {_TAHUN}",
    f"lomba lari {_TAHUN} pendaftaran",
    "family gathering perusahaan",
    "family day perusahaan",
    "HUT BUMN fun run",
    "jalan sehat HUT",
    "gathering karyawan",
    "jersey fun run",
]

_KATEGORI_RULES = [
    ("lari", ["fun run", "marathon", "half marathon", "10k", "5k", "lari",
              "jalan sehat", "trail run", "night run", "color run"]),
    ("gathering", ["gathering", "family day", "outing", "capacity building"]),
    ("hut", ["hut ", "ulang tahun", "anniversary", "dies natalis", "harlah"]),
]

_SEGMEN_RULES = [
    ("sekolah", ["sekolah", "kampus", "universitas", "mahasiswa", "siswa",
                 "dies natalis"]),
    ("pemerintah_bumn", ["bumn", "pemkab", "pemkot", "pemprov", "pemda",
                         "dinas", "kementerian", "pln", "pertamina",
                         "telkom", "bank indonesia", "pemerintah", "polres",
                         "polda", "tni", "kodim", "hut ri", "hut kota",
                         "hut kabupaten"]),
    ("korporat", ["perusahaan", "karyawan", "kantor", "pt ", "corporate",
                  "bank ", "hotel"]),
    ("komunitas", ["komunitas", "community", "runner", "pelari"]),
]

_BULAN_ID = {
    "januari": 1, "februari": 2, "maret": 3, "april": 4, "mei": 5,
    "juni": 6, "juli": 7, "agustus": 8, "september": 9, "oktober": 10,
    "november": 11, "desember": 12,
}

# Kota-kota besar untuk deteksi lokasi dari judul. Hanya menampilkan yang
# benar-benar muncul di teks — bukan menebak lokasi yang tidak disebut.
_KOTA = [
    "Jakarta", "Surabaya", "Bandung", "Medan", "Semarang", "Makassar",
    "Palembang", "Tangerang", "Depok", "Bekasi", "Bogor", "Yogyakarta",
    "Jogja", "Solo", "Surakarta", "Malang", "Denpasar", "Bali",
    "Balikpapan", "Banjarmasin", "Pontianak", "Manado", "Padang",
    "Pekanbaru", "Batam", "Lampung", "Cirebon", "Purwokerto", "Magelang",
    "Salatiga", "Kediri", "Jember", "Banyuwangi", "Mandalika", "Lombok",
    "Labuan Bajo", "Bromo", "Borobudur",
]


def deteksi_kategori(judul):
    teks = judul.lower()
    for kategori, kata_list in _KATEGORI_RULES:
        if any(k in teks for k in kata_list):
            return kategori
    return "lainnya"


def deteksi_segmen(judul):
    teks = " %s " % judul.lower()
    for segmen, kata_list in _SEGMEN_RULES:
        if any(k in teks for k in kata_list):
            return segmen
    return "tidak_diketahui"


def deteksi_lokasi(judul):
    for kota in _KOTA:
        if re.search(r"\b%s\b" % re.escape(kota), judul, re.IGNORECASE):
            return kota
    return None


def deteksi_tanggal(judul):
    """Cari tanggal gaya '12 Juli 2026' di judul; None bila tidak ada."""
    m = re.search(
        r"\b(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\s+(%s)\s+(\d{4})\b"
        % "|".join(_BULAN_ID),
        judul, re.IGNORECASE,
    )
    if not m:
        return None
    try:
        hari = int(m.group(1))
        bulan = _BULAN_ID[m.group(2).lower()]
        tahun = int(m.group(3))
        return "%04d-%02d-%02d" % (tahun, bulan, hari)
    except (ValueError, KeyError):
        return None


# Judul berita Title Case membuat kata kerja berkapital ikut tertangkap
# regex nama. Pangkas kata buntut yang jelas bukan nama.
_BUKAN_NAMA = {
    "gelar", "gelaran", "sukses", "ajak", "adakan", "hadirkan", "kembali",
    "siap", "resmi", "buka", "umumkan", "rilis", "dukung", "sponsori",
    "ramaikan", "meriahkan", "hingga", "usai", "bakal", "akan", "segera",
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


def deteksi_penyelenggara(judul):
    """Ekstrak nama penyelenggara bila tersurat di judul; None bila tidak."""
    patterns = [
        re.compile(r"\b(PT\.? [A-Z][A-Za-z]+(?: [A-Z][A-Za-z()]+){0,3})"),
        re.compile(r"\b(Pem(?:kab|kot|prov) [A-Z][a-z]+(?: [A-Z][a-z]+)?)"),
        re.compile(r"\b(Bank [A-Z][A-Za-z]+(?: [A-Z][a-z]+)?)"),
        re.compile(r"\b(Komunitas [A-Z][A-Za-z]+(?: [A-Z][a-z]+){0,2})"),
        re.compile(r"\b(Universitas [A-Z][a-z]+(?: [A-Z][a-z]+)?)"),
    ]
    for p in patterns:
        m = p.search(judul)
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
    return "https://news.google.com/rss/search?q=%s&hl=id&gl=ID&ceid=ID:id" % q


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
        # Guard: judul tanpa spasi (artefak encoding media tertentu) yang sangat
        # panjang tidak terbaca dan merusak draft outreach — truncate saja.
        if len(judul) > 80 and " " not in judul:
            judul = judul[:80] + "[...]"
        items.append({
            "nama_event": judul,
            "tanggal": deteksi_tanggal(judul),
            "lokasi": deteksi_lokasi(judul),
            "kategori": deteksi_kategori(judul),
            "penyelenggara": deteksi_penyelenggara(judul),
            # Kontak resmi TIDAK tersedia dari RSS — dilengkapi manual dari
            # kanal kerjasama resmi penyelenggara. Jangan scrape kontak
            # personal (UU PDP 27/2022).
            "kontak_resmi": None,
            # Untuk item RSS, link menuju artikel berita (bukan situs resmi
            # event). Situs resmi dicek manual dari artikelnya.
            "link_resmi": (item.findtext("link") or "").strip(),
            "sumber": "google_news_rss" + (
                " (%s)" % sumber_media if sumber_media else ""
            ),
            "segmen": deteksi_segmen(judul),
            "keyword": keyword,
            "published": _parse_pubdate(item.findtext("pubDate")),
        })
    return items


def fetch_kalender_lari(url):
    """
    KERANGKA (belum diaktifkan) untuk kalender lari publik seperti
    schedules.run / kalenderlari / ruanglari.

    Struktur HTML situs-situs ini tidak terdokumentasi dan bisa berubah
    sewaktu-waktu, sehingga TIDAK dipakai di jadwal harian. Bila ingin
    mengaktifkan: (1) periksa manual struktur HTML terbaru situsnya,
    (2) tulis parser spesifik di sini, (3) pastikan tetap jatuh ke RSS
    bila parsing gagal. Ambil HANYA data event dan kontak kerjasama resmi
    yang dipublikasikan.
    """
    raise NotImplementedError(
        "Parser kalender lari belum diverifikasi terhadap struktur HTML "
        "terbaru situsnya. Andalkan RSS; lihat docstring untuk cara "
        "mengaktifkan."
    )


def scrape_events():
    all_items = []
    errors = []
    for keyword in KEYWORDS:
        try:
            all_items.extend(fetch_keyword(keyword))
        except (urllib.error.URLError, ET.ParseError, OSError, ValueError) as e:
            errors.append("keyword '%s': %s" % (keyword, e))

    # Dedup by nama_event (dinormalisasi)
    seen = set()
    deduped = []
    for it in all_items:
        key = re.sub(r"\s+", " ", it["nama_event"].lower()).strip()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(it)

    deduped.sort(key=lambda x: x["published"] or "", reverse=True)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sumber_catatan": (
            "Sinyal dari Google News RSS — bukan kalender event yang lengkap. "
            "Kontak diisi manual dari kanal kerjasama resmi penyelenggara."
        ),
        "errors": errors,
        "items": deduped,
    }


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    result = scrape_events()
    _write_json_atomic(OUTPUT_FILE, result)
    print("Tulis %s (%d item, %d error)" % (
        OUTPUT_FILE, len(result["items"]), len(result["errors"])
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
