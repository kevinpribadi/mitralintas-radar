#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.RADAR_DATA_DIR || path.join("radar", "data");
const REVIEW_QUEUE_FILE = process.env.RADAR_REVIEW_QUEUE_FILE ||
  path.join("radar", "docs", "data", "review_queue.json");
const RULES_FILE = process.env.RADAR_QUALIFICATION_RULES_FILE ||
  path.join("radar", "config", "qualification_rules.json");
const OUTPUT_FILE = process.env.RADAR_QUALIFICATION_OUTPUT ||
  path.join("radar", "docs", "data", "qualification_readiness.json");
const MAX_ITEMS = readOptionalIntegerEnv("RADAR_QUALIFICATION_MAX_ITEMS", 0);

const CHECK_KEYS = [
  "source_traceable",
  "title_informative",
  "organization_identifiable",
  "need_evidence_present",
  "product_fit_plausible",
  "timing_actionable",
  "data_quality_acceptable",
  "next_action_possible",
];

const STATE_ORDER = [
  "NEEDS_DATA_REVIEW",
  "EXPIRED_OR_HISTORICAL",
  "READY_FOR_HUMAN_QUALIFICATION",
  "NEEDS_MORE_INFORMATION",
  "LOW_PRODUCT_RELEVANCE",
];

const REASON_ORDER = [
  "SOURCE_MISSING",
  "SOURCE_INVALID",
  "TITLE_UNINFORMATIVE",
  "ORGANIZATION_UNCLEAR",
  "NEED_EVIDENCE_WEAK",
  "PRODUCT_NEED_UNCONFIRMED",
  "PRODUCT_FIT_WEAK",
  "DATE_EXPIRED",
  "DATE_UNKNOWN",
  "QUALITY_REVIEW_REQUIRED",
  "NEXT_ACTION_UNCLEAR",
  "READY_FOR_HUMAN_REVIEW",
  "HISTORICAL_REFERENCE",
];

const DISALLOWED_STATES = new Set(["QUALIFIED", "WON", "LOST", "REJECTED"]);
const ALLOWED_CHECK_VALUES = new Set(["pass", "fail", "unknown"]);

const rules = readRules(RULES_FILE);
const expiredThresholdDays = readOptionalIntegerEnv(
  "RADAR_QUALIFICATION_EXPIRED_DAYS",
  Number(rules.expired_threshold_days) || 0
);

const tenderData = readDataset(path.join(DATA_DIR, "tenders.json"), "tender");
const eventData = readDataset(path.join(DATA_DIR, "events.json"), "event");
const reviewQueue = readReviewQueue(REVIEW_QUEUE_FILE);
const reviewById = buildReviewMap(reviewQueue.items);

const generatedAt = latestIsoDate([
  tenderData.generatedAt,
  eventData.generatedAt,
  reviewQueue.generatedAt,
]) || new Date(0).toISOString();
const referenceTime = Date.parse(generatedAt);

const candidates = [
  ...tenderData.items.map((item, index) => normalizeItem(item, "tender", index)),
  ...eventData.items.map((item, index) => normalizeItem(item, "event", index)),
].sort(compareCandidates);

const limitedCandidates = MAX_ITEMS > 0 ? candidates.slice(0, MAX_ITEMS) : candidates;
const items = limitedCandidates.map((candidate) => evaluateCandidate(candidate));

const output = {
  generated_at: generatedAt,
  rules_version: rules.version,
  source_summary: {
    tender_total: tenderData.items.length,
    event_total: eventData.items.length,
    evaluated_total: items.length,
    organization_field_usage: buildOrganizationFieldUsage(limitedCandidates),
  },
  readiness_summary: buildReadinessSummary(items),
  items,
};

if (MAX_ITEMS > 0 && MAX_ITEMS < candidates.length) {
  output.source_summary.skipped_total = candidates.length - MAX_ITEMS;
  output.source_summary.skipped_reason = "RADAR_QUALIFICATION_MAX_ITEMS";
}

