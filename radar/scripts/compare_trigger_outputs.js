#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { stableStringify, containsNumericScore } = require("./compare_source_snapshots.js");

function compareTriggerOutputs(committed, proposed, options = {}) {
  if (options.skipped) return emptySkippedDiff();
  const oldItems = items(committed);
  const newItems = items(proposed);
  const oldPilot = index(oldItems.filter(isPilot));
  const newPilot = index(newItems.filter(isPilot));
  const newSignals = [];
  const removedSignals = [];
  const classificationChanges = [];
  const timingChanges = [];
  const evidenceChanges = [];
  const validationErrors = [];
  if (new Set(newItems.map((item) => item && item.id)).size !== newItems.length ||
      newItems.some((item) => !item || !item.id)) validationErrors.push("INVALID_OR_DUPLICATE_STABLE_ID");

  newPilot.forEach((item, id) => {
    if (!oldPilot.has(id)) {
      if (!completeOfficialProvenance(item.official_provenance)) {
        validationErrors.push(`NEW_SIGNAL_PROVENANCE_INCOMPLETE:${id}`);
      }
      if (item.human_review_required !== true) {
        validationErrors.push(`NEW_SIGNAL_HUMAN_REVIEW_REQUIRED:${id}`);
      }
      newSignals.push(pilotSignal(item));
      return;
    }
    const previous = oldPilot.get(id);
    const oldClassification = classificationSnapshot(previous);
    const newClassification = classificationSnapshot(item);
    if (stableStringify(oldClassification) !== stableStringify(newClassification)) {
      classificationChanges.push({ id, title: item.title, old: oldClassification, new: newClassification });
    }
    if (previous.timing_status !== item.timing_status) {
      timingChanges.push({
        id, title: item.title,
        old_timing_status: previous.timing_status,
        new_timing_status: item.timing_status,
      });
    }
    const oldEvidence = evidenceSnapshot(previous);
    const newEvidence = evidenceSnapshot(item);
    if (stableStringify(oldEvidence) !== stableStringify(newEvidence)) {
      evidenceChanges.push({ id, title: item.title, old: oldEvidence, new: newEvidence });
    }
  });
  oldPilot.forEach((item, id) => {
    if (!newPilot.has(id)) removedSignals.push(pilotSignal(item));
  });

  const productionChanges = productionSemanticChanges(
    oldItems.filter((item) => !isPilot(item)), newItems.filter((item) => !isPilot(item)));
  if (productionChanges.length) validationErrors.push("PRODUCTION_SEMANTIC_CHANGES_PRESENT");
  if (containsNumericScore(proposed)) validationErrors.push("NUMERIC_SCORE_FORBIDDEN");
  if (containsForbiddenAction(proposed)) validationErrors.push("FORBIDDEN_OUTREACH_ACTION");

  [newSignals, removedSignals, classificationChanges, timingChanges, evidenceChanges,
    productionChanges].forEach((values) => values.sort(compareById));
  return {
    schema_version: "1.0.0",
    skipped: false,
    new_official_pilot_signals: newSignals,
    removed_official_pilot_signals: removedSignals,
    classification_changes: classificationChanges,
    timing_changes: timingChanges,
    evidence_changes: evidenceChanges,
    production_semantic_changes: productionChanges,
    summary: {
      new_official_pilot_signal_count: newSignals.length,
      removed_official_pilot_signal_count: removedSignals.length,
      classification_change_count: classificationChanges.length,
      timing_change_count: timingChanges.length,
      evidence_change_count: evidenceChanges.length,
      production_semantic_change_count: productionChanges.length,
      production_stable_ids_unchanged: !productionChanges.some((change) =>
        change.change_type === "ADDED" || change.change_type === "REMOVED"),
    },
    validation: {
      proposal_eligible: validationErrors.length === 0,
      warnings: [],
      errors: unique(validationErrors).sort(),
    },
  };
}

function productionSemanticChanges(oldItems, newItems) {
  const oldById = index(oldItems);
  const newById = index(newItems);
  const changes = [];
  newById.forEach((item, id) => {
    if (!oldById.has(id)) {
      changes.push({ id, title: item.title, change_type: "ADDED" });
      return;
    }
    const oldSemantic = productionSemanticSnapshot(oldById.get(id));
    const newSemantic = productionSemanticSnapshot(item);
    if (stableStringify(oldSemantic) !== stableStringify(newSemantic)) {
      changes.push({ id, title: item.title, change_type: "CHANGED", old: oldSemantic, new: newSemantic });
    }
  });
  oldById.forEach((item, id) => {
    if (!newById.has(id)) changes.push({ id, title: item.title, change_type: "REMOVED" });
  });
  return changes.sort(compareById);
}

function productionSemanticSnapshot(item) {
  return {
    id: item.id, type: item.type, title: item.title, source: item.source, link: item.link,
    date: item.date, organization: item.organization,
    triggers: normalizedTriggers(item.triggers), primary_trigger: item.primary_trigger,
    timing_status: item.timing_status, suggested_next_action: item.suggested_next_action,
    human_review_required: item.human_review_required,
  };
}

