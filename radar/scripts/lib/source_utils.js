"use strict";

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const tls = require("tls");

const SOURCE_TYPES = new Set(["official_press_release", "official_news"]);
const SOURCE_STATUSES = new Set([
  "HEALTHY", "DEGRADED", "UNAVAILABLE", "BLOCKED",
  "UNSUPPORTED_DYNAMIC_PAGE", "INVALID_CONFIGURATION",
]);
const CLASSIFICATION_HINTS = new Set([
  "FACILITY_OPENING_CANDIDATE",
  "BUSINESS_EXPANSION_CANDIDATE",
  "MASS_RECRUITMENT_CANDIDATE",
  "OTHER_OFFICIAL_NEWS",
]);

const HINT_TERMS = [
  {
    code: "FACILITY_OPENING_CANDIDATE",
    terms: [
      "pabrik baru", "fasilitas baru", "mulai beroperasi", "resmi beroperasi",
      "mulai produksi", "pembangunan pabrik", "konstruksi pabrik", "pembukaan pabrik",
      "grand opening", "cabang baru", "gerai baru",
    ],
  },
  {
    code: "BUSINESS_EXPANSION_CANDIDATE",
    terms: [
      "ekspansi pabrik", "ekspansi industri", "perluasan fasilitas",
      "penambahan kapasitas", "peningkatan kapasitas produksi", "tambah kapasitas produksi",
      "menambah kapasitas produksi", "perluasan industri", "investasi fasilitas",
    ],
  },
  {
    code: "MASS_RECRUITMENT_CANDIDATE",
    terms: [
      "rekrutmen massal", "membuka lowongan", "penerimaan karyawan", "penerimaan pegawai",
      "penambahan karyawan", "open recruitment", "hiring", "membutuhkan pekerja",
    ],
  },
];

class SourceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SourceError";
    this.code = code;
    Object.assign(this, details);
  }
}

