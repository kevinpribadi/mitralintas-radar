#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const STATUS = Object.freeze({ REVIEW: "REVIEW_REQUIRED", REJECT: "REJECT_PROPOSAL", NONE: "NO_MATERIAL_CHANGE" });

function buildReportModel(sourceDiff, triggerDiff, options = {}) {
  const sourceValidation = sourceDiff && sourceDiff.validation || {};
  const triggerValidation = triggerDiff && triggerDiff.validation || {};
  const sourceErrors = strings(sourceValidation.errors);
  const triggerErrors = strings(triggerValidation.errors);
  const warnings = unique(strings(sourceValidation.warnings).concat(strings(triggerValidation.warnings), strings(options.extraWarnings)));
  const errors = unique(sourceErrors.concat(triggerErrors, strings(options.extraErrors)));
  const triggerSummary = triggerDiff && triggerDiff.summary || {};
  const hasProductionChange = Number(triggerSummary.production_semantic_change_count) > 0;
  const materialCount = sum([
    sourceDiff && sourceDiff.added_count, sourceDiff && sourceDiff.removed_count,
    sourceDiff && sourceDiff.changed_count, triggerSummary.new_official_pilot_signal_count,
    triggerSummary.removed_official_pilot_signal_count, triggerSummary.classification_change_count,
    triggerSummary.timing_change_count, triggerSummary.evidence_change_count,
  ]);
  let status = STATUS.REVIEW;
  if (errors.length || sourceValidation.proposal_eligible === false ||
      triggerValidation.proposal_eligible === false || hasProductionChange) status = STATUS.REJECT;
  else if (materialCount === 0) status = STATUS.NONE;

  const oldTriggerById = triggerIndex(options.committedTrigger);
  const newTriggerById = triggerIndex(options.proposedTrigger);
  const sourceName = firstSourceName(sourceDiff);
  const summary = {
    old_total: number(sourceDiff && sourceDiff.old_total),
    new_total: number(sourceDiff && sourceDiff.new_total),
    added_count: number(sourceDiff && sourceDiff.added_count),
    removed_count: number(sourceDiff && sourceDiff.removed_count),
    changed_count: number(sourceDiff && sourceDiff.changed_count),
    unchanged_count: number(sourceDiff && sourceDiff.unchanged_count),
    valid_item_count: number(sourceValidation.valid_item_count),
    invalid_item_count: number(sourceValidation.invalid_item_count),
    duplicate_count: number(sourceValidation.duplicate_count),
    missing_date_count: number(sourceValidation.missing_date_count),
    missing_organization_count: number(sourceValidation.missing_organization_count),
    provenance_completeness_percent: number(sourceValidation.provenance_completeness_percent),
    valid_link_percent: number(sourceValidation.valid_link_percent),
    new_trigger_count: number(triggerSummary.new_official_pilot_signal_count),
    removed_trigger_count: number(triggerSummary.removed_official_pilot_signal_count),
    classification_change_count: number(triggerSummary.classification_change_count),
    timing_change_count: number(triggerSummary.timing_change_count),
    evidence_change_count: number(triggerSummary.evidence_change_count),
    production_change_count: number(triggerSummary.production_semantic_change_count),
  };

  return {
    schema_version: "1.0.0",
    source_code: sourceDiff && sourceDiff.source_code || "BKPM_PRESS_RELEASES",
    source_name: sourceName,
    reference_date: sourceDiff && sourceDiff.reference_date || "",
    status,
    summary,
    source_health: sourceDiff && sourceDiff.proposed_health || {},
    added_items: (sourceDiff && sourceDiff.added || []).map((item) => reportItem(item, newTriggerById.get(item.id), "ADDED")),
    removed_items: (sourceDiff && sourceDiff.removed || []).map((item) => reportItem(item, oldTriggerById.get(item.id), "REMOVED")),
    changed_items: (sourceDiff && sourceDiff.changed || []).map((change) => {
      const item = reportItem(change.new_item || change.old_item || {}, newTriggerById.get(change.id), "CHANGED");
      item.change_reasons = strings(change.reasons);
      item.detail = safeDetail({ changed_fields: change.changed_fields, reasons: change.reasons,
        old: change.old_item, proposed: change.new_item });
      return item;
    }),
    new_triggers: (triggerDiff && triggerDiff.new_official_pilot_signals || []).map((item) => reportTrigger(item)),
    classification_changes: clone(triggerDiff && triggerDiff.classification_changes || []),
    timing_changes: clone(triggerDiff && triggerDiff.timing_changes || []),
    evidence_changes: clone(triggerDiff && triggerDiff.evidence_changes || []),
    warnings,
    errors,
  };
}

