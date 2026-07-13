#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TRIGGER_CLASSES = ["direct", "indirect", "historical"];
const EVIDENCE_STRENGTHS = ["STRONG", "MODERATE", "WEAK"];
const TIMING_STATUSES = [
  "FUTURE_OR_OPEN",
  "CURRENT_OR_UNCLEAR",
  "COMPLETED_OR_PAST",
  "HISTORICAL_REFERENCE",
  "INFORMATIONAL_OR_EDITORIAL",
];
const FORBIDDEN_ACTIONS = new Set([
  "CONTACT_PERSON",
  "SEND_EMAIL",
  "SEND_WHATSAPP",
  "SUBMIT_OFFER",
  "SUBMIT_BID",
  "SET_PRICE",
]);

function main() {
  const dataDir = process.env.RADAR_DATA_DIR || path.join("radar", "data");
  const taxonomyFile = process.env.RADAR_TRIGGER_TAXONOMY_FILE ||
    path.join("radar", "config", "trigger_taxonomy.json");
  const outputFile = process.env.RADAR_TRIGGER_OUTPUT ||
    path.join("radar", "docs", "data", "trigger_signals.json");

  const taxonomy = readTaxonomy(taxonomyFile);
  const tenderData = readDataset(path.join(dataDir, "tenders.json"), "tender");
  const eventData = readDataset(path.join(dataDir, "events.json"), "event");
  const output = buildOutput({ tenderData, eventData, taxonomy });

  validateOutput(output, taxonomy);
  writeJsonAtomic(outputFile, output);
  console.log(
    `Tulis ${outputFile} (${output.source_summary.signal_total} signal dari ` +
    `${output.source_summary.evaluated_total} item dievaluasi)`
  );
  return output;
}

function readTaxonomy(filePath) {
  const parsed = readJsonFile(filePath, "trigger taxonomy");
  validateTaxonomy(parsed);
  return parsed;
}

function validateTaxonomy(taxonomy) {
  const errors = [];
  if (!isObject(taxonomy)) return failValidation(["Taxonomy harus berupa object."]);
  if (!hasText(taxonomy.version)) errors.push("Taxonomy version wajib diisi.");
  if (!Array.isArray(taxonomy.class_precedence) ||
      taxonomy.class_precedence.length !== TRIGGER_CLASSES.length ||
      !TRIGGER_CLASSES.every((value) => taxonomy.class_precedence.includes(value))) {
    errors.push("class_precedence harus memuat direct, indirect, dan historical satu kali.");
  }
  if (!Array.isArray(taxonomy.strength_precedence) ||
      taxonomy.strength_precedence.length !== EVIDENCE_STRENGTHS.length ||
      !EVIDENCE_STRENGTHS.every((value) => taxonomy.strength_precedence.includes(value))) {
    errors.push("strength_precedence harus memuat STRONG, MODERATE, dan WEAK satu kali.");
  }
  if (!Array.isArray(taxonomy.timing_statuses) ||
      taxonomy.timing_statuses.length !== TIMING_STATUSES.length ||
      !TIMING_STATUSES.every((value) => taxonomy.timing_statuses.includes(value))) {
    errors.push("timing_statuses tidak lengkap atau tidak valid.");
  }
  validateRuleTerms(taxonomy.timing_rules, [
    "future_or_open_phrases", "completed_or_past_phrases",
  ], "timing_rules", errors);
  validateRuleTerms(taxonomy.editorial_rules, [
    "terms", "suppressed_trigger_codes",
  ], "editorial_rules", errors);
  validateRuleTerms(taxonomy.primary_trigger_rules, [
    "active_direct_terms", "historical_dominant_terms",
  ], "primary_trigger_rules", errors);
  if (!Array.isArray(taxonomy.allowed_actions) || !taxonomy.allowed_actions.length) {
    errors.push("allowed_actions wajib berupa array non-empty.");
  }
  const globalActions = new Set(taxonomy.allowed_actions || []);
  globalActions.forEach((action) => {
    if (!hasText(action)) errors.push("allowed_actions hanya boleh memuat string non-empty.");
    if (FORBIDDEN_ACTIONS.has(action)) errors.push(`Action dilarang: ${action}`);
  });
  if (!Array.isArray(taxonomy.triggers) || !taxonomy.triggers.length) {
    errors.push("triggers wajib berupa array non-empty.");
  }

  const codes = new Set();
  (taxonomy.triggers || []).forEach((entry, index) => {
    const prefix = `triggers[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${prefix} harus berupa object.`);
      return;
    }
    ["code", "label", "description"].forEach((key) => {
      if (!hasText(entry[key])) errors.push(`${prefix}.${key} wajib diisi.`);
    });
    if (hasText(entry.code) && codes.has(entry.code)) errors.push(`Trigger code duplikat: ${entry.code}`);
    if (hasText(entry.code)) codes.add(entry.code);
    if (!TRIGGER_CLASSES.includes(entry.trigger_class)) {
      errors.push(`${prefix}.trigger_class tidak valid.`);
    }
    ["positive_terms", "phrase_terms", "negative_terms", "product_hypotheses", "allowed_actions"]
      .forEach((key) => validateStringArray(entry[key], `${prefix}.${key}`, errors));
    if (Array.isArray(entry.required_any_terms)) {
      validateStringArray(entry.required_any_terms, `${prefix}.required_any_terms`, errors);
    }
    if (Array.isArray(entry.context_required_terms)) {
      validateStringArray(entry.context_required_terms, `${prefix}.context_required_terms`, errors);
      validateStringArray(entry.context_terms, `${prefix}.context_terms`, errors);
    }
    (entry.allowed_actions || []).forEach((action) => {
      if (!globalActions.has(action)) errors.push(`${prefix} memakai action di luar allowlist: ${action}`);
      if (FORBIDDEN_ACTIONS.has(action)) errors.push(`${prefix} memakai action dilarang: ${action}`);
    });
  });

  const suppressedCodes = (taxonomy.editorial_rules || {}).suppressed_trigger_codes || [];
  suppressedCodes.forEach((code) => {
    if (!codes.has(code)) errors.push(`Editorial suppression memakai trigger code tidak dikenal: ${code}`);
  });

  if (errors.length) failValidation(errors);
  return true;
}

