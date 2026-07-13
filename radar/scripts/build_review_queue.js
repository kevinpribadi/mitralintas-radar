#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.RADAR_DATA_DIR || path.join("radar", "data");
const REVIEW_OUTPUT = process.env.RADAR_REVIEW_OUTPUT ||
  path.join("radar", "docs", "data", "review_queue.json");
const MAX_ITEMS = readIntegerEnv("RADAR_REVIEW_MAX_ITEMS", 500);
const OLD_ITEM_DAYS = readIntegerEnv("RADAR_OLD_ITEM_DAYS", 1095);

const ISSUE_ORDER = [
  "MISSING_TITLE",
  "TITLE_TOO_SHORT",
  "MISSING_SOURCE",
  "MISSING_LINK",
  "MALFORMED_RSS_TITLE",
  "LONG_TITLE_WITHOUT_SPACES",
  "DUPLICATE_NORMALIZED_TITLE",
  "SUSPECTED_ORGANIZATION_EXTRACTION",
  "SUSPECTED_LOCATION_EXTRACTION",
  "OLD_ITEM",
  "INVALID_DATE",
  "INCOMPLETE_CORE_FIELDS",
];

const ISSUE_LABELS = {
  MISSING_TITLE: "Judul kosong",
  TITLE_TOO_SHORT: "Judul terlalu pendek",
  MISSING_SOURCE: "Sumber kosong",
  MISSING_LINK: "Link kosong",
  MALFORMED_RSS_TITLE: "Judul RSS perlu diperiksa",
  LONG_TITLE_WITHOUT_SPACES: "Judul panjang tanpa spasi",
  DUPLICATE_NORMALIZED_TITLE: "Judul terduplikasi setelah normalisasi",
  SUSPECTED_ORGANIZATION_EXTRACTION: "Ekstraksi organisasi perlu diperiksa",
  SUSPECTED_LOCATION_EXTRACTION: "Ekstraksi lokasi perlu diperiksa",
  OLD_ITEM: "Item lama",
  INVALID_DATE: "Tanggal tidak valid",
  INCOMPLETE_CORE_FIELDS: "Field inti tidak lengkap",
};

const MEDIUM_ISSUES = new Set([
  "TITLE_TOO_SHORT",
  "MALFORMED_RSS_TITLE",
  "LONG_TITLE_WITHOUT_SPACES",
  "DUPLICATE_NORMALIZED_TITLE",
  "SUSPECTED_ORGANIZATION_EXTRACTION",
  "SUSPECTED_LOCATION_EXTRACTION",
]);

const GENERIC_SHORT_TITLES = new Set([
  "berita",
  "news",
  "update",
  "artikel",
  "info",
  "informasi",
  "rss",
  "home",
  "homepage",
  "index",
  "null",
  "undefined",
  "event",
  "tender",
  "pengumuman",
]);

// Diambil konservatif dari daftar stopword ekstraksi yang sudah dipakai scraper.
const EXTRACTION_STOPWORDS = new Set([
  "akan",
  "bakal",
  "buka",
  "gelar",
  "gelaran",
  "hingga",
  "kembali",
  "minta",
  "pengadaan",
  "resmi",
  "seragam",
  "siap",
  "sukses",
  "tender",
  "usai",
]);

const MONTH_NAMES_ID = new Set([
  "januari",
  "februari",
  "maret",
  "april",
  "mei",
  "juni",
  "juli",
  "agustus",
  "september",
  "oktober",
  "november",
  "desember",
]);

const tenderData = readDataset(path.join(DATA_DIR, "tenders.json"), "tender");
const eventData = readDataset(path.join(DATA_DIR, "events.json"), "event");
const generatedAt = latestIsoDate([tenderData.generatedAt, eventData.generatedAt]) ||
  new Date().toISOString();
const referenceTime = Date.parse(generatedAt);

const candidates = [
  ...buildCandidates(tenderData.items, "tender", referenceTime),
  ...buildCandidates(eventData.items, "event", referenceTime),
];