function readJson(filePath, label = "JSON") {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label}: gagal membaca ${filePath}: ${error.message}`);
  }
}

function validateRegistry(registry) {
  const errors = [];
  if (!isObject(registry)) return fail(["Registry harus berupa object."]);
  if (registry.schema_version !== "1.0.0") errors.push("schema_version registry harus 1.0.0.");
  if (!hasText(registry.user_agent)) errors.push("user_agent wajib diisi.");
  ["request_timeout_ms", "request_interval_ms", "max_items_per_source",
    "max_detail_requests_per_source"].forEach((key) => {
    if (!Number.isInteger(registry[key]) || registry[key] < 0) errors.push(`${key} tidak valid.`);
  });
  if (!Array.isArray(registry.sources) || !registry.sources.length || registry.sources.length > 2) {
    errors.push("sources wajib berisi satu sampai dua sumber.");
  }
  const codes = new Set();
  (registry.sources || []).forEach((source, index) => {
    const prefix = `sources[${index}]`;
    if (!isObject(source)) return errors.push(`${prefix} harus object.`);
    ["code", "name", "official_domain", "listing_url", "fixture_prefix"]
      .forEach((key) => { if (!hasText(source[key])) errors.push(`${prefix}.${key} wajib diisi.`); });
    if (codes.has(source.code)) errors.push(`source code duplikat: ${source.code}`);
    codes.add(source.code);
    if (!/^[A-Z0-9_]+$/.test(source.code || "")) errors.push(`${prefix}.code tidak valid.`);
    if (!SOURCE_TYPES.has(source.source_type)) errors.push(`${prefix}.source_type tidak valid.`);
    if (typeof source.enabled_for_pilot !== "boolean") errors.push(`${prefix}.enabled_for_pilot wajib boolean.`);
    if (!Array.isArray(source.allowed_path_prefixes) || !source.allowed_path_prefixes.length ||
        source.allowed_path_prefixes.some((value) => !hasText(value) || !value.startsWith("/"))) {
      errors.push(`${prefix}.allowed_path_prefixes tidak valid.`);
    }
    if (!Array.isArray(source.target_signal_types) ||
        source.target_signal_types.some((value) => !CLASSIFICATION_HINTS.has(value))) {
      errors.push(`${prefix}.target_signal_types tidak valid.`);
    }
    if (!isObject(source.parser) || !isObject(source.parser.selectors) ||
        !hasText(source.parser.listing_strategy) || !hasText(source.parser.detail_strategy)) {
      errors.push(`${prefix}.parser tidak valid.`);
    }
    try {
      const listing = new URL(source.listing_url);
      if (listing.protocol !== "https:" || listing.hostname !== source.official_domain) {
        errors.push(`${prefix}.listing_url harus HTTPS pada exact official_domain.`);
      }
      if (!isAllowedUrl(source.listing_url, source)) errors.push(`${prefix}.listing_url di luar allowlist path.`);
    } catch (_) {
      errors.push(`${prefix}.listing_url bukan URL valid.`);
    }
  });
  if (errors.length) fail(errors);
  return true;
}

function fail(errors) {
  throw new Error(errors.join(" "));
}

function isAllowedUrl(value, source) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === source.official_domain &&
      source.allowed_path_prefixes.some((prefix) => url.pathname.startsWith(prefix));
  } catch (_) {
    return false;
  }
}

function isAllowedRequestUrl(value, source) {
  try {
    const url = new URL(value);
    return isAllowedUrl(value, source) ||
      (url.protocol === "https:" && url.hostname === source.official_domain &&
        url.pathname === "/robots.txt");
  } catch (_) {
    return false;
  }
}

function normalizeUrl(value, baseUrl) {
  const url = new URL(value, baseUrl);
  url.hash = "";
  return url.toString();
}

function parseRobots(text, pathname, userAgent = "MitraLintasRadar") {
  const groups = [];
  let current = null;
  String(text || "").split(/\r?\n/).forEach((line) => {
    const clean = line.replace(/#.*$/, "").trim();
    if (!clean) return;
    const separator = clean.indexOf(":");
    if (separator < 0) return;
    const key = clean.slice(0, separator).trim().toLowerCase();
    const value = clean.slice(separator + 1).trim();
    if (key === "user-agent") {
      current = { agents: [value.toLowerCase()], disallow: [], allow: [] };
      groups.push(current);
    } else if (current && key === "disallow" && value) current.disallow.push(value);
    else if (current && key === "allow" && value) current.allow.push(value);
  });
  const agent = userAgent.toLowerCase();
  const relevant = groups.filter((group) =>
    group.agents.some((value) => value === "*" || agent.includes(value)));
  const matchedAllow = relevant.flatMap((group) => group.allow)
    .filter((rule) => pathname.startsWith(rule)).sort((a, b) => b.length - a.length)[0] || "";
  const matchedDisallow = relevant.flatMap((group) => group.disallow)
    .filter((rule) => pathname.startsWith(rule)).sort((a, b) => b.length - a.length)[0] || "";
  return !matchedDisallow || matchedAllow.length >= matchedDisallow.length;
}

function detectLoginPage(html) {
  const text = String(html || "");
  return /<input\b[^>]*type\s*=\s*["']password["']/i.test(text) ||
    /<form\b[^>]*(?:login|signin|masuk)/i.test(text);
}

function parseListing(html, source) {
  const records = [];
  let externalLinks = 0;
  const detailPrefix = source.parser.selectors.detail_path_prefix;
  const titleTag = escapeRegex(source.parser.selectors.listing_title_tag || "h3");
  const anchorPattern = /<a\b([^>]*)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(String(html || "")))) {
    let link;
    try { link = normalizeUrl(match[2], source.listing_url); } catch (_) { continue; }
    const parsed = new URL(link);
    if (parsed.hostname !== source.official_domain || parsed.protocol !== "https:") {
      externalLinks += 1;
      continue;
    }
    if (!isAllowedUrl(link, source) || !parsed.pathname.startsWith(detailPrefix) ||
        parsed.pathname === new URL(source.listing_url).pathname) continue;
    const inner = match[4];
    const titleMatch = inner.match(new RegExp(`<${titleTag}\\b[^>]*>([\\s\\S]*?)<\\/${titleTag}>`, "i"));
    const dateMatch = inner.match(/<[^>]*class\s*=\s*["'][^"']*\bdate\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
    const title = cleanText(titleMatch ? titleMatch[1] : inner)
      .replace(/^\d{1,2}\s+[A-Za-z]+\s+20\d{2}\s+/, "").replace(/\s+Unduh$/i, "").trim();
    const publishedText = cleanText(dateMatch ? dateMatch[1] : "");
    records.push({ title, link, publishedText, listingEvidence: cleanText(inner).slice(0, 500) });
  }
  return { records: stableUnique(records, (item) => item.link), externalLinks };
}

function parseDetail(html, source, requestedUrl) {
  const sourceHtml = String(html || "");
  const titleTag = escapeRegex(source.parser.selectors.detail_title_tag || "h1");
  const titleMatch = sourceHtml.match(new RegExp(`<${titleTag}\\b[^>]*>([\\s\\S]*?)<\\/${titleTag}>`, "i"));
  const titleDocument = sourceHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const canonical = findLinkRel(sourceHtml, source.parser.selectors.canonical_rel || "canonical") || requestedUrl;
  const excerpt = findMetaContent(sourceHtml, source.parser.selectors.detail_excerpt_meta || "description");
  let title = cleanText(titleMatch ? titleMatch[1] : (titleDocument ? titleDocument[1] : ""));
  if (!titleMatch && title.includes(" - ")) title = title.split(" - ").slice(1).join(" - ").trim();
  return {
    title,
    canonicalUrl: normalizeUrl(canonical, requestedUrl),
    excerpt: cleanText(excerpt).slice(0, 500),
    organizationHint: "",
  };
}

function findMetaContent(html, key) {
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name = getAttribute(tag, "name") || getAttribute(tag, "property");
    if (String(name).toLowerCase() === String(key).toLowerCase()) return getAttribute(tag, "content") || "";
  }
  return "";
}

function findLinkRel(html, rel) {
  for (const match of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (String(getAttribute(tag, "rel")).toLowerCase() === String(rel).toLowerCase()) {
      return getAttribute(tag, "href") || "";
    }
  }
  return "";
}

function getAttribute(tag, name) {
  const pattern = new RegExp(`\\b${escapeRegex(name)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i");
  const match = String(tag).match(pattern);
  return match ? decodeEntities(match[2]) : "";
}