function validateRuleTerms(container, keys, label, errors) {
  if (!isObject(container)) {
    errors.push(`${label} wajib berupa object.`);
    return;
  }
  keys.forEach((key) => validateStringArray(container[key], `${label}.${key}`, errors));
}

function failValidation(errors) {
  throw new Error(errors.join(" "));
}

function validateStringArray(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} wajib berupa array.`);
    return;
  }
  const normalized = new Set();
  value.forEach((item) => {
    if (!hasText(item)) {
      errors.push(`${label} hanya boleh memuat string non-empty.`);
      return;
    }
    const key = normalizeSearchText(item);
    if (normalized.has(key)) errors.push(`${label} memiliki term duplikat: ${item}`);
    normalized.add(key);
  });
}

function readDataset(filePath, label) {
  const parsed = readJsonFile(filePath, label);
  if (Array.isArray(parsed)) return { generatedAt: null, items: parsed };
  if (isObject(parsed) && Array.isArray(parsed.items)) {
    return { generatedAt: parsed.generated_at || null, items: parsed.items };
  }
  throw new Error(`${label}: ${filePath} harus array item atau object dengan items array`);
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label}: gagal membaca ${filePath}: ${error.message}`);
  }
}

function buildOutput({ tenderData, eventData, taxonomy }) {
  validateTaxonomy(taxonomy);
  const generatedAt = latestIsoDate([tenderData.generatedAt, eventData.generatedAt]) ||
    new Date(0).toISOString();
  const candidates = [
    ...tenderData.items.map((item, index) => normalizeItem(item, "tender", index)),
    ...eventData.items.map((item, index) => normalizeItem(item, "event", index)),
  ].sort(compareCandidates);

  const evaluated = candidates.map((candidate) =>
    evaluateCandidateWithAudit(candidate, taxonomy, generatedAt));
  const items = evaluated.map((result) => result.item).filter(Boolean);
  const suppressedEditorialTotal = evaluated.filter((result) => result.editorialSuppressed).length;
  const output = {
    generated_at: generatedAt,
    taxonomy_version: taxonomy.version,
    source_summary: {
      tender_total: tenderData.items.length,
      event_total: eventData.items.length,
      evaluated_total: candidates.length,
      signal_total: items.length,
      items_without_trigger: candidates.length - items.length,
      suppressed_editorial_total: suppressedEditorialTotal,
    },
    trigger_summary: buildTriggerSummary(items, taxonomy),
    items,
  };
  validateOutput(output, taxonomy);
  return output;
}