function reportItem(item, trigger, changeType) {
  const hint = item.classification_hint || {};
  const evidence = triggerEvidence(trigger);
  return {
    id: item.id || "", title: item.title || "", published_at: item.published_at || "",
    source_code: item.source_code || "BKPM_PRESS_RELEASES", source_name: item.source_name || "",
    organization_hint: item.organization_hint || "",
    classification_hint: hint.code || hint.category || hint.trigger_code || hint.label || (typeof hint === "string" ? hint : ""),
    detected_trigger: trigger && trigger.primary_trigger || "",
    timing_status: trigger && trigger.timing_status || "",
    evidence, link: item.link || item.provenance && item.provenance.detail_url || "",
    human_review_required: trigger ? trigger.human_review_required !== false : true,
    validation_status: "VALID", change_reasons: [changeType],
    detail: safeDetail({ id: item.id, provenance: item.provenance, quality: item.quality,
      excerpt: item.excerpt, trigger: trigger && trigger.primary_trigger || "" }),
  };
}

function reportTrigger(item) {
  return {
    id: item.id || "", title: item.title || "", published_at: item.published_at || "",
    source_code: item.source_code || "BKPM_PRESS_RELEASES",
    source_name: item.official_provenance && item.official_provenance.source_name || "",
    organization_hint: item.organization_hint || "", classification_hint: "",
    detected_trigger: item.primary_trigger || "", timing_status: item.timing_status || "",
    evidence: evidenceText(item.evidence), link: item.link || item.official_provenance && item.official_provenance.detail_url || "",
    human_review_required: item.human_review_required === true, validation_status: "VALID",
    change_reasons: ["NEW_TRIGGER"], detail: safeDetail(item),
  };
}

function triggerEvidence(trigger) {
  if (!trigger) return "";
  const values = [];
  (trigger.triggers || []).forEach((match) => (match.matched_evidence || []).forEach((entry) => {
    values.push(`${entry.field || "evidence"}: ${entry.term || ""} — ${entry.excerpt || ""}`);
  }));
  return values.join(" | ");
}

function evidenceText(value) {
  const values = [];
  (Array.isArray(value) ? value : []).forEach((match) => (match.matched_evidence || []).forEach((entry) => {
    values.push(`${entry.field || "evidence"}: ${entry.term || ""} — ${entry.excerpt || ""}`);
  }));
  return values.join(" | ");
}

function triggerIndex(output) {
  const result = new Map();
  const items = output && Array.isArray(output.items) ? output.items : [];
  items.filter((item) => item && item.data_origin === "official_source_pilot")
    .forEach((item) => result.set(item.id, item));
  return result;
}

function firstSourceName(sourceDiff) {
  const groups = [sourceDiff && sourceDiff.added, sourceDiff && sourceDiff.changed,
    sourceDiff && sourceDiff.unchanged, sourceDiff && sourceDiff.removed];
  for (const group of groups) {
    if (!Array.isArray(group) || !group.length) continue;
    const item = group[0].new_item || group[0].old_item || group[0];
    if (item && item.source_name) return item.source_name;
  }
  return "Kementerian Investasi dan Hilirisasi/BKPM - Siaran Pers";
}

function sourceMarkdown(model) {
  const s = model.summary;
  return `# Ringkasan Proposal Refresh Sumber\n\n` +
    `> Proposal snapshot; belum menjadi data produksi. Tidak ada penerimaan otomatis.\n\n` +
    `- Source: ${model.source_code}\n- Source status: ${model.source_health.status || "UNKNOWN"}\n` +
    `- Acceptance recommendation: **${model.status}**\n- Old item count: ${s.old_total}\n` +
    `- Proposed item count: ${s.new_total}\n- Added: ${s.added_count}\n- Removed: ${s.removed_count}\n` +
    `- Changed: ${s.changed_count}\n- Unchanged: ${s.unchanged_count}\n- Valid item count: ${s.valid_item_count}\n` +
    `- Invalid item count: ${s.invalid_item_count}\n- Duplicate count: ${s.duplicate_count}\n` +
    `- Missing date count: ${s.missing_date_count}\n- Missing organization count: ${s.missing_organization_count}\n` +
    `- Official provenance completeness: ${s.provenance_completeness_percent}%\n` +
    `- Valid official link: ${s.valid_link_percent}%\n\n## Warnings\n\n${markdownMessages(model.warnings)}\n\n` +
    `## Errors\n\n${markdownMessages(model.errors)}\n`;
}