const duplicateTitleKeys = findDuplicateTitleKeys(candidates);
candidates.forEach((candidate) => {
  if (candidate.duplicateKey && duplicateTitleKeys.has(candidate.duplicateKey)) {
    candidate.issueCodes.add("DUPLICATE_NORMALIZED_TITLE");
  }
});

const flagged = candidates
  .filter((candidate) => candidate.issueCodes.size > 0)
  .map(toReviewItem)
  .sort(compareReviewItems)
  .slice(0, MAX_ITEMS);

const output = {
  generated_at: generatedAt,
  source_summary: {
    tender_total: tenderData.items.length,
    event_total: eventData.items.length,
  },
  review_summary: buildReviewSummary(flagged),
  items: flagged,
};

writeJsonAtomic(REVIEW_OUTPUT, output);

console.log(
  `Tulis ${REVIEW_OUTPUT} (${flagged.length} item perlu review dari ` +
  `${tenderData.items.length} tender dan ${eventData.items.length} event)`
);

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

function buildCandidates(items, type, nowMs) {
  return items.map((item, index) => {
    const data = normalizeItem(item, type);
    const issueCodes = new Set();

    if (!hasText(data.title)) issueCodes.add("MISSING_TITLE");
    if (!hasText(data.source)) issueCodes.add("MISSING_SOURCE");
    if (!hasText(data.link)) issueCodes.add("MISSING_LINK");
    if (issueCodes.has("MISSING_TITLE") ||
        issueCodes.has("MISSING_SOURCE") ||
        issueCodes.has("MISSING_LINK")) {
      issueCodes.add("INCOMPLETE_CORE_FIELDS");
    }

    if (hasText(data.title) && titleTooShort(data.title)) {
      issueCodes.add("TITLE_TOO_SHORT");
    }
    if (hasText(data.title) && hasMalformedRssTitle(data.title, data.source)) {
      issueCodes.add("MALFORMED_RSS_TITLE");
    }
    if (hasText(data.title) && hasLongTitleWithoutSpaces(data.title)) {
      issueCodes.add("LONG_TITLE_WITHOUT_SPACES");
    }

    const invalidDate = dateValuesToCheck(item, type).some((value) => {
      return hasText(value) && !Number.isFinite(Date.parse(value));
    });
    if (invalidDate) issueCodes.add("INVALID_DATE");

    const itemTime = parsedPrimaryDate(item, type);
    if (Number.isFinite(itemTime) &&
        Number.isFinite(nowMs) &&
        nowMs - itemTime > OLD_ITEM_DAYS * 86400000) {
      issueCodes.add("OLD_ITEM");
    }

    if (suspectedOrganizationExtraction(data.organization, data.title)) {
      issueCodes.add("SUSPECTED_ORGANIZATION_EXTRACTION");
    }
    if (suspectedLocationExtraction(data.location, data.title)) {
      issueCodes.add("SUSPECTED_LOCATION_EXTRACTION");
    }

    const duplicateTitle = normalizeTitleForDuplicate(data.title, data.source);
    const duplicateKey = duplicateTitle.length >= 12 ? `${type}\u0000${duplicateTitle}` : "";

    return {
      index,
      type,
      ...data,
      issueCodes,
      duplicateKey,
      parsedTime: parsedPrimaryDate(item, type),
    };
  });
}

function normalizeItem(item, type) {
  const source = item && typeof item === "object"
    ? firstText(item.sumber, item.source)
    : "";

  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return {
      title: "",
      source,
      link: "",
      date: "",
      organization: "",
      location: "",
    };
  }

  return {
    title: type === "tender"
      ? firstText(item.judul, item.title, item.name)
      : firstText(item.nama_event, item.title, item.name),
    source,
    link: type === "tender"
      ? firstText(item.link, item.url)
      : firstText(item.link_resmi, item.link, item.url),
    date: type === "tender"
      ? firstText(item.published, item.date, item.tanggal)
      : firstText(item.tanggal, item.published, item.date),
    organization: type === "tender"
      ? firstText(item.instansi_terdeteksi, item.organization, item.instansi)
      : firstText(item.penyelenggara, item.organization, item.organizer),
    location: firstText(item.lokasi, item.location),
  };
}

