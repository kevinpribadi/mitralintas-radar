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
const SOURCE_ACCEPTANCE_STATUSES = new Set([
  "ACCEPTED_FOR_TRIGGER_PILOT",
  "PILOT_ONLY",
  "DISABLED",
  "REJECTED",
]);
const ACCEPTED_SOURCE_STATUS = "ACCEPTED_FOR_TRIGGER_PILOT";

function main() {
  const dataDir = process.env.RADAR_DATA_DIR || path.join("radar", "data");
  const taxonomyFile = process.env.RADAR_TRIGGER_TAXONOMY_FILE ||
    path.join("radar", "config", "trigger_taxonomy.json");
  const outputFile = process.env.RADAR_TRIGGER_OUTPUT ||
    path.join("radar", "docs", "data", "trigger_signals.json");
  const sourcePilotFile = process.env.RADAR_SOURCE_PILOT_FILE ||
    path.join("radar", "docs", "data", "source_pilot_items.json");
  const sourceRegistryFile = process.env.RADAR_SOURCE_REGISTRY ||
    path.join("radar", "config", "source_registry.json");
  const includeSourcePilot = parseBooleanEnv(
    process.env.RADAR_TRIGGER_INCLUDE_SOURCE_PILOT, true);

  const taxonomy = readTaxonomy(taxonomyFile);
  const tenderData = readDataset(path.join(dataDir, "tenders.json"), "tender");
  const eventData = readDataset(path.join(dataDir, "events.json"), "event");
  const pilotInputs = includeSourcePilot
    ? readSourcePilotInputs(sourcePilotFile, sourceRegistryFile)
    : { sourcePilotData: null, sourceRegistry: null, registryValid: false, warnings: [] };
  pilotInputs.warnings.forEach((warning) => console.warn(`WARNING: ${warning}`));
  const output = buildOutput({
    tenderData,
    eventData,
    taxonomy,
    sourcePilotData: pilotInputs.sourcePilotData,
    sourceRegistry: pilotInputs.sourceRegistry,
    sourceRegistryValid: pilotInputs.registryValid,
  });

  validateOutput(output, taxonomy);
  writeJsonAtomic(outputFile, output);
  console.log(
    `Tulis ${outputFile} (${output.source_summary.total_signal_total} signal dari ` +
    `${output.source_summary.total_evaluated} item dievaluasi; ` +
    `${output.source_summary.source_pilot_signal_total} signal sumber resmi pilot)`
  );
  return output;
}