function normalizeItem(item, type, index) {
  const safe = isObject(item) ? item : {};
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
  const organization = type === "tender"
    ? firstText(safe.instansi_terdeteksi)
    : firstText(safe.penyelenggara);
  const eventDate = type === "event" ? firstText(safe.tanggal) : "";

  return {
    id: stableItemId({ type, title, source, link }),
    type,
    index,
    title,
    source,
    link,
    date,
    eventDate,
    organization,
    normalizedTitle: normalizeSearchText(title),
  };
}

function evaluateCandidate(candidate, taxonomy, referenceDate) {
  return evaluateCandidateWithAudit(candidate, taxonomy, referenceDate).item;
}

function evaluateCandidateWithAudit(candidate, taxonomy, referenceDate) {
  const detection = detectTriggersWithAudit(candidate, taxonomy);
  const triggers = detection.triggers;
  if (!triggers.length) {
    return { item: null, editorialSuppressed: detection.editorialSuppressed };
  }
  const primary = selectPrimaryTrigger(triggers, taxonomy, candidate);
  const timingStatus = determineTimingStatus(candidate, primary, taxonomy, referenceDate);
  return { item: {
    id: candidate.id,
    type: candidate.type,
    title: candidate.title,
    source: candidate.source,
    link: candidate.link,
    date: candidate.date,
    organization: candidate.organization,
    triggers,
    primary_trigger: primary.trigger_code,
    timing_status: timingStatus,
    suggested_next_action: selectSuggestedAction(candidate, primary, taxonomy, timingStatus),
    human_review_required: true,
  }, editorialSuppressed: detection.editorialSuppressed };
}

function detectTriggers(candidate, taxonomy) {
  return detectTriggersWithAudit(candidate, taxonomy).triggers;
}

function detectTriggersWithAudit(candidate, taxonomy) {
  const editorialMatches = matchTerms(candidate.normalizedTitle, taxonomy.editorial_rules.terms);
  const editorialSuppressedCodes = new Set(taxonomy.editorial_rules.suppressed_trigger_codes);
  let editorialSuppressed = false;
  const triggers = taxonomy.triggers.map((entry) => {
    const phraseMatches = matchTerms(candidate.normalizedTitle, entry.phrase_terms);
    const positiveMatches = matchTerms(candidate.normalizedTitle, entry.positive_terms);
    const negativeMatches = matchTerms(candidate.normalizedTitle, entry.negative_terms);
    const requiredMatches = matchTerms(candidate.normalizedTitle, entry.required_any_terms || []);
    const contextRequiredMatches = matchTerms(
      candidate.normalizedTitle, entry.context_required_terms || []);
    const contextMatches = matchTerms(candidate.normalizedTitle, entry.context_terms || []);
    if (!phraseMatches.length && !positiveMatches.length) return null;
    if ((entry.required_any_terms || []).length && !requiredMatches.length) return null;
    if (contextRequiredMatches.length && !contextMatches.length &&
        phraseMatches.every((term) => containsTerm(entry.context_required_terms || [], term))) {
      return null;
    }
    if (editorialMatches.length && editorialSuppressedCodes.has(entry.code)) {
      editorialSuppressed = true;
      return null;
    }
    if (negativeMatches.length) return null;

    const matchedTerms = uniqueTerms(phraseMatches.concat(positiveMatches));
    return {
      trigger_code: entry.code,
      trigger_label: entry.label,
      trigger_class: entry.trigger_class,
      evidence_strength: determineEvidenceStrength(candidate, entry, phraseMatches, positiveMatches),
      matched_terms: matchedTerms,
      evidence_excerpt: evidenceExcerpt(candidate.title, matchedTerms),
      product_hypotheses: entry.product_hypotheses.slice(),
      human_review_required: true,
    };
  }).filter(Boolean);
  return { triggers, editorialSuppressed, editorialMatches };
}

function determineEvidenceStrength(candidate, entry, phraseMatches, positiveMatches) {
  if (phraseMatches.length) {
    if (["direct", "historical"].includes(entry.trigger_class) &&
        hasTraceableSource(candidate) && hasValidDate(candidate.date)) return "STRONG";
    return "MODERATE";
  }
  if (positiveMatches.length >= 2 && hasTraceableSource(candidate)) return "MODERATE";
  return "WEAK";
}