function dateValuesToCheck(item, type) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  if (type === "tender") return [item.published, item.date, item.tanggal];
  return [item.tanggal, item.published, item.date];
}

function parsedPrimaryDate(item, type) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return NaN;
  const value = type === "tender"
    ? firstText(item.published, item.date, item.tanggal)
    : firstText(item.tanggal, item.published, item.date);
  if (!hasText(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : NaN;
}

function titleTooShort(title) {
  const normalized = normalizeLoose(title);
  if (!normalized) return false;
  const words = normalized.split(" ").filter(Boolean);
  if (GENERIC_SHORT_TITLES.has(normalized)) return true;
  if (words.length === 1 && normalized.length < 10) return true;
  if (words.length === 2 && normalized.length <= 8) return true;
  return false;
}

function hasMalformedRssTitle(title, source) {
  if (stripKnownRssSuffix(title, source) !== String(title).trim()) return true;
  return /\s-\shttps?:\/\/\S+\s*$/i.test(title) ||
    /\s-\s[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*$/i.test(title);
}

function hasLongTitleWithoutSpaces(title) {
  const trimmed = String(title).trim();
  if (trimmed.length > 80 && !/\s/.test(trimmed)) return true;
  return trimmed.split(/\s+/).some((token) => token.length > 90);
}

function suspectedOrganizationExtraction(organization, title) {
  if (!hasText(organization)) return false;
  const normalizedOrganization = normalizeLoose(organization);
  const normalizedTitle = normalizeLoose(title);
  const words = normalizedOrganization.split(" ").filter(Boolean);

  if (normalizedTitle && !normalizedTitle.includes(normalizedOrganization)) return true;
  if (words.length > 8) return true;
  if (/\b(?:https?|www|google news rss|rss)\b/i.test(organization)) return true;
  if (/\b(?:pengadaan|seragam|tender|fun run|jalan sehat|lomba|hut|ulang tahun)\b/i.test(organization)) {
    return true;
  }
  for (let i = 1; i < words.length; i += 1) {
    if (EXTRACTION_STOPWORDS.has(words[i])) return true;
  }
  return false;
}

function suspectedLocationExtraction(location, title) {
  if (!hasText(location)) return false;
  const normalizedLocation = normalizeLoose(location);
  const normalizedTitle = normalizeLoose(title);
  const words = normalizedLocation.split(" ").filter(Boolean);

  if (normalizedTitle && !normalizedTitle.includes(normalizedLocation)) return true;
  if (words.length > 4) return true;
  if (/\d/.test(location)) return true;
  if (words.some((word) => MONTH_NAMES_ID.has(word))) return true;
  if (/\b(?:https?|www|rss)\b/i.test(location)) return true;
  return false;
}

function findDuplicateTitleKeys(candidates) {
  const counts = new Map();
  candidates.forEach((candidate) => {
    if (!candidate.duplicateKey) return;
    counts.set(candidate.duplicateKey, (counts.get(candidate.duplicateKey) || 0) + 1);
  });
  return new Set(
    Array.from(counts.entries())
      .filter((entry) => entry[1] > 1)
      .map((entry) => entry[0])
  );
}

function toReviewItem(candidate) {
  const issueCodes = ISSUE_ORDER.filter((code) => candidate.issueCodes.has(code));
  const severity = severityFor(issueCodes);
  return {
    id: stableReviewId(candidate),
    type: candidate.type,
    title: candidate.title,
    source: candidate.source,
    link: candidate.link,
    date: candidate.date,
    organization: candidate.organization,
    location: candidate.location,
    issue_codes: issueCodes,
    issue_labels: issueCodes.map((code) => ISSUE_LABELS[code]),
    severity,
    suggested_action: "review_manual",
    _sort_time: Number.isFinite(candidate.parsedTime) ? candidate.parsedTime : null,
  };
}

function severityFor(issueCodes) {
  const hasTitleMissing = issueCodes.includes("MISSING_TITLE");
  const hasLinkAndSourceMissing = issueCodes.includes("MISSING_LINK") &&
    issueCodes.includes("MISSING_SOURCE");
  if (hasTitleMissing || hasLinkAndSourceMissing) return "high";
  if (issueCodes.some((code) => MEDIUM_ISSUES.has(code))) return "medium";
  return "low";
}

function stableReviewId(candidate) {
  const raw = [
    candidate.type,
    normalizeForId(candidate.title),
    normalizeForId(candidate.source),
    normalizeForId(candidate.link),
  ].join("\n");
  return "rq_" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

function compareReviewItems(a, b) {
  const severityRank = { high: 0, medium: 1, low: 2 };
  if (severityRank[a.severity] !== severityRank[b.severity]) {
    return severityRank[a.severity] - severityRank[b.severity];
  }
  if (a._sort_time != null && b._sort_time != null && a._sort_time !== b._sort_time) {
    return b._sort_time - a._sort_time;
  }
  if (a._sort_time != null && b._sort_time == null) return -1;
  if (a._sort_time == null && b._sort_time != null) return 1;
  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

function buildReviewSummary(items) {
  const summary = {
    total_flagged: items.length,
    high: 0,
    medium: 0,
    low: 0,
    issue_counts: {},
  };

  items.forEach((item) => {
    summary[item.severity] += 1;
    item.issue_codes.forEach((code) => {
      summary.issue_counts[code] = (summary.issue_counts[code] || 0) + 1;
    });
    delete item._sort_time;
  });

  summary.issue_counts = Object.fromEntries(
    Object.entries(summary.issue_counts).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return ISSUE_ORDER.indexOf(a[0]) - ISSUE_ORDER.indexOf(b[0]);
    })
  );
  return summary;
}

function stripKnownRssSuffix(title, source) {
  let cleaned = String(title == null ? "" : title).trim();
  const sourceMedia = sourceMediaName(source);

  while (cleaned.includes(" - ")) {
    const idx = cleaned.lastIndexOf(" - ");
    const head = cleaned.slice(0, idx).trim();
    const tail = cleaned.slice(idx + 3).trim();
    const isDomain = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(tail);
    const isUrl = /^https?:\/\/\S+$/i.test(tail);
    const isSource = sourceMedia && tail.toLowerCase() === sourceMedia.toLowerCase();
    if (!head || (!isDomain && !isUrl && !isSource)) break;
    cleaned = head;
  }

  return cleaned;
}

function sourceMediaName(source) {
  if (!hasText(source)) return "";
  const match = String(source).match(/\(([^)]+)\)\s*$/);
  return match ? match[1].trim() : "";
}

function normalizeTitleForDuplicate(title, source) {
  return normalizeLoose(stripKnownRssSuffix(title, source))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForId(value) {
  return normalizeLoose(value);
}

function normalizeLoose(value) {
  return String(value == null ? "" : value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function firstText() {
  for (let i = 0; i < arguments.length; i += 1) {
    const value = arguments[i];
    if (hasText(value)) return String(value).trim();
  }
  return "";
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function latestIsoDate(values) {
  let latest = null;
  values.forEach((value) => {
    if (!hasText(value)) return;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return;
    if (!latest || time > latest.time) latest = { time };
  });
  return latest ? new Date(latest.time).toISOString() : null;
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function readIntegerEnv(name, fallback) {
  if (process.env[name] == null || process.env[name] === "") return fallback;
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} harus integer >= 1, diterima: ${process.env[name]}`);
  }
  return value;
}