function parseBooleanEnv(value, defaultValue) {
  if (value == null || String(value).trim() === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function readSourcePilotInputs(sourcePilotFile, sourceRegistryFile) {
  const warnings = [];
  let sourcePilotData = null;
  let sourceRegistry = null;
  let registryValid = false;
  try {
    sourcePilotData = readSourcePilotDataset(sourcePilotFile);
  } catch (error) {
    warnings.push(`source pilot tidak tersedia; production tetap dibangun (${error.message})`);
  }
  try {
    sourceRegistry = readJsonFile(sourceRegistryFile, "source registry");
    validateSourceRegistry(sourceRegistry);
    registryValid = true;
  } catch (error) {
    warnings.push(`source registry invalid; source pilot fail-closed (${error.message})`);
  }
  return { sourcePilotData, sourceRegistry, registryValid, warnings };
}

function readSourcePilotDataset(filePath) {
  const parsed = readJsonFile(filePath, "source pilot");
  if (!isObject(parsed) || !Array.isArray(parsed.items)) {
    throw new Error(`${filePath} harus object dengan items array`);
  }
  return { generatedAt: parsed.generated_at || null, items: parsed.items };
}

function validateSourceRegistry(registry) {
  const errors = [];
  if (!isObject(registry) || !Array.isArray(registry.sources)) {
    throw new Error("source registry harus object dengan sources array");
  }
  const configuredStatuses = registry.acceptance_statuses;
  if (!Array.isArray(configuredStatuses) ||
      SOURCE_ACCEPTANCE_STATUSES.size !== configuredStatuses.length ||
      !Array.from(SOURCE_ACCEPTANCE_STATUSES).every((status) => configuredStatuses.includes(status))) {
    errors.push("acceptance_statuses harus memuat empat status J.2B satu kali");
  }
  const codes = new Set();
  registry.sources.forEach((source, index) => {
    if (!isObject(source) || !hasText(source.code)) {
      errors.push(`sources[${index}].code wajib diisi`);
      return;
    }
    if (codes.has(source.code)) errors.push(`source code duplikat: ${source.code}`);
    codes.add(source.code);
    if (!SOURCE_ACCEPTANCE_STATUSES.has(source.acceptance_status)) {
      errors.push(`${source.code} memiliki acceptance_status invalid`);
    }
    if (source.acceptance_status === "REJECTED" && !hasText(source.acceptance_reason)) {
      errors.push(`${source.code} wajib memiliki acceptance_reason`);
    }
  });
  if (errors.length) throw new Error(errors.join("; "));
  return true;
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
  if (!Number.isInteger(taxonomy.future_signal_max_published_age_days) ||
      taxonomy.future_signal_max_published_age_days < 0) {
    errors.push("future_signal_max_published_age_days wajib integer non-negative.");
  }
  validateRuleTerms(taxonomy.timing_rules, [
    "future_or_open_phrases", "invitation_lead_terms", "invitation_action_terms",
    "completed_or_past_phrases", "completed_actor_terms", "completed_action_terms",
    "completed_passive_terms", "completed_quantity_terms", "ambiguous_verbs",
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
    if (Array.isArray(entry.origin_scope)) {
      validateStringArray(entry.origin_scope, `${prefix}.origin_scope`, errors);
      entry.origin_scope.forEach((origin) => {
        if (!["tender_corpus", "event_corpus", "official_source_pilot"].includes(origin)) {
          errors.push(`${prefix}.origin_scope tidak valid: ${origin}`);
        }
      });
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

function buildOutput({
  tenderData,
  eventData,
  taxonomy,
  sourcePilotData = null,
  sourceRegistry = null,
  sourceRegistryValid = sourceRegistry != null,
}) {
  validateTaxonomy(taxonomy);
  if (sourceRegistryValid) {
    try {
      validateSourceRegistry(sourceRegistry);
    } catch (_error) {
      sourceRegistryValid = false;
    }
  }
  const generatedAt = latestIsoDate([tenderData.generatedAt, eventData.generatedAt]) ||
    new Date(0).toISOString();
  const productionCandidates = [
    ...tenderData.items.map((item, index) => normalizeItem(item, "tender", index)),
    ...eventData.items.map((item, index) => normalizeItem(item, "event", index)),
  ].sort(compareCandidates);
  const productionEvaluated = productionCandidates.map((candidate) =>
    evaluateCandidateWithAudit(candidate, taxonomy, generatedAt));
  const productionItems = productionEvaluated.map((result) => result.item).filter(Boolean);
  const productionItemById = new Map(productionItems.map((item) => [item.id, item]));
  const pilotInputItems = sourcePilotData && Array.isArray(sourcePilotData.items)
    ? sourcePilotData.items : [];
  const registryByCode = new Map(
    sourceRegistryValid && sourceRegistry && Array.isArray(sourceRegistry.sources)
      ? sourceRegistry.sources.map((source) => [source.code, source]) : []);
  const acceptedPilotItems = pilotInputItems.filter((item) => {
    const registrySource = registryByCode.get(isObject(item) ? item.source_code : "");
    return registrySource && registrySource.acceptance_status === ACCEPTED_SOURCE_STATUS;
  });
  let rejectedSourceItems = pilotInputItems.length - acceptedPilotItems.length;
  const productionIds = new Set(productionCandidates.map((candidate) => candidate.id));
  const pilotIds = new Set();
  const integratedPilotCandidates = [];
  let crossCorpusDuplicates = 0;

  acceptedPilotItems.forEach((item, index) => {
    const candidate = normalizeSourcePilotItem(item, index);
    if (!candidate) {
      rejectedSourceItems += 1;
      return;
    }
    if (productionIds.has(candidate.id) || pilotIds.has(candidate.id)) {
      throw new Error(`ID collision source pilot: ${candidate.id}`);
    }
    pilotIds.add(candidate.id);
    const duplicate = findCrossCorpusDuplicate(candidate, productionCandidates);
    if (duplicate) {
      crossCorpusDuplicates += 1;
      const productionSignal = productionItemById.get(duplicate.id);
      if (productionSignal) {
        productionSignal.related_official_provenance.push({
          source_code: candidate.source_code,
          ...candidate.official_provenance,
        });
      }
      return;
    }
    integratedPilotCandidates.push(candidate);
  });

  const pilotEvaluated = integratedPilotCandidates.map((candidate) =>
    evaluateCandidateWithAudit(candidate, taxonomy, generatedAt));
  const pilotItems = pilotEvaluated.map((result) => result.item).filter(Boolean);
  const items = productionItems.concat(pilotItems);
  const suppressedEditorialTotal = productionEvaluated
    .filter((result) => result.editorialSuppressed).length;
  const pilotSuppressedEditorialTotal = pilotEvaluated
    .filter((result) => result.editorialSuppressed).length;
  const output = {
    generated_at: generatedAt,
    taxonomy_version: taxonomy.version,
    source_summary: {
      tender_total: tenderData.items.length,
      event_total: eventData.items.length,
      production_evaluated_total: productionCandidates.length,
      evaluated_total: productionCandidates.length,
      production_signal_total: productionItems.length,
      signal_total: productionItems.length,
      production_items_without_trigger: productionCandidates.length - productionItems.length,
      items_without_trigger: productionCandidates.length - productionItems.length,
      suppressed_editorial_total: suppressedEditorialTotal,
      source_pilot_input_total: pilotInputItems.length,
      source_pilot_integrated_total: integratedPilotCandidates.length,
      source_pilot_signal_total: pilotItems.length,
      source_pilot_without_trigger: integratedPilotCandidates.length - pilotItems.length,
      source_pilot_suppressed_editorial_total: pilotSuppressedEditorialTotal,
      cross_corpus_duplicates: crossCorpusDuplicates,
      rejected_source_items: rejectedSourceItems,
      total_evaluated: productionCandidates.length + integratedPilotCandidates.length,
      total_signal_total: items.length,
      total_items_without_trigger:
        productionCandidates.length - productionItems.length +
        integratedPilotCandidates.length - pilotItems.length,
    },
    trigger_summary: buildTriggerSummary(items, taxonomy),
    production_trigger_summary: buildTriggerSummary(productionItems, taxonomy),
    source_pilot_trigger_summary: buildTriggerSummary(pilotItems, taxonomy),
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
  const publishedDate = firstText(safe.published);

  return {
    id: stableItemId({ type, title, source, link }),
    type,
    data_origin: type === "tender" ? "tender_corpus" : "event_corpus",
    source_code: null,
    official_provenance: null,
    related_official_provenance: [],
    index,
    title,
    source,
    link,
    date,
    eventDate,
    publishedDate,
    organization,
    normalizedTitle: normalizeSearchText(title),
    normalizedExcerpt: "",
    detectionFields: [{ field: "title", text: title, normalized: normalizeSearchText(title) }],
    exactUrls: exactCandidateUrls(safe, link),
    normalizedUrls: normalizedCandidateUrls(safe, link),
  };
}

function normalizeSourcePilotItem(item, index) {
  if (!isObject(item) || !hasText(item.id) || !hasText(item.source_code) ||
      !hasText(item.title) || !hasText(item.link) || !isObject(item.provenance)) return null;
  const title = String(item.title).trim();
  const excerpt = hasText(item.excerpt) ? String(item.excerpt).trim() : "";
  const publishedAt = hasText(item.published_at) ? String(item.published_at).trim() : "";
  const sourceName = hasText(item.source_name) ? String(item.source_name).trim() : "";
  const detailUrl = firstText(item.provenance.detail_url, item.link);
  const officialProvenance = {
    source_name: sourceName,
    official_domain: firstText(item.provenance.official_domain),
    detail_url: detailUrl,
    published_at: publishedAt,
    retrieval_method: firstText(item.provenance.retrieval_method),
  };
  if (Object.values(officialProvenance).some((value) => !hasText(value))) return null;
  return {
    id: String(item.id).trim(),
    type: "official_source_pilot",
    data_origin: "official_source_pilot",
    source_code: String(item.source_code).trim(),
    official_provenance: officialProvenance,
    related_official_provenance: [],
    index,
    title,
    excerpt,
    source: sourceName,
    link: detailUrl,
    date: publishedAt,
    eventDate: "",
    publishedDate: publishedAt,
    organization: firstText(item.organization_hint),
    normalizedTitle: normalizeSearchText(title),
    normalizedExcerpt: normalizeSearchText(excerpt),
    detectionFields: [
      { field: "title", text: title, normalized: normalizeSearchText(title) },
      { field: "excerpt", text: excerpt, normalized: normalizeSearchText(excerpt) },
    ].filter((entry) => hasText(entry.text)),
    exactUrls: exactCandidateUrls(item.provenance, detailUrl),
    normalizedUrls: normalizedCandidateUrls(item.provenance, detailUrl),
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
    data_origin: candidate.data_origin,
    source_code: candidate.source_code,
    official_provenance: candidate.official_provenance,
    related_official_provenance: candidate.related_official_provenance.slice(),
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
  const editorialMatches = matchCandidateTerms(candidate, taxonomy.editorial_rules.terms);
  const editorialSuppressedCodes = new Set(taxonomy.editorial_rules.suppressed_trigger_codes);
  let editorialSuppressed = false;
  const triggers = taxonomy.triggers.map((entry) => {
    if (Array.isArray(entry.origin_scope) && !entry.origin_scope.includes(candidate.data_origin)) {
      return null;
    }
    const phraseMatches = matchCandidateTerms(candidate, entry.phrase_terms);
    const positiveMatches = matchCandidateTerms(candidate, entry.positive_terms);
    const negativeMatches = matchCandidateTerms(candidate, entry.negative_terms);
    const requiredMatches = matchCandidateTerms(candidate, entry.required_any_terms || []);
    const contextRequiredMatches = matchCandidateTerms(
      candidate, entry.context_required_terms || []);
    const contextMatches = matchCandidateTerms(candidate, entry.context_terms || []);
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
    const matchedEvidence = buildMatchedEvidence(
      candidate, entry.phrase_terms.concat(entry.positive_terms), matchedTerms);
    return {
      trigger_code: entry.code,
      trigger_label: entry.label,
      trigger_class: entry.trigger_class,
      evidence_strength: determineEvidenceStrength(candidate, entry, phraseMatches, positiveMatches),
      matched_terms: matchedTerms,
      matched_evidence: matchedEvidence,
      evidence_excerpt: candidate.data_origin === "official_source_pilot"
        ? (matchedEvidence[0] || {}).excerpt || ""
        : evidenceExcerpt(candidate.title, matchedTerms),
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

  const editorialMatches = matchCandidateTerms(candidate, taxonomy.editorial_rules.terms);
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

  const timingRules = taxonomy.timing_rules;
  const hasFuturePhrase = matchCandidateTerms(
    candidate, timingRules.future_or_open_phrases).length > 0;
  const hasInvitationContext = candidateFields(candidate).some((field) =>
    hasOrderedTermContext(
      field.normalized,
      timingRules.invitation_lead_terms,
      timingRules.invitation_action_terms
    ));
  if (hasFuturePhrase || hasInvitationContext) {
    const isStale = isPublishedDateStale(
      candidate.publishedDate,
      referenceDate,
      taxonomy.future_signal_max_published_age_days
    );
    if (isStale && !candidateFields(candidate).some((field) =>
      hasExplicitFutureDate(field.text, referenceDate))) {
      return "CURRENT_OR_UNCLEAR";
    }
    return "FUTURE_OR_OPEN";
  }

  const hasCompletedPhrase = matchCandidateTerms(
    candidate, timingRules.completed_or_past_phrases).length > 0;
  const hasCompletedActorContext = candidateFields(candidate).some((field) =>
    hasOrderedTermContext(
      field.normalized,
      timingRules.completed_actor_terms,
      timingRules.completed_action_terms
    ));
  const hasCompletedPassiveContext = candidateFields(candidate).some((field) =>
    matchTerms(field.normalized, timingRules.completed_passive_terms).length > 0 &&
    matchTerms(field.normalized, timingRules.completed_quantity_terms).length > 0 &&
    matchTerms(field.normalized, timingRules.completed_actor_terms).length > 0);
  if (hasCompletedPhrase || hasCompletedActorContext || hasCompletedPassiveContext) {
    return "COMPLETED_OR_PAST";
  }
  if (matchCandidateTerms(candidate, timingRules.ambiguous_verbs).length) {
    return "CURRENT_OR_UNCLEAR";
  }
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
  if (summary.tender_total + summary.event_total !== summary.production_evaluated_total ||
      summary.evaluated_total !== summary.production_evaluated_total) {
    throw new Error("production_evaluated_total tidak konsisten dengan total corpus produksi.");
  }
  if (summary.production_signal_total !== summary.signal_total ||
      summary.production_items_without_trigger !== summary.items_without_trigger ||
      summary.production_signal_total + summary.production_items_without_trigger !==
        summary.production_evaluated_total) {
    throw new Error("Count signal production tidak konsisten.");
  }
  if (summary.source_pilot_signal_total + summary.source_pilot_without_trigger !==
      summary.source_pilot_integrated_total) {
    throw new Error("Count source pilot tidak konsisten.");
  }
  if (summary.source_pilot_integrated_total + summary.cross_corpus_duplicates +
      summary.rejected_source_items !== summary.source_pilot_input_total) {
    throw new Error("Seluruh input source pilot harus terhitung.");
  }
  if (summary.total_evaluated !==
      summary.production_evaluated_total + summary.source_pilot_integrated_total) {
    throw new Error("total_evaluated tidak konsisten.");
  }
  if (summary.total_signal_total !== output.items.length ||
      summary.total_signal_total !==
        summary.production_signal_total + summary.source_pilot_signal_total) {
    throw new Error("total_signal_total tidak konsisten.");
  }
  if (summary.total_items_without_trigger !==
      summary.production_items_without_trigger + summary.source_pilot_without_trigger) {
    throw new Error("total_items_without_trigger tidak konsisten.");
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
    if (!["tender_corpus", "event_corpus", "official_source_pilot"].includes(item.data_origin)) {
      throw new Error(`Data origin ${item.id} tidak valid.`);
    }
    if (item.data_origin === "official_source_pilot") {
      if (!hasText(item.source_code) || !isCompleteOfficialProvenance(item.official_provenance)) {
        throw new Error(`Official provenance ${item.id} tidak lengkap.`);
      }
      if (hasText(item.organization) && item.organization === item.source) {
        throw new Error(`Publisher tidak boleh menjadi organization ${item.id}.`);
      }
    } else if (item.official_provenance !== null) {
      throw new Error(`Corpus production ${item.id} tidak boleh memiliki official_provenance utama.`);
    }
    if (!Array.isArray(item.related_official_provenance)) {
      throw new Error(`related_official_provenance ${item.id} harus array.`);
    }
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
      if (!Array.isArray(trigger.matched_evidence) || !trigger.matched_evidence.length) {
        throw new Error(`Trigger ${trigger.trigger_code} tidak memiliki matched_evidence.`);
      }
      trigger.matched_terms.forEach((term) => {
        if (!trigger.matched_evidence.some((evidence) =>
          normalizeSearchText(evidence.term) === normalizeSearchText(term))) {
          throw new Error(`Matched term ${term} tidak memiliki asal evidence.`);
        }
      });
      trigger.matched_evidence.forEach((evidence) => {
        if (!hasText(evidence.term) || !["title", "excerpt"].includes(evidence.field) ||
            !hasText(evidence.excerpt) || evidence.excerpt.length > 300) {
          throw new Error(`Matched evidence ${trigger.trigger_code} invalid.`);
        }
        if (evidence.field === "title" && !item.title.includes(evidence.excerpt)) {
          throw new Error(`Title evidence ${trigger.trigger_code} bukan substring input.`);
        }
        if (item.data_origin !== "official_source_pilot" && evidence.field !== "title") {
          throw new Error(`Production evidence ${trigger.trigger_code} harus berasal dari title.`);
        }
      });
      if (!hasText(trigger.evidence_excerpt) || trigger.evidence_excerpt.length > 300) {
        throw new Error(`Evidence excerpt ${trigger.trigger_code} invalid.`);
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
  const productionItems = output.items.filter((item) => item.data_origin !== "official_source_pilot");
  const sourcePilotItems = output.items.filter((item) => item.data_origin === "official_source_pilot");
  if (JSON.stringify(buildTriggerSummary(productionItems, taxonomy)) !==
      JSON.stringify(output.production_trigger_summary)) {
    throw new Error("production_trigger_summary tidak konsisten.");
  }
  if (JSON.stringify(buildTriggerSummary(sourcePilotItems, taxonomy)) !==
      JSON.stringify(output.source_pilot_trigger_summary)) {
    throw new Error("source_pilot_trigger_summary tidak konsisten.");
  }
  return true;
}

function isCompleteOfficialProvenance(value) {
  return isObject(value) && [
    "source_name", "official_domain", "detail_url", "published_at", "retrieval_method",
  ].every((key) => hasText(value[key]));
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

function candidateFields(candidate) {
  if (candidate && Array.isArray(candidate.detectionFields) && candidate.detectionFields.length) {
    return candidate.detectionFields;
  }
  const title = candidate && hasText(candidate.title) ? candidate.title : "";
  return [{ field: "title", text: title, normalized: normalizeSearchText(title) }];
}

function matchCandidateTerms(candidate, terms) {
  return (terms || []).filter((term) => candidateFields(candidate).some((field) =>
    containsNormalizedTerm(field.normalized, term)));
}

function buildMatchedEvidence(candidate, configuredTerms, matchedTerms) {
  const matched = new Set(matchedTerms.map(normalizeSearchText));
  const orderedTerms = uniqueTerms((configuredTerms || []).filter((term) =>
    matched.has(normalizeSearchText(term))));
  const evidence = [];
  orderedTerms.forEach((term) => {
    candidateFields(candidate).forEach((field) => {
      if (!containsNormalizedTerm(field.normalized, term)) return;
      evidence.push({
        term,
        field: field.field,
        excerpt: evidenceExcerptFromField(field.text, term, 300),
      });
    });
  });
  return evidence;
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

function hasOrderedTermContext(normalizedText, leadTerms, actionTerms) {
  const padded = ` ${normalizedText} `;
  return (leadTerms || []).some((leadTerm) => {
    const leadNeedle = ` ${normalizeSearchText(leadTerm)} `;
    if (!leadNeedle.trim()) return false;
    let leadIndex = padded.indexOf(leadNeedle);
    while (leadIndex >= 0) {
      const actionFound = (actionTerms || []).some((actionTerm) => {
        const actionNeedle = ` ${normalizeSearchText(actionTerm)} `;
        return actionNeedle.trim() &&
          padded.indexOf(actionNeedle, leadIndex + leadNeedle.length - 1) >= 0;
      });
      if (actionFound) return true;
      leadIndex = padded.indexOf(leadNeedle, leadIndex + leadNeedle.length);
    }
    return false;
  });
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

function evidenceExcerptFromField(value, term, maxLength) {
  const sourceText = String(value == null ? "" : value);
  if (sourceText.length <= maxLength) return sourceText;
  const index = sourceText.toLowerCase().indexOf(String(term).toLowerCase());
  const start = Math.max(0, (index >= 0 ? index : 0) - 100);
  return sourceText.slice(start, start + maxLength);
}

function exactCandidateUrls(container, primaryUrl) {
  return uniqueTextValues(collectUrlValues(container).concat([primaryUrl]));
}

function normalizedCandidateUrls(container, primaryUrl) {
  return uniqueTextValues(exactCandidateUrls(container, primaryUrl)
    .map(normalizeOfficialUrl).filter(Boolean));
}

function collectUrlValues(container) {
  if (!isObject(container)) return [];
  return ["canonical_url", "canonical", "detail_url", "link", "link_resmi", "url"]
    .map((key) => container[key]).filter(hasText);
}

function uniqueTextValues(values) {
  return Array.from(new Set((values || []).filter(hasText).map((value) => String(value).trim())));
}

function normalizeOfficialUrl(value) {
  if (!hasText(value)) return "";
  try {
    const parsed = new URL(String(value).trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]
      .forEach((key) => parsed.searchParams.delete(key));
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    const sorted = Array.from(parsed.searchParams.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    parsed.search = "";
    sorted.forEach(([key, item]) => parsed.searchParams.append(key, item));
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

function findCrossCorpusDuplicate(pilotCandidate, productionCandidates) {
  const exact = new Set(pilotCandidate.exactUrls || []);
  let duplicate = productionCandidates.find((candidate) =>
    (candidate.exactUrls || []).some((url) => exact.has(url)));
  if (duplicate) return duplicate;

  const normalized = new Set(pilotCandidate.normalizedUrls || []);
  duplicate = productionCandidates.find((candidate) =>
    (candidate.normalizedUrls || []).some((url) => normalized.has(url)));
  if (duplicate) return duplicate;

  const pilotDate = normalizedPublishedDate(pilotCandidate.publishedDate);
  if (!pilotCandidate.normalizedTitle || !pilotDate) return null;
  return productionCandidates.find((candidate) =>
    candidate.normalizedTitle === pilotCandidate.normalizedTitle &&
    normalizedPublishedDate(candidate.publishedDate) === pilotDate) || null;
}

function normalizedPublishedDate(value) {
  if (!hasValidDate(value)) return "";
  return new Date(value).toISOString().slice(0, 10);
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

function isPublishedDateStale(publishedDate, referenceDate, maxAgeDays) {
  if (!hasValidDate(publishedDate) || !hasValidDate(referenceDate)) return false;
  const ageDays = (utcDay(referenceDate) - utcDay(publishedDate)) / 86400000;
  return ageDays > maxAgeDays;
}

function hasExplicitFutureDate(title, referenceDate) {
  if (!hasValidDate(referenceDate)) return false;
  const referenceDay = utcDay(referenceDate);
  const reference = new Date(referenceDate);
  const source = normalizeLoose(title);
  const numericDates = [];
  let match;
  const isoPattern = /\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/g;
  while ((match = isoPattern.exec(source))) {
    numericDates.push(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }
  const localPattern = /\b(\d{1,2})[-\/](\d{1,2})[-\/](20\d{2})\b/g;
  while ((match = localPattern.exec(source))) {
    numericDates.push(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  }
  if (numericDates.some((value) => Number.isFinite(value) && value > referenceDay)) return true;

  const monthNumbers = {
    januari: 0, january: 0, februari: 1, february: 1, maret: 2, march: 2,
    april: 3, mei: 4, may: 4, juni: 5, june: 5, juli: 6, july: 6,
    agustus: 7, august: 7, september: 8, oktober: 9, october: 9,
    november: 10, desember: 11, december: 11,
  };
  const tokens = normalizeSearchText(title).split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(monthNumbers, tokens[index])) continue;
    const previous = Number(tokens[index - 1]);
    const next = Number(tokens[index + 1]);
    const day = Number.isInteger(previous) && previous >= 1 && previous <= 31 ? previous : 1;
    const year = Number.isInteger(next) && next >= 2000 && next <= 2100
      ? next : (day !== 1 ? reference.getUTCFullYear() : null);
    if (year != null && Date.UTC(year, monthNumbers[tokens[index]], day) > referenceDay) return true;
  }

  return tokens.some((token) => /^20\d{2}$/.test(token) &&
    Number(token) > reference.getUTCFullYear());
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
  readSourcePilotDataset,
  readSourcePilotInputs,
  validateSourceRegistry,
  buildOutput,
  normalizeItem,
  normalizeSourcePilotItem,
  evaluateCandidate,
  evaluateCandidateWithAudit,
  detectTriggers,
  detectTriggersWithAudit,
  determineEvidenceStrength,
  selectPrimaryTrigger,
  determineTimingStatus,
  isPublishedDateStale,
  hasExplicitFutureDate,
  selectSuggestedAction,
  buildTriggerSummary,
  validateOutput,
  findCrossCorpusDuplicate,
  normalizeOfficialUrl,
  stableItemId,
  normalizeSearchText,
  writeJsonAtomic,
};

if (require.main === module) main();