function parsePublicDate(value) {
  const text = cleanText(value);
  if (!text) return { value: "", status: "missing" };
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso && isValidDateParts(+iso[1], +iso[2], +iso[3])) return { value: iso[0], status: "valid" };
  const months = {
    januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6,
    juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
  };
  const local = text.toLowerCase().match(/\b(\d{1,2})\s+([a-z]+)\s+(20\d{2})\b/);
  if (local && months[local[2]] && isValidDateParts(+local[3], months[local[2]], +local[1])) {
    return { value: `${local[3]}-${pad(months[local[2]])}-${pad(+local[1])}`, status: "valid" };
  }
  return { value: "", status: "invalid" };
}

function normalizeItem(listing, detail, source) {
  const canonicalUrl = normalizeUrl(detail.canonicalUrl || listing.link, listing.link);
  const title = cleanText(detail.title || listing.title);
  const excerpt = cleanText(detail.excerpt).slice(0, 500);
  const date = parsePublicDate(listing.publishedText);
  const hint = classifyHint(title, excerpt);
  const item = {
    id: stableItemId(source.code, canonicalUrl, title),
    source_code: source.code,
    source_name: source.name,
    source_type: source.source_type,
    title,
    link: canonicalUrl,
    published_at: date.value,
    organization_hint: cleanText(detail.organizationHint),
    excerpt,
    provenance: {
      listing_url: source.listing_url,
      detail_url: listing.link,
      official_domain: source.official_domain,
      retrieval_method: "static_html",
    },
    quality: {
      title_valid: title.length >= 8,
      link_valid: isAllowedUrl(canonicalUrl, source),
      date_status: date.status,
      organization_status: hasText(detail.organizationHint) ? "explicit" : "unknown",
      excerpt_status: excerpt ? "available" : "missing",
    },
    classification_hint: hint,
    content_hash: sha256([normalizeText(title), normalizeText(excerpt), date.value].join("\n")),
  };
  return item;
}