function triggerMarkdown(model) {
  const s = model.summary;
  return `# Ringkasan Diff Trigger\n\n` +
    `> Proposed trigger output; committed trigger output tidak diubah.\n\n` +
    `- Acceptance recommendation: **${model.status}**\n- New official trigger count: ${s.new_trigger_count}\n` +
    `- Removed official trigger count: ${s.removed_trigger_count}\n` +
    `- Trigger classification changes: ${s.classification_change_count}\n- Timing changes: ${s.timing_change_count}\n` +
    `- Evidence changes: ${s.evidence_change_count}\n- Production semantic changes: ${s.production_change_count}\n` +
    `- Production gate: ${s.production_change_count === 0 ? "PASS" : "FAIL"}\n`;
}

function writeReports(model, options) {
  const outputDir = path.resolve(options.outputDir);
  const templateDir = path.resolve(options.templateDir || path.join(__dirname, "..", "templates"));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "source_snapshot_summary.md"), sourceMarkdown(model), "utf8");
  fs.writeFileSync(path.join(outputDir, "trigger_diff_summary.md"), triggerMarkdown(model), "utf8");
  fs.writeFileSync(path.join(outputDir, "source_refresh_summary.json"), JSON.stringify(model, null, 2) + "\n", "utf8");
  if (options.includeHtml !== false) {
    const template = fs.readFileSync(path.join(templateDir, "source_refresh_report.html"), "utf8");
    const embedded = safeEmbeddedJson(model);
    if (!template.includes("__REPORT_DATA__")) throw new Error("Template report tidak memiliki placeholder data.");
    fs.writeFileSync(path.join(outputDir, "source_refresh_report.html"), template.replace("__REPORT_DATA__", embedded), "utf8");
    ["source_refresh_report.css", "source_refresh_report.js"].forEach((name) =>
      fs.copyFileSync(path.join(templateDir, name), path.join(outputDir, name)));
  }
}

function safeEmbeddedJson(value) {
  return JSON.stringify(value).replace(/&/g, "\\u0026").replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function safeDetail(value) { return JSON.stringify(value || {}, null, 2).slice(0, 12000); }
function markdownMessages(values) { return values.length ? values.map((value) => `- ${value}`).join("\n") : "- Tidak ada."; }
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function sum(values) { return values.reduce((total, value) => total + number(value), 0); }
function strings(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string") : []; }
function unique(values) { return Array.from(new Set(values)).sort(); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    args[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["source-diff"] || !args["trigger-diff"] || !args["output-dir"]) {
    throw new Error("Gunakan --source-diff, --trigger-diff, dan --output-dir.");
  }
  const model = buildReportModel(readJson(args["source-diff"]), readJson(args["trigger-diff"]), {
    committedTrigger: args["committed-trigger"] ? readJson(args["committed-trigger"]) : null,
    proposedTrigger: args["proposed-trigger"] && fs.existsSync(args["proposed-trigger"])
      ? readJson(args["proposed-trigger"]) : null,
    extraErrors: args["extra-error"] ? String(args["extra-error"]).split(",") : [],
  });
  writeReports(model, {
    outputDir: args["output-dir"], templateDir: args["template-dir"],
    includeHtml: String(args["include-html"] || "true").toLowerCase() !== "false",
  });
  console.log(`Refresh report: ${model.status}`);
  return model;
}

module.exports = { STATUS, buildReportModel, sourceMarkdown, triggerMarkdown, writeReports, safeEmbeddedJson, main };

if (require.main === module) {
  try { main(); } catch (error) { console.error(`Report gagal: ${error.message}`); process.exitCode = 1; }
}