function selectPrimaryTrigger(triggers, taxonomy, candidate) {
  const classOrder = new Map(taxonomy.class_precedence.map((value, index) => [value, index]));
  const strengthOrder = new Map(taxonomy.strength_precedence.map((value, index) => [value, index]));
  const triggerOrder = new Map(taxonomy.triggers.map((entry, index) => [entry.code, index]));
  const direct = triggers.find((trigger) => trigger.trigger_code === "DIRECT_PROCUREMENT");
  const historical = triggers.find((trigger) => trigger.trigger_code === "HISTORICAL_PROCUREMENT_PATTERN");
  const normalizedTitle = candidate && candidate.normalizedTitle ? candidate.normalizedTitle : "";
  if (direct && historical) {
    const activeDirect = matchTerms(
      normalizedTitle, taxonomy.primary_trigger_rules.active_direct_terms).length > 0;
    const historicalDominant = matchTerms(
      normalizedTitle, taxonomy.primary_trigger_rules.historical_dominant_terms).length > 0;
    if (activeDirect) return direct;
    if (historicalDominant) return historical;
  }
  return triggers.slice().sort((a, b) => {
    return classOrder.get(a.trigger_class) - classOrder.get(b.trigger_class) ||
      strengthOrder.get(a.evidence_strength) - strengthOrder.get(b.evidence_strength) ||
      triggerOrder.get(a.trigger_code) - triggerOrder.get(b.trigger_code) ||
      a.trigger_code.localeCompare(b.trigger_code);
  })[0];
}

function determineTimingStatus(candidate, primary, taxonomy, referenceDate) {
  if (primary.trigger_class === "historical") return "HISTORICAL_REFERENCE";

  const editorialMatches = matchTerms(candidate.normalizedTitle, taxonomy.editorial_rules.terms);
  if (editorialMatches.length && primary.trigger_class !== "direct") {
    return "INFORMATIONAL_OR_EDITORIAL";
  }

  if (hasValidDate(candidate.eventDate) && hasValidDate(referenceDate)) {
    const eventDay = utcDay(candidate.eventDate);
    const referenceDay = utcDay(referenceDate);
    if (eventDay > referenceDay) return "FUTURE_OR_OPEN";
    if (eventDay < referenceDay) return "COMPLETED_OR_PAST";
    return "CURRENT_OR_UNCLEAR";
  }

  if (matchTerms(candidate.normalizedTitle,
    taxonomy.timing_rules.future_or_open_phrases).length) return "FUTURE_OR_OPEN";
  if (matchTerms(candidate.normalizedTitle,
    taxonomy.timing_rules.completed_or_past_phrases).length) return "COMPLETED_OR_PAST";
  return "CURRENT_OR_UNCLEAR";
}

function selectSuggestedAction(candidate, primary, taxonomy, timingStatus) {
  const entry = taxonomy.triggers.find((item) => item.code === primary.trigger_code);
  const allowed = new Set(entry.allowed_actions);
  if (timingStatus === "FUTURE_OR_OPEN") {
    if (!hasText(candidate.organization) && allowed.has("VERIFY_ORGANIZATION")) {
      return "VERIFY_ORGANIZATION";
    }
    if (primary.trigger_class === "indirect" && allowed.has("VERIFY_PRODUCT_NEED")) {
      return "VERIFY_PRODUCT_NEED";
    }
    if (allowed.has("PREPARE_FOR_HUMAN_QUALIFICATION")) {
      return "PREPARE_FOR_HUMAN_QUALIFICATION";
    }
  }
  if (timingStatus === "CURRENT_OR_UNCLEAR") {
    if (allowed.has("VERIFY_TIMING")) return "VERIFY_TIMING";
    if (allowed.has("VERIFY_TRIGGER")) return "VERIFY_TRIGGER";
  }
  if (timingStatus === "COMPLETED_OR_PAST") {
    if (allowed.has("ADD_TO_WATCHLIST")) return "ADD_TO_WATCHLIST";
    if (allowed.has("VERIFY_TIMING")) return "VERIFY_TIMING";
  }
  if (timingStatus === "HISTORICAL_REFERENCE") {
    if (allowed.has("ADD_TO_WATCHLIST")) return "ADD_TO_WATCHLIST";
    if (allowed.has("VERIFY_TRIGGER")) return "VERIFY_TRIGGER";
  }
  if (timingStatus === "INFORMATIONAL_OR_EDITORIAL" && allowed.has("VERIFY_TRIGGER")) {
    return "VERIFY_TRIGGER";
  }
  if (primary.evidence_strength === "WEAK" && allowed.has("VERIFY_TRIGGER")) return "VERIFY_TRIGGER";
  return entry.allowed_actions[0];
}