function classifyHint(title, excerpt) {
  const fields = [String(title || ""), String(excerpt || "")];
  const normalized = fields.map(normalizeText);
  for (const definition of HINT_TERMS) {
    const matchedTerms = definition.terms.filter((term) =>
      normalized.some((value) => containsTerm(value, term)));
    if (matchedTerms.length) {
      const evidence = fields.find((value) => containsTerm(normalizeText(value), matchedTerms[0])) || fields[0];
      return {
        code: definition.code,
        matched_terms: matchedTerms,
        evidence_excerpt: cleanText(evidence).slice(0, 500),
        human_review_required: true,
      };
    }
  }
  return {
    code: "OTHER_OFFICIAL_NEWS",
    matched_terms: [],
    evidence_excerpt: cleanText(excerpt || title).slice(0, 500),
    human_review_required: true,
  };
}

function deduplicateItems(items) {
  const seenUrls = new Set();
  const seenHashes = new Set();
  const seenTitles = new Set();
  const reasonCounts = { canonical_url: 0, content_hash: 0, normalized_title_source: 0 };
  const unique = [];
  for (const item of items) {
    const titleKey = `${item.source_code}\n${normalizeText(item.title)}`;
    let reason = "";
    if (seenUrls.has(item.link)) reason = "canonical_url";
    else if (seenHashes.has(item.content_hash)) reason = "content_hash";
    else if (seenTitles.has(titleKey)) reason = "normalized_title_source";
    if (reason) {
      reasonCounts[reason] += 1;
      continue;
    }
    seenUrls.add(item.link);
    seenHashes.add(item.content_hash);
    seenTitles.add(titleKey);
    unique.push(item);
  }
  return { items: unique.sort(compareItems), duplicateCount: items.length - unique.length, reasonCounts };
}

function validateNormalizedItem(item, source) {
  const errors = [];
  if (!hasText(item.title) || !item.quality.title_valid) errors.push("TITLE_INVALID");
  if (!item.quality.link_valid || !isAllowedUrl(item.link, source)) errors.push("LINK_INVALID");
  if (!isObject(item.provenance) || item.provenance.official_domain !== source.official_domain ||
      item.provenance.retrieval_method !== "static_html") errors.push("PROVENANCE_INVALID");
  if (item.quality.date_status === "valid" && !/^20\d{2}-\d{2}-\d{2}$/.test(item.published_at)) {
    errors.push("DATE_INVALID");
  }
  if (item.excerpt.length > 500) errors.push("EXCERPT_TOO_LONG");
  if (!CLASSIFICATION_HINTS.has(item.classification_hint.code) ||
      item.classification_hint.human_review_required !== true) errors.push("HINT_INVALID");
  return errors;
}

function stableItemId(sourceCode, canonicalUrl, title) {
  return "src_" + sha256([sourceCode, canonicalUrl, normalizeText(title)].join("\n")).slice(0, 20);
}