function classificationSnapshot(item) {
  return {
    primary_trigger: item.primary_trigger || "",
    triggers: normalizedTriggers(item.triggers).map((trigger) => ({
      trigger_code: trigger.trigger_code,
      trigger_class: trigger.trigger_class,
      evidence_strength: trigger.evidence_strength,
    })),
  };
}

function evidenceSnapshot(item) {
  return normalizedTriggers(item.triggers).map((trigger) => ({
    trigger_code: trigger.trigger_code,
    matched_terms: trigger.matched_terms,
    matched_evidence: trigger.matched_evidence,
    evidence_excerpt: trigger.evidence_excerpt,
  }));
}

function normalizedTriggers(value) {
  return (Array.isArray(value) ? value : []).map((trigger) => ({
    trigger_code: trigger.trigger_code || "", trigger_label: trigger.trigger_label || "",
    trigger_class: trigger.trigger_class || "", evidence_strength: trigger.evidence_strength || "",
    matched_terms: stringArray(trigger.matched_terms),
    matched_evidence: (Array.isArray(trigger.matched_evidence) ? trigger.matched_evidence : [])
      .map((entry) => ({ term: entry.term || "", field: entry.field || "", excerpt: entry.excerpt || "" }))
      .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
    evidence_excerpt: trigger.evidence_excerpt || "",
    product_hypotheses: stringArray(trigger.product_hypotheses),
    human_review_required: trigger.human_review_required === true,
  })).sort((a, b) => a.trigger_code.localeCompare(b.trigger_code));
}

function pilotSignal(item) {
  return {
    id: item.id || "", title: item.title || "", source_code: item.source_code || "",
    published_at: item.date || item.official_provenance && item.official_provenance.published_at || "",
    organization_hint: item.organization || "", primary_trigger: item.primary_trigger || "",
    timing_status: item.timing_status || "", official_provenance: clone(item.official_provenance || null),
    evidence: evidenceSnapshot(item), human_review_required: item.human_review_required === true,
    link: item.link || item.official_provenance && item.official_provenance.detail_url || "",
  };
}

function completeOfficialProvenance(value) {
  return value && typeof value === "object" &&
    ["source_name", "official_domain", "detail_url", "published_at", "retrieval_method"]
      .every((field) => typeof value[field] === "string" && value[field].trim()) &&
    value.retrieval_method === "static_html";
}

function containsForbiddenAction(value, key = "") {
  if (typeof value === "string") {
    return /(?:outreach|contact|send[_ -]?(?:email|whatsapp)|set[_ -]?price)/i.test(value) &&
      /action|next_action|outreach|contact/i.test(key);
  }
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some((childKey) =>
    /(?:outreach_action|contact_action|send_email|send_whatsapp|set_price)/i.test(childKey) ||
    containsForbiddenAction(value[childKey], childKey));
}

function emptySkippedDiff(rejectSkipped = false) {
  return {
    schema_version: "1.0.0", skipped: true,
    new_official_pilot_signals: [], removed_official_pilot_signals: [],
    classification_changes: [], timing_changes: [], evidence_changes: [],
    production_semantic_changes: [],
    summary: {
      new_official_pilot_signal_count: 0, removed_official_pilot_signal_count: 0,
      classification_change_count: 0, timing_change_count: 0, evidence_change_count: 0,
      production_semantic_change_count: 0, production_stable_ids_unchanged: true,
    },
    validation: rejectSkipped
      ? { proposal_eligible: false, warnings: [], errors: ["TRIGGER_BUILD_FAILED_OR_SOURCE_REJECTED"] }
      : { proposal_eligible: true, warnings: ["TRIGGER_BUILD_SKIPPED"], errors: [] },
  };
}

function isPilot(item) { return item && item.data_origin === "official_source_pilot"; }
function items(output) { return output && Array.isArray(output.items) ? output.items : []; }
function index(values) { return new Map(values.map((item) => [item.id, item])); }
function stringArray(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string").sort() : []; }
function compareById(a, b) { return String(a.id || "").localeCompare(String(b.id || "")); }
function unique(values) { return Array.from(new Set(values)); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    args[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return args;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.output) throw new Error("Gunakan --output.");
  let result;
  if (args.skipped) result = emptySkippedDiff(Boolean(args["reject-skipped"]));
  else {
    if (!args.old || !args.new) throw new Error("Gunakan --old dan --new.");
    result = compareTriggerOutputs(readJson(args.old), readJson(args.new));
  }
  writeJson(args.output, result);
  console.log(`Trigger diff: +${result.summary.new_official_pilot_signal_count} ` +
    `-${result.summary.removed_official_pilot_signal_count} ` +
    `production=${result.summary.production_semantic_change_count}`);
  if (args.strict && !result.validation.proposal_eligible) process.exitCode = 2;
  return result;
}

module.exports = {
  compareTriggerOutputs, productionSemanticChanges, productionSemanticSnapshot,
  classificationSnapshot, evidenceSnapshot, normalizedTriggers, completeOfficialProvenance,
  containsForbiddenAction, emptySkippedDiff, main,
};

if (require.main === module) {
  try { main(); } catch (error) { console.error(`Trigger diff gagal: ${error.message}`); process.exitCode = 1; }
}