function buildTriggerSummary(items, taxonomy) {
  const triggerCounts = Object.fromEntries(taxonomy.triggers.map((entry) => [entry.code, 0]));
  const classCounts = Object.fromEntries(TRIGGER_CLASSES.map((value) => [value, 0]));
  const strengthCounts = Object.fromEntries(EVIDENCE_STRENGTHS.map((value) => [value, 0]));
  const timingCounts = Object.fromEntries(TIMING_STATUSES.map((value) => [value, 0]));
  const taxonomyByCode = new Map(taxonomy.triggers.map((entry) => [entry.code, entry]));

  items.forEach((item) => {
    item.triggers.forEach((trigger) => { triggerCounts[trigger.trigger_code] += 1; });
    const primary = item.triggers.find((trigger) => trigger.trigger_code === item.primary_trigger);
    classCounts[taxonomyByCode.get(primary.trigger_code).trigger_class] += 1;
    strengthCounts[primary.evidence_strength] += 1;
    timingCounts[item.timing_status] += 1;
  });

  return {
    trigger_counts: sortCountObject(triggerCounts),
    class_counts: classCounts,
    strength_counts: strengthCounts,
    timing_counts: timingCounts,
  };
}

function sortCountObject(counts) {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => {
    return b[1] - a[1] || a[0].localeCompare(b[0]);
  }));
}

function validateOutput(output, taxonomy) {
  if (!isObject(output) || !Array.isArray(output.items)) throw new Error("Output trigger tidak valid.");
  const summary = output.source_summary;
  if (summary.tender_total + summary.event_total !== summary.evaluated_total) {
    throw new Error("evaluated_total tidak konsisten dengan total sumber.");
  }
  if (summary.signal_total !== output.items.length) throw new Error("signal_total tidak konsisten.");
  if (summary.signal_total + summary.items_without_trigger !== summary.evaluated_total) {
    throw new Error("signal_total dan items_without_trigger tidak mencakup seluruh input.");
  }
  if (!Number.isInteger(summary.suppressed_editorial_total) ||
      summary.suppressed_editorial_total < 0 ||
      summary.suppressed_editorial_total > summary.evaluated_total) {
    throw new Error("suppressed_editorial_total tidak valid.");
  }

  const taxonomyByCode = new Map(taxonomy.triggers.map((entry) => [entry.code, entry]));
  const allowedActions = new Set(taxonomy.allowed_actions);
  const ids = new Set();
  output.items.forEach((item) => {
    if (ids.has(item.id)) throw new Error(`Stable item ID duplikat: ${item.id}`);
    ids.add(item.id);
    if (item.human_review_required !== true) throw new Error(`Item ${item.id} wajib human review.`);
    if (!TIMING_STATUSES.includes(item.timing_status)) {
      throw new Error(`Timing status ${item.id} tidak valid.`);
    }
    if (!Array.isArray(item.triggers) || !item.triggers.length) throw new Error(`Item ${item.id} tanpa trigger.`);
    if (!item.triggers.some((trigger) => trigger.trigger_code === item.primary_trigger)) {
      throw new Error(`Primary trigger ${item.id} tidak ditemukan.`);
    }
    if (!allowedActions.has(item.suggested_next_action) || FORBIDDEN_ACTIONS.has(item.suggested_next_action)) {
      throw new Error(`Suggested action ${item.id} tidak valid.`);
    }
    item.triggers.forEach((trigger) => {
      const entry = taxonomyByCode.get(trigger.trigger_code);
      if (!entry) throw new Error(`Trigger code tidak dikenal: ${trigger.trigger_code}`);
      if (trigger.trigger_class !== entry.trigger_class) throw new Error(`Trigger class tidak konsisten.`);
      if (!EVIDENCE_STRENGTHS.includes(trigger.evidence_strength)) throw new Error(`Evidence strength tidak valid.`);
      if (!Array.isArray(trigger.matched_terms) || !trigger.matched_terms.length) {
        throw new Error(`Trigger ${trigger.trigger_code} tidak memiliki matched evidence.`);
      }
      if (!hasText(trigger.evidence_excerpt) || !item.title.includes(trigger.evidence_excerpt)) {
        throw new Error(`Evidence excerpt ${trigger.trigger_code} bukan substring judul input.`);
      }
      if (trigger.human_review_required !== true) throw new Error(`Trigger wajib human review.`);
      if (JSON.stringify(trigger.product_hypotheses) !== JSON.stringify(entry.product_hypotheses)) {
        throw new Error(`Product hypotheses ${trigger.trigger_code} tidak sesuai taxonomy.`);
      }
    });
    if (containsScoreField(item)) throw new Error(`Numeric score tidak diizinkan pada ${item.id}.`);
  });

  const expectedSummary = buildTriggerSummary(output.items, taxonomy);
  if (JSON.stringify(expectedSummary) !== JSON.stringify(output.trigger_summary)) {
    throw new Error("trigger_summary tidak konsisten dengan items.");
  }
  return true;
}