function requestUrl(url, source, options = {}, redirectCount = 0) {
  const timeoutMs = options.timeoutMs || 15000;
  const maxBytes = options.maxBytes || 6 * 1024 * 1024;
  if (!isAllowedRequestUrl(url, source)) {
    return Promise.reject(new SourceError("URL_NOT_ALLOWED", "URL di luar allowlist.", {
      failureStage: "REDIRECT",
    }));
  }
  const ca = [...tls.getCACertificates("bundled"), ...tls.getCACertificates("system")];
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "User-Agent": options.userAgent,
        "Accept": options.accept || "text/html,application/xhtml+xml",
        "Connection": "close",
      },
      ca,
      rejectUnauthorized: true,
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectCount >= 3) return reject(new SourceError("REDIRECT_LIMIT", "Terlalu banyak redirect.", {
          failureStage: "REDIRECT", attemptedUrl: url, httpStatus: status,
          contentType: response.headers["content-type"] || "", retryCount: redirectCount,
        }));
        let target;
        try { target = normalizeUrl(response.headers.location, url); } catch (_) {
          return reject(new SourceError("REDIRECT_INVALID", "Redirect URL tidak valid.", {
            failureStage: "REDIRECT", attemptedUrl: url, httpStatus: status,
            contentType: response.headers["content-type"] || "",
          }));
        }
        if (!isAllowedRequestUrl(target, source)) {
          let redirectHost = "";
          try { redirectHost = new URL(target).hostname; } catch (_) { /* already invalid above */ }
          return reject(new SourceError("REDIRECT_OUTSIDE_DOMAIN", "Redirect keluar domain resmi ditolak.", {
            failureStage: "REDIRECT", attemptedUrl: url, httpStatus: status,
            contentType: response.headers["content-type"] || "", redirectHost,
          }));
        }
        return resolve(requestUrl(target, source, options, redirectCount + 1));
      }
      let body = "";
      let bytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) request.destroy(new SourceError("RESPONSE_TOO_LARGE", "Response terlalu besar.", {
          failureStage: "LISTING_REQUEST", attemptedUrl: url,
        }));
        else body += chunk;
      });
      response.on("end", () => resolve({
        status,
        contentType: response.headers["content-type"] || "",
        url,
        body,
        redirectCount,
      }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new SourceError("TIMEOUT", `Timeout ${timeoutMs} ms.`, {
      failureStage: "LISTING_REQUEST", attemptedUrl: url, networkErrorCode: "TIMEOUT",
    })));
    request.on("error", (error) => {
      if (error instanceof SourceError) reject(error);
      else {
        const code = networkErrorCode(error);
        reject(new SourceError(code, sanitizeDiagnosticMessage(error.message), {
          failureStage: networkFailureStage(code, error.message), attemptedUrl: url,
          networkErrorCode: code,
        }));
      }
    });
  });
}

function networkErrorCode(error) {
  const nativeCode = String(error && error.code || "").toUpperCase();
  if (/^[A-Z][A-Z0-9_]{1,80}$/.test(nativeCode)) return nativeCode;
  if (/certificate has expired/i.test(error && error.message || "")) return "CERT_HAS_EXPIRED";
  if (/certificate|unable to verify/i.test(error && error.message || "")) return "TLS_INVALID";
  if (/timed? ?out/i.test(error && error.message || "")) return "TIMEOUT";
  return "NETWORK_ERROR";
}

function networkFailureStage(code, message) {
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ENODATA"].includes(code)) return "DNS";
  if (/CERT|TLS|SSL|VERIFY|SELF_SIGNED|ISSUER|SIGNATURE/i.test(`${code} ${message || ""}`)) return "TLS";
  return "LISTING_REQUEST";
}

function sanitizeDiagnosticMessage(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL_REDACTED]")
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|token|api[_-]?key|secret|password)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(response\s+body|raw\s+html|body)\b\s*[:=].*$/i, "$1=[REDACTED]")
    .replace(/<[^>]*>/g, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim().slice(0, 240);
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function compareItems(a, b) {
  return a.source_code.localeCompare(b.source_code) ||
    b.published_at.localeCompare(a.published_at) ||
    a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

function cleanText(value) {
  return decodeEntities(String(value || "").replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function decodeEntities(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1].toLowerCase() === "x";
      const number = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : full;
    }
    return Object.prototype.hasOwnProperty.call(named, entity.toLowerCase())
      ? named[entity.toLowerCase()] : full;
  });
}

function normalizeText(value) {
  return cleanText(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function containsTerm(normalizedText, term) {
  return (` ${normalizedText} `).includes(` ${normalizeText(term)} `);
}

function isValidDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function stableUnique(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function pad(value) { return String(value).padStart(2, "0"); }
function hasText(value) { return typeof value === "string" && value.trim() !== ""; }
function isObject(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = {
  SOURCE_TYPES, SOURCE_STATUSES, CLASSIFICATION_HINTS, HINT_TERMS, SourceError,
  readJson, validateRegistry, isAllowedUrl, isAllowedRequestUrl, normalizeUrl, parseRobots, detectLoginPage,
  parseListing, parseDetail, parsePublicDate, normalizeItem, classifyHint, deduplicateItems,
  validateNormalizedItem, stableItemId, requestUrl, writeJsonAtomic, cleanText, normalizeText,
  containsTerm, compareItems, sha256, sleep, networkErrorCode, networkFailureStage,
  sanitizeDiagnosticMessage,
};
