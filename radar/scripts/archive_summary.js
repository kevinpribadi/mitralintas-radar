#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.RADAR_DATA_DIR || path.join("radar", "data");
const ARCHIVE_DIR = process.env.RADAR_ARCHIVE_DIR || path.join("radar", "archive", "monthly");
const LAST_KNOWN_GOOD_FILE = process.env.RADAR_LKG_FILE ||
  path.join("radar", "archive", "last-known-good.json");
const TOP_LIMIT = readNumberEnv("RADAR_ARCHIVE_TOP_LIMIT", 20);

const tenderPath = path.join(DATA_DIR, "tenders.json");
const eventPath = path.join(DATA_DIR, "events.json");
const tenderData = readDataset(tenderPath, "tender");
const eventData = readDataset(eventPath, "event");
const generatedAt = new Date().toISOString();
const period = process.env.RADAR_ARCHIVE_PERIOD ||
  periodFromDate(tenderData.generatedAt || eventData.generatedAt || generatedAt);
const archivePath = path.join(ARCHIVE_DIR, `${period}.json`);

const archive = {
  period,
  generated_at: generatedAt,
  data_generated_at: {
    tenders: tenderData.generatedAt,
    events: eventData.generatedAt,
  },
  tender_count: tenderData.items.length,
  event_count: eventData.items.length,
  tender_source_counts: countBy(tenderData.items, (item) => item.sumber || item.source),
  event_source_counts: countBy(eventData.items, (item) => item.sumber || item.source),
  tender_keyword_counts: countBy(tenderData.items, (item) => item.keyword),
  event_keyword_counts: countBy(eventData.items, (item) => item.keyword),
  event_category_counts: countBy(eventData.items, (item) => item.kategori || item.category),
  top_tender_titles: topTitles(tenderData.items, (item) => item.judul || item.title || item.name),
  top_event_titles: topTitles(eventData.items, (item) => item.nama_event || item.title || item.name),
  data_quality: {
    tenders: qualitySummary(tenderData.items, "tender"),
    events: qualitySummary(eventData.items, "event"),
  },
};

const lastKnownGood = {
  generated_at: generatedAt,
  period,
  archive_file: toPosixPath(archivePath),
  tender_count: archive.tender_count,
  event_count: archive.event_count,
  data_generated_at: archive.data_generated_at,
  input_files: {
    tenders: toPosixPath(tenderPath),
    events: toPosixPath(eventPath),
  },
  input_hashes_sha256: {
    tenders: sha256File(tenderPath),
    events: sha256File(eventPath),
  },
  note: "Snapshot metadata dibuat setelah guard data lulus; tidak berisi raw item penuh.",
};

fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
fs.mkdirSync(path.dirname(LAST_KNOWN_GOOD_FILE), { recursive: true });
writeJsonAtomic(archivePath, archive);
writeJsonAtomic(LAST_KNOWN_GOOD_FILE, lastKnownGood);

console.log(`Tulis ${archivePath} (${archive.tender_count} tender, ${archive.event_count} event)`);
console.log(`Tulis ${LAST_KNOWN_GOOD_FILE}`);

function readDataset(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`${label}: gagal membaca ${filePath}: ${err.message}`);
  }

  if (Array.isArray(parsed)) {
    return { generatedAt: null, items: parsed };
  }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) {
    return { generatedAt: parsed.generated_at || null, items: parsed.items };
  }
  throw new Error(`${label}: ${filePath} harus array item atau object dengan items array`);
}

function countBy(items, getter) {
  const counts = {};
  items.forEach((item) => {
    const raw = getter(item);
    if (raw == null || String(raw).trim() === "") return;
    const key = String(raw).trim();
    counts[key] = (counts[key] || 0) + 1;
  });
  return sortObjectByCount(counts);
}

function topTitles(items, getter) {
  const titles = [];
  const seen = new Set();
  items.forEach((item) => {
    if (titles.length >= TOP_LIMIT) return;
    const raw = getter(item);
    if (raw == null || String(raw).trim() === "") return;
    const title = String(raw).trim();
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    titles.push(title);
  });
  return titles;
}

function qualitySummary(items, kind) {
  const summary = {
    valid_items: 0,
    problematic_items: 0,
    missing_title: 0,
    missing_source: 0,
    missing_link: 0,
    non_object_items: 0,
  };

  items.forEach((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      summary.problematic_items += 1;
      summary.non_object_items += 1;
      return;
    }

    const hasTitle = kind === "tender"
      ? hasText(item.judul) || hasText(item.title) || hasText(item.name)
      : hasText(item.nama_event) || hasText(item.title) || hasText(item.name);
    const hasSource = hasText(item.sumber) || hasText(item.source);
    const hasLink = kind === "tender"
      ? hasText(item.link) || hasText(item.url)
      : hasText(item.link_resmi) || hasText(item.link) || hasText(item.url);

    if (!hasTitle) summary.missing_title += 1;
    if (!hasSource) summary.missing_source += 1;
    if (!hasLink) summary.missing_link += 1;

    if (hasTitle && hasSource && hasLink) {
      summary.valid_items += 1;
    } else {
      summary.problematic_items += 1;
    }
  });

  return summary;
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function sortObjectByCount(counts) {
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
  );
}

function periodFromDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`RADAR_ARCHIVE_PERIOD tidak diset dan tanggal tidak valid: ${value}`);
  }
  return date.toISOString().slice(0, 7);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function readNumberEnv(name, fallback) {
  if (process.env[name] == null || process.env[name] === "") return fallback;
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} harus integer >= 1, diterima: ${process.env[name]}`);
  }
  return value;
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join("/");
}