function containsScoreField(value) {
  if (!isObject(value) && !Array.isArray(value)) return false;
  return Object.keys(value).some((key) => {
    if (/score/i.test(key) && typeof value[key] === "number") return true;
    return containsScoreField(value[key]);
  });
}

function matchTerms(normalizedText, terms) {
  return (terms || []).filter((term) => containsNormalizedTerm(normalizedText, term));
}

function containsNormalizedTerm(normalizedText, term) {
  const needle = normalizeSearchText(term);
  if (!needle) return false;
  return (` ${normalizedText} `).includes(` ${needle} `);
}

function uniqueTerms(terms) {
  const seen = new Set();
  return terms.filter((term) => {
    const normalized = normalizeSearchText(term);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function containsTerm(terms, candidateTerm) {
  const normalized = normalizeSearchText(candidateTerm);
  return (terms || []).some((term) => normalizeSearchText(term) === normalized);
}

function evidenceExcerpt(title, matchedTerms) {
  const sourceText = String(title == null ? "" : title);
  if (sourceText.length <= 220) return sourceText;
  const lower = sourceText.toLowerCase();
  let index = -1;
  for (const term of matchedTerms) {
    index = lower.indexOf(String(term).toLowerCase());
    if (index >= 0) break;
  }
  const start = Math.max(0, (index >= 0 ? index : 0) - 60);
  return sourceText.slice(start, start + 220);
}

function compareCandidates(a, b) {
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

function normalizeForId(value) {
  return normalizeLoose(value);
}

function normalizeSearchText(value) {
  return normalizeLoose(value).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
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

function hasTraceableSource(candidate) {
  return hasText(candidate.source) && /^https?:\/\/\S+$/i.test(candidate.link);
}

function hasValidDate(value) {
  return hasText(value) && Number.isFinite(Date.parse(value));
}

function utcDay(value) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function latestIsoDate(values) {
  let latest = null;
  values.forEach((value) => {
    if (!hasText(value)) return;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return;
    if (!latest || time > latest) latest = time;
  });
  return latest == null ? null : new Date(latest).toISOString();
}

function firstText() {
  for (let index = 0; index < arguments.length; index += 1) {
    if (hasText(arguments[index])) return String(arguments[index]).trim();
  }
  return "";
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, filePath);
}

module.exports = {
  TRIGGER_CLASSES,
  EVIDENCE_STRENGTHS,
  TIMING_STATUSES,
  FORBIDDEN_ACTIONS,
  main,
  readTaxonomy,
  validateTaxonomy,
  readDataset,
  buildOutput,
  normalizeItem,
  evaluateCandidate,
  evaluateCandidateWithAudit,
  detectTriggers,
  detectTriggersWithAudit,
  determineEvidenceStrength,
  selectPrimaryTrigger,
  determineTimingStatus,
  selectSuggestedAction,
  buildTriggerSummary,
  validateOutput,
  stableItemId,
  normalizeSearchText,
  writeJsonAtomic,
};

if (require.main === module) main();