validateOutput(output);
writeJsonAtomic(OUTPUT_FILE, output);

console.log(
  `Tulis ${OUTPUT_FILE} (${items.length} item dievaluasi dari ` +
  `${tenderData.items.length} tender dan ${eventData.items.length} event)`
);

function readRules(filePath) {
  const parsed = readJsonFile(filePath, "qualification rules");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} harus object JSON`);
  }
  if (!hasText(parsed.version)) {
    throw new Error(`${filePath} harus memiliki version`);
  }

  const stateCodes = new Set((parsed.states || []).map((state) => state && state.code));
  STATE_ORDER.forEach((state) => {
    if (!stateCodes.has(state)) throw new Error(`rules.states tidak memiliki ${state}`);
  });
  DISALLOWED_STATES.forEach((state) => {
    if (stateCodes.has(state)) throw new Error(`rules.states tidak boleh memuat ${state}`);
  });

  const reasonCodes = parsed.reason_codes && typeof parsed.reason_codes === "object"
    ? parsed.reason_codes
    : {};
  REASON_ORDER.forEach((code) => {
    if (!reasonCodes[code]) throw new Error(`rules.reason_codes tidak memiliki ${code}`);
  });

  const allowedActions = new Set(Array.isArray(parsed.allowed_next_actions)
    ? parsed.allowed_next_actions
    : Object.values(parsed.next_action_map || {}));
  Object.values(parsed.next_action_map || {}).forEach((action) => {
    if (!allowedActions.has(action)) throw new Error(`next action tidak diizinkan: ${action}`);
  });

  return parsed;
}

function readDataset(filePath, label) {
  const parsed = readJsonFile(filePath, label);
  if (Array.isArray(parsed)) {
    return { generatedAt: null, items: parsed };
  }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) {
    return { generatedAt: parsed.generated_at || null, items: parsed.items };
  }
  throw new Error(`${label}: ${filePath} harus array item atau object dengan items array`);
}

function readReviewQueue(filePath) {
  const parsed = readJsonFile(filePath, "review queue");
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
    throw new Error(`${filePath} harus object dengan items array`);
  }
  return {
    generatedAt: parsed.generated_at || null,
    items: parsed.items.filter((item) => item && typeof item === "object" && !Array.isArray(item)),
  };
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`${label}: gagal membaca ${filePath}: ${err.message}`);
  }
}

function buildReviewMap(items) {
  const map = new Map();
  items.forEach((item) => {
    if (hasText(item.id)) map.set(item.id, normalizeReviewItem(item));
  });
  return map;
}

function normalizeReviewItem(item) {
  return {
    id: String(item.id),
    severity: ["high", "medium", "low"].includes(item.severity) ? item.severity : "low",
    issueCodes: Array.isArray(item.issue_codes) ? item.issue_codes.filter(hasText) : [],
  };
}

function normalizeItem(item, type, index) {
  const safe = item && typeof item === "object" && !Array.isArray(item) ? item : {};
  const title = type === "tender"
    ? firstText(safe.judul, safe.title, safe.name)
    : firstText(safe.nama_event, safe.title, safe.name);
  const source = firstText(safe.sumber, safe.source);
  const link = type === "tender"
    ? firstText(safe.link, safe.url)
    : firstText(safe.link_resmi, safe.link, safe.url);
  const date = type === "tender"
    ? firstText(safe.published, safe.date, safe.tanggal)
    : firstText(safe.tanggal, safe.published, safe.date);
  const organizationResult = selectOrganization(safe, type);
  const organization = organizationResult.value;
  const metadataText = type === "tender"
    ? [safe.jenis_klien_tebakan, safe.instansi_terdeteksi]
    : [safe.kategori, safe.segmen, safe.penyelenggara];
  const searchableText = [title, source, organization, ...metadataText]
    .filter((value) => value != null)
    .join(" ");
  const parsedTime = parseDateMs(date);

  return {
    id: stableItemId({ type, title, source, link }),
    type,
    index,
    title,
    source,
    link,
    date,
    organization,
    organizationField: organizationResult.field,
    searchableText,
    parsedTime,
  };
}

function evaluateCandidate(candidate) {
  const reviewItem = reviewById.get(candidate.id) || null;
  const matchedNeedTerms = matchTerms(candidate.searchableText, rules.need_evidence_terms);
  const matchedProductTerms = matchTerms(candidate.searchableText, rules.product_relevance_terms);
  const matchedIndirectTerms = matchTerms(candidate.searchableText, rules.indirect_product_fit_terms);
  const matchedCounterTerms = matchTermList(candidate.searchableText, rules.counter_signal_terms);
  const checks = buildChecks(
    candidate,
    reviewItem,
    matchedNeedTerms,
    matchedProductTerms,
    matchedIndirectTerms,
    matchedCounterTerms
  );
  const reasonCodes = buildReasonCodes(checks, reviewItem);
  const readinessState = determineReadinessState(checks);
  const finalReasonCodes = finalizeReasonCodes(readinessState, reasonCodes);
  const suggestedNextAction = chooseNextAction(readinessState, finalReasonCodes);

  return {
    id: candidate.id,
    type: candidate.type,
    title: candidate.title,
    source: candidate.source,
    link: candidate.link,
    date: candidate.date,
    organization: candidate.organization,
    readiness_state: readinessState,
    checks,
    reason_codes: finalReasonCodes,
    evidence: {
      matched_product_terms: matchedProductTerms,
      matched_indirect_product_terms: matchedIndirectTerms,
      matched_need_terms: matchedNeedTerms,
      organization_field: candidate.organizationField,
      review_issue_codes: reviewItem ? reviewItem.issueCodes : [],
    },
    suggested_next_action: suggestedNextAction,
    human_decision_required: true,
  };
}

function buildChecks(
  candidate,
  reviewItem,
  matchedNeedTerms,
  matchedProductTerms,
  matchedIndirectTerms,
  matchedCounterTerms
) {
  const checks = {
    source_traceable: checkSource(candidate),
    title_informative: checkTitle(candidate.title),
    organization_identifiable: checkOrganization(candidate.organization),
    need_evidence_present: matchedNeedTerms.length > 0 && matchedCounterTerms.length === 0
      ? "pass"
      : "unknown",
    product_fit_plausible: productFitCheck(matchedProductTerms, matchedIndirectTerms),
    timing_actionable: checkTiming(candidate),
    data_quality_acceptable: checkDataQuality(reviewItem),
    next_action_possible: "pass",
  };

  CHECK_KEYS.forEach((key) => {
    if (!ALLOWED_CHECK_VALUES.has(checks[key])) {
      throw new Error(`check ${key} menghasilkan nilai tidak valid: ${checks[key]}`);
    }
  });

  return checks;
}

function productFitCheck(matchedProductTerms, matchedIndirectTerms) {
  if (matchedProductTerms.length > 0) return "pass";
  if (matchedIndirectTerms.length > 0) return "unknown";
  return "fail";
}

function checkSource(candidate) {
  if (!hasText(candidate.source)) return "fail";
  if (!hasHttpLink(candidate.link)) return "fail";
  return "pass";
}

function checkTitle(title) {
  if (!hasText(title)) return "fail";
  const normalized = normalizeLoose(title);
  const cfg = rules.checks && rules.checks.TITLE_INFORMATIVE
    ? rules.checks.TITLE_INFORMATIVE
    : {};
  const minChars = Number(cfg.min_chars) || 10;
  const minWords = Number(cfg.min_words) || 2;
  const genericTitles = new Set((cfg.generic_titles || []).map(normalizeLoose));
  const words = normalized.split(" ").filter(Boolean);

  if (genericTitles.has(normalized)) return "fail";
  if (normalized.length < minChars) return "fail";
  if (words.length < minWords && normalized.length < 16) return "fail";
  if (hasLongTitleWithoutSpaces(title)) return "fail";
  if (/\s-\shttps?:\/\/\S+\s*$/i.test(title)) return "fail";
  return "pass";
}

function checkOrganization(organization) {
  if (!hasText(organization)) return "unknown";
  const normalized = normalizeLoose(organization);
  const generic = new Set((rules.generic_organization_terms || []).map(normalizeLoose));
  const artifactTerms = new Set((rules.organization_artifact_terms || []).map(normalizeLoose));
  const words = normalized.split(" ").filter(Boolean);

  if (generic.has(normalized)) return "fail";
  if (words.length === 1 && generic.has(words[0])) return "fail";
  if (words.some((word, index) => index > 0 && artifactTerms.has(word))) return "fail";
  if (/\b(?:https?|www|rss|google news rss)\b/i.test(organization)) return "fail";
  return "pass";
}

function checkTiming(candidate) {
  if (!hasText(candidate.date)) return "unknown";
  if (!Number.isFinite(candidate.parsedTime)) return "unknown";
  if (!Number.isFinite(referenceTime)) return "unknown";
  if (expiredThresholdDays > 0 &&
      referenceTime - candidate.parsedTime > expiredThresholdDays * 86400000) {
    return "fail";
  }
  return "pass";
}

function checkDataQuality(reviewItem) {
  if (!reviewItem) return "pass";
  const cfg = rules.checks && rules.checks.DATA_QUALITY_ACCEPTABLE
    ? rules.checks.DATA_QUALITY_ACCEPTABLE
    : {};
  const blockingSeverities = new Set(cfg.blocking_severities || ["high", "medium"]);
  return blockingSeverities.has(reviewItem.severity) ? "fail" : "pass";
}

function buildReasonCodes(checks, reviewItem) {
  const reasons = new Set();
  if (checks.source_traceable === "fail") {
    reasons.add("SOURCE_MISSING");
    reasons.add("SOURCE_INVALID");
  }
  if (checks.title_informative === "fail") reasons.add("TITLE_UNINFORMATIVE");
  if (checks.organization_identifiable !== "pass") reasons.add("ORGANIZATION_UNCLEAR");
  if (checks.need_evidence_present !== "pass") reasons.add("NEED_EVIDENCE_WEAK");
  if (checks.product_fit_plausible === "unknown") reasons.add("PRODUCT_NEED_UNCONFIRMED");
  if (checks.product_fit_plausible === "fail") reasons.add("PRODUCT_FIT_WEAK");
  if (checks.timing_actionable === "unknown") reasons.add("DATE_UNKNOWN");
  if (checks.timing_actionable === "fail") {
    reasons.add("DATE_EXPIRED");
    reasons.add("HISTORICAL_REFERENCE");
  }
  if (checks.data_quality_acceptable === "fail" || hasBlockingReviewIssue(reviewItem)) {
    reasons.add("QUALITY_REVIEW_REQUIRED");
  }
  if (checks.next_action_possible !== "pass") reasons.add("NEXT_ACTION_UNCLEAR");
  return sortReasonCodes(Array.from(reasons));
}

function hasBlockingReviewIssue(reviewItem) {
  if (!reviewItem) return false;
  const cfg = rules.checks && rules.checks.DATA_QUALITY_ACCEPTABLE
    ? rules.checks.DATA_QUALITY_ACCEPTABLE
    : {};
  const blockingSeverities = new Set(cfg.blocking_severities || ["high", "medium"]);
  return blockingSeverities.has(reviewItem.severity);
}

function determineReadinessState(checks) {
  if (checks.data_quality_acceptable === "fail") return "NEEDS_DATA_REVIEW";
  if (checks.timing_actionable === "fail") return "EXPIRED_OR_HISTORICAL";
  if (
    checks.source_traceable === "pass" &&
    checks.title_informative === "pass" &&
    checks.organization_identifiable === "pass" &&
    checks.need_evidence_present === "pass" &&
    checks.product_fit_plausible === "pass" &&
    checks.timing_actionable !== "fail" &&
    checks.data_quality_acceptable !== "fail" &&
    checks.next_action_possible === "pass"
  ) {
    return "READY_FOR_HUMAN_QUALIFICATION";
  }

  const needsMoreInformation =
    checks.source_traceable !== "pass" ||
    checks.title_informative !== "pass" ||
    checks.organization_identifiable !== "pass" ||
    checks.need_evidence_present !== "pass" ||
    checks.product_fit_plausible === "unknown" ||
    checks.timing_actionable === "unknown" ||
    checks.next_action_possible !== "pass";
  if (needsMoreInformation) return "NEEDS_MORE_INFORMATION";
  return "LOW_PRODUCT_RELEVANCE";
}

function finalizeReasonCodes(readinessState, reasonCodes) {
  const reasons = new Set(reasonCodes);
  if (readinessState === "READY_FOR_HUMAN_QUALIFICATION") {
    reasons.add("READY_FOR_HUMAN_REVIEW");
  }
  if (readinessState === "LOW_PRODUCT_RELEVANCE") {
    reasons.add("PRODUCT_FIT_WEAK");
  }
  if (readinessState === "NEEDS_DATA_REVIEW") {
    reasons.add("QUALITY_REVIEW_REQUIRED");
  }
  if (readinessState === "EXPIRED_OR_HISTORICAL") {
    reasons.add("HISTORICAL_REFERENCE");
  }
  if (reasons.size === 0) reasons.add("NEXT_ACTION_UNCLEAR");
  return sortReasonCodes(Array.from(reasons));
}

function chooseNextAction(readinessState, reasonCodes) {
  const map = rules.next_action_map || {};
  const allowed = new Set(rules.allowed_next_actions || Object.values(map));
  let action = map[readinessState] || null;

  if (readinessState === "NEEDS_MORE_INFORMATION") {
    if (reasonCodes.includes("PRODUCT_NEED_UNCONFIRMED")) {
      action = map.PRODUCT_NEED_UNCONFIRMED || action;
    } else {
    for (const reason of reasonCodes) {
      if (map[reason]) {
        action = map[reason];
        break;
      }
    }
    }
  }

  if (!action || !allowed.has(action)) return "VERIFY_SOURCE";
  return action;
}

function buildOrganizationFieldUsage(candidates) {
  const usage = {
    tender: {},
    event: {},
    none: 0,
  };
  candidates.forEach((candidate) => {
    if (!candidate.organizationField) {
      usage.none += 1;
      return;
    }
    const bucket = usage[candidate.type] || {};
    bucket[candidate.organizationField] = (bucket[candidate.organizationField] || 0) + 1;
    usage[candidate.type] = bucket;
  });
  return usage;
}

function buildReadinessSummary(items) {
  const summary = {
    ready_for_human_qualification: 0,
    needs_more_information: 0,
    needs_data_review: 0,
    expired_or_historical: 0,
    low_product_relevance: 0,
    reason_counts: {},
  };

  items.forEach((item) => {
    const key = stateSummaryKey(item.readiness_state);
    summary[key] += 1;
    item.reason_codes.forEach((code) => {
      summary.reason_counts[code] = (summary.reason_counts[code] || 0) + 1;
    });
  });

  summary.reason_counts = Object.fromEntries(
    Object.entries(summary.reason_counts).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return reasonRank(a[0]) - reasonRank(b[0]);
    })
  );
  return summary;
}

function stateSummaryKey(state) {
  return state.toLowerCase();
}

function validateOutput(output) {
  if (output.source_summary.evaluated_total !== output.items.length) {
    throw new Error("source_summary.evaluated_total tidak sama dengan jumlah items");
  }
  output.items.forEach((item) => {
    if (DISALLOWED_STATES.has(item.readiness_state)) {
      throw new Error(`state tidak diizinkan: ${item.readiness_state}`);
    }
    if (item.human_decision_required !== true) {
      throw new Error(`item ${item.id} harus human_decision_required true`);
    }
    CHECK_KEYS.forEach((key) => {
      if (!ALLOWED_CHECK_VALUES.has(item.checks[key])) {
        throw new Error(`item ${item.id} check ${key} tidak valid`);
      }
    });
    if (!Array.isArray(item.reason_codes) || item.reason_codes.length === 0) {
      throw new Error(`item ${item.id} tidak memiliki reason code`);
    }
    if (Object.prototype.hasOwnProperty.call(item, "score") ||
        Object.prototype.hasOwnProperty.call(item, "opportunity_score")) {
      throw new Error(`item ${item.id} tidak boleh memiliki numeric opportunity score`);
    }
  });
}

function matchTerms(text, groupedTerms) {
  const normalizedText = normalizeLoose(text);
  const matches = [];
  Object.keys(groupedTerms || {}).sort().forEach((group) => {
    const terms = Array.isArray(groupedTerms[group]) ? groupedTerms[group] : [];
    terms.forEach((term) => {
      if (!hasText(term)) return;
      const normalizedTerm = normalizeLoose(term);
      if (!normalizedTerm) return;
      if (containsTerm(normalizedText, normalizedTerm) && !matches.includes(term)) {
        matches.push(term);
      }
    });
  });
  return matches.sort((a, b) => normalizeLoose(a).localeCompare(normalizeLoose(b)));
}

function selectOrganization(item, type) {
  const fallback = rules.organization_field_fallback &&
    Array.isArray(rules.organization_field_fallback[type])
    ? rules.organization_field_fallback[type]
    : [];

  for (const field of fallback) {
    if (hasText(item[field])) return { value: String(item[field]).trim(), field };
  }
  return { value: "", field: "" };
}

function matchTermList(text, terms) {
  const grouped = { terms: Array.isArray(terms) ? terms : [] };
  return matchTerms(text, grouped);
}

function containsTerm(text, term) {
  if (!text || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu");
  return pattern.test(text);
}

function compareCandidates(a, b) {
  const aTime = Number.isFinite(a.parsedTime) ? a.parsedTime : null;
  const bTime = Number.isFinite(b.parsedTime) ? b.parsedTime : null;
  if (aTime != null && bTime != null && aTime !== bTime) return bTime - aTime;
  if (aTime != null && bTime == null) return -1;
  if (aTime == null && bTime != null) return 1;
  return a.type.localeCompare(b.type) ||
    a.title.localeCompare(b.title) ||
    a.source.localeCompare(b.source) ||
    a.id.localeCompare(b.id) ||
    a.index - b.index;
}

function stableItemId(candidate) {
  const raw = [
    candidate.type,
    normalizeForId(candidate.title),
    normalizeForId(candidate.source),
    normalizeForId(candidate.link),
  ].join("\n");
  return "rq_" + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

function parseDateMs(value) {
  if (!hasText(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function hasHttpLink(value) {
  if (!hasText(value)) return false;
  return /^https?:\/\/\S+$/i.test(String(value).trim());
}

function hasLongTitleWithoutSpaces(title) {
  const trimmed = String(title == null ? "" : title).trim();
  if (trimmed.length > 80 && !/\s/.test(trimmed)) return true;
  return trimmed.split(/\s+/).some((token) => token.length > 90);
}

function sortReasonCodes(codes) {
  return codes.sort((a, b) => reasonRank(a) - reasonRank(b));
}

function reasonRank(code) {
  const idx = REASON_ORDER.indexOf(code);
  return idx >= 0 ? idx : REASON_ORDER.length + code.charCodeAt(0);
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

function readOptionalIntegerEnv(name, fallback) {
  if (process.env[name] == null || process.env[name] === "") return fallback;
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} harus integer >= 0, diterima: ${process.env[name]}`);
  }
  return value;
}
