#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const STATUS = Object.freeze({ REVIEW: "REVIEW_REQUIRED", REJECT: "REJECT_PROPOSAL", NONE: "NO_MATERIAL_CHANGE" });
const DEFAULT_MINIMUM_DATE_COMPLETENESS_PERCENT = 70;

function buildReportModel(sourceDiff, triggerDiff, options = {}) {
  const sourceFetchFailed = !!(sourceDiff && sourceDiff.source_fetch_failed);
  const sourceValidation = sourceDiff && sourceDiff.validation || {};
  const triggerValidation = triggerDiff && triggerDiff.validation || {};
  const minimumDateCompletenessPercent = boundedPercent(
    options.minimumDateCompletenessPercent, DEFAULT_MINIMUM_DATE_COMPLETENESS_PERCENT);
  const metadataQuality = assessMetadataQuality(sourceFetchFailed ? [] : proposedSourceItems(sourceDiff),
    minimumDateCompletenessPercent);
  const sourceErrors = normalizeSourceErrors(sourceValidation.errors, metadataQuality);
  const triggerErrors = strings(triggerValidation.errors);
  const warnings = unique(normalizeSourceWarnings(sourceValidation.warnings, metadataQuality)
    .concat(strings(triggerValidation.warnings), strings(options.extraWarnings)));
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
  if (errors.length || triggerValidation.proposal_eligible === false || hasProductionChange) status = STATUS.REJECT;
  else if (materialCount === 0 && warnings.length === 0) status = STATUS.NONE;

  const oldTriggerById = triggerIndex(options.committedTrigger);
  const newTriggerById = triggerIndex(options.proposedTrigger);
  const sourceName = firstSourceName(sourceDiff);
  const proposedTotal = sourceFetchFailed ? 0 : number(sourceDiff && sourceDiff.new_total);
  const invalidItemCount = Math.max(number(sourceValidation.invalid_item_count), metadataQuality.invalid_item_count);
  const summary = {
    baseline_total: number(sourceDiff && (sourceDiff.baseline_total ?? sourceDiff.old_total)),
    proposed_total: sourceFetchFailed ? null : number(sourceDiff &&
      (sourceDiff.proposed_total ?? sourceDiff.new_total)),
    source_fetch_failed: sourceFetchFailed,
    old_total: number(sourceDiff && sourceDiff.old_total),
    new_total: sourceFetchFailed ? null : number(sourceDiff && sourceDiff.new_total),
    added_count: number(sourceDiff && sourceDiff.added_count),
    removed_count: number(sourceDiff && sourceDiff.removed_count),
    changed_count: number(sourceDiff && sourceDiff.changed_count),
    unchanged_count: number(sourceDiff && sourceDiff.unchanged_count),
    valid_item_count: Math.max(0, proposedTotal - invalidItemCount),
    invalid_item_count: invalidItemCount,
    duplicate_count: number(sourceValidation.duplicate_count),
    missing_date_count: metadataQuality.missing_date_count,
    missing_organization_count: metadataQuality.missing_organization_count,
    invalid_date_count: metadataQuality.invalid_date_count,
    invalid_organization_count: metadataQuality.invalid_organization_count,
    date_completeness_percent: metadataQuality.date_completeness_percent,
    minimum_date_completeness_percent: minimumDateCompletenessPercent,
    provenance_completeness_percent: number(sourceValidation.provenance_completeness_percent),
    valid_link_percent: number(sourceValidation.valid_link_percent),
    new_trigger_count: number(triggerSummary.new_official_pilot_signal_count),
    removed_trigger_count: number(triggerSummary.removed_official_pilot_signal_count),
    classification_change_count: number(triggerSummary.classification_change_count),
    timing_change_count: number(triggerSummary.timing_change_count),
    evidence_change_count: number(triggerSummary.evidence_change_count),
    production_change_count: number(triggerSummary.production_semantic_change_count),
    production_unchanged: number(triggerSummary.production_semantic_change_count) === 0,
  };

  const proposedHealth = sourceDiff && sourceDiff.proposed_health || {};

  return {
    schema_version: "1.0.0",
    source_code: sourceDiff && sourceDiff.source_code || "BKPM_PRESS_RELEASES",
    source_name: sourceName,
    reference_date: sourceDiff && sourceDiff.reference_date || "",
    status,
    comparison_status: sourceDiff && sourceDiff.comparison_status || "COMPARED",
    comparison_skipped_reason: sourceDiff && sourceDiff.comparison_skipped_reason || "",
    source_fetch_failed: sourceFetchFailed,
    fetch_error_code: proposedHealth.error_code || "",
    fetch_status: proposedHealth.fetch_status || (sourceFetchFailed ? "LIVE_FETCH_FAILED" : "LIVE_FETCH_SUCCEEDED"),
    fetched_sources: proposedHealth.source_code ? [proposedHealth.source_code] : [],
    rejected_sources_excluded: ["KEMENPERIN_IMC_NEWS"],
    error: sourceDiff && sourceDiff.error || "",
    summary,
    source_health: proposedHealth,
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
  const metadata = assessItemMetadata(item);
  const validationMessages = unique(metadata.warnings.concat(metadata.errors, ["HUMAN_REVIEW_REQUIRED"]));
  return {
    id: item.id || "", title: item.title || "", published_at: item.published_at || "",
    source_code: item.source_code || "BKPM_PRESS_RELEASES", source_name: item.source_name || "",
    organization_hint: item.organization_hint || "",
    classification_hint: hint.code || hint.category || hint.trigger_code || hint.label || (typeof hint === "string" ? hint : ""),
    detected_trigger: trigger && trigger.primary_trigger || "",
    timing_status: trigger && trigger.timing_status || "",
    evidence, link: item.link || item.provenance && item.provenance.detail_url || "",
    human_review_required: true,
    validation_status: metadata.errors.length ? "ERROR" : "WARNING",
    validation_messages: validationMessages,
    timing_verification_required: metadata.warnings.includes("PUBLISHED_DATE_MISSING"),
    change_reasons: [changeType],
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
    human_review_required: true, validation_status: "WARNING",
    validation_messages: ["HUMAN_REVIEW_REQUIRED"],
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

function proposedSourceItems(sourceDiff) {
  if (!sourceDiff || typeof sourceDiff !== "object") return [];
  const items = [];
  stringsOrObjects(sourceDiff.added).forEach((item) => items.push(item));
  stringsOrObjects(sourceDiff.unchanged).forEach((item) => items.push(item));
  stringsOrObjects(sourceDiff.changed).forEach((change) => {
    if (change && change.new_item) items.push(change.new_item);
  });
  return items.filter((item) => item && typeof item === "object");
}

function assessMetadataQuality(items, minimumDateCompletenessPercent = DEFAULT_MINIMUM_DATE_COMPLETENESS_PERCENT) {
  const warnings = [];
  const errors = [];
  const invalidIds = new Set();
  let missingDateCount = 0;
  let missingOrganizationCount = 0;
  let invalidDateCount = 0;
  let invalidOrganizationCount = 0;
  let validDateCount = 0;
  items.forEach((item) => {
    const result = assessItemMetadata(item);
    if (result.warnings.includes("PUBLISHED_DATE_MISSING")) missingDateCount += 1;
    if (result.warnings.includes("ORGANIZATION_MISSING")) missingOrganizationCount += 1;
    if (result.date_valid) validDateCount += 1;
    if (result.errors.some((code) => code.startsWith("PUBLISHED_DATE_"))) invalidDateCount += 1;
    if (result.errors.some((code) => code.startsWith("ORGANIZATION_"))) invalidOrganizationCount += 1;
    if (result.errors.length) invalidIds.add(item.id || "unknown");
    warnings.push(...result.warnings);
    errors.push(...result.errors.map((code) => `${code}:${item.id || "unknown"}`));
  });
  const dateCompletenessPercent = items.length
    ? Number(((validDateCount / items.length) * 100).toFixed(2)) : 0;
  if (items.length && dateCompletenessPercent < minimumDateCompletenessPercent) {
    errors.push("DATE_COMPLETENESS_BELOW_THRESHOLD");
  }
  return {
    warnings: unique(warnings), errors: unique(errors),
    missing_date_count: missingDateCount,
    missing_organization_count: missingOrganizationCount,
    invalid_date_count: invalidDateCount,
    invalid_organization_count: invalidOrganizationCount,
    valid_date_count: validDateCount,
    date_completeness_percent: dateCompletenessPercent,
    minimum_date_completeness_percent: minimumDateCompletenessPercent,
    invalid_item_count: invalidIds.size,
  };
}

function assessItemMetadata(item) {
  const quality = item && item.quality && typeof item.quality === "object" ? item.quality : {};
  const provenance = item && item.provenance && typeof item.provenance === "object" ? item.provenance : {};
  const warnings = [];
  const errors = [];
  const organization = text(item && item.organization_hint);
  const organizationStatus = text(quality.organization_status).toLowerCase();
  const organizationSource = text(quality.organization_source || provenance.organization_source).toLowerCase();
  const sourceName = text(item && item.source_name);
  const sourceText = normalize(`${text(item && item.title)} ${text(item && item.excerpt)}`);

  if (organizationStatus === "fabricated" || /publisher|inferen|runtime|generated|assum/.test(organizationSource)) {
    errors.push("ORGANIZATION_FABRICATION_DETECTED");
  } else if (!organization && ["", "missing", "unknown"].includes(organizationStatus)) warnings.push("ORGANIZATION_MISSING");
  else if (!organization) errors.push("ORGANIZATION_INVALID");
  else if (normalize(organization) === normalize(sourceName) ||
      /^(bkpm|kementerian investasi dan hilirisasi(?:\/bkpm)?)/i.test(organization)) {
    errors.push("ORGANIZATION_FABRICATION_DETECTED");
  } else if (organizationStatus !== "explicit") errors.push("ORGANIZATION_INVALID");
  else if (!sourceText.includes(normalize(organization))) errors.push("ORGANIZATION_FABRICATION_DETECTED");

  const publishedAt = text(item && item.published_at);
  const dateStatus = text(quality.date_status).toLowerCase();
  const dateSource = text(quality.date_source || quality.published_at_source || provenance.published_at_source).toLowerCase();
  let dateValid = false;
  if (dateStatus === "fabricated" || /retrieval|runtime|generated|inferen/.test(dateSource)) {
    errors.push("PUBLISHED_DATE_FABRICATION_DETECTED");
  } else if (!publishedAt && dateStatus === "missing") warnings.push("PUBLISHED_DATE_MISSING");
  else if (!publishedAt) errors.push("PUBLISHED_DATE_INVALID");
  else if (dateStatus !== "valid" || !isStrictIsoDate(publishedAt)) errors.push("PUBLISHED_DATE_INVALID");
  else dateValid = true;

  const excerptStatus = text(quality.excerpt_status).toLowerCase();
  const excerptSource = text(quality.excerpt_source || provenance.excerpt_source).toLowerCase();
  if (excerptStatus === "fabricated" || /retrieval|runtime|generated|inferen/.test(excerptSource)) {
    errors.push("EXCERPT_FABRICATION_DETECTED");
  }
  const hint = item && item.classification_hint;
  const hintCode = typeof hint === "string" ? hint : text(hint && (hint.code || hint.category || hint.trigger_code));
  if (!hintCode || /^UNKNOWN$/i.test(hintCode)) warnings.push("CLASSIFICATION_HINT_UNKNOWN");
  return { warnings: unique(warnings), errors: unique(errors), date_valid: dateValid };
}

function normalizeSourceWarnings(rawWarnings, metadataQuality) {
  return strings(rawWarnings).filter((warning) =>
    !/^MISSING_(?:DATE|ORGANIZATION):/i.test(warning)).concat(metadataQuality.warnings);
}

function normalizeSourceErrors(rawErrors, metadataQuality) {
  return strings(rawErrors).filter((error) =>
    !/^(?:ORGANIZATION_HINT_UNVERIFIED|DATE_UNVERIFIED_OR_FABRICATED):/i.test(error))
    .concat(metadataQuality.errors);
}

function isStrictIsoDate(value) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function sourceMarkdown(model) {
  const s = model.summary;
  const tlsVerification = model.source_health.tls_trust_mode === "SYSTEM_CA"
    ? "TLS verification remained enabled using the operating system CA store."
    : "TLS verification remained enabled using the Node bundled CA store.";
  return `# Ringkasan Proposal Refresh Sumber\n\n` +
    `> Proposal snapshot; belum menjadi data produksi. Tidak ada penerimaan otomatis.\n\n` +
    `- Source: ${model.source_code}\n- Source status: ${model.source_health.status || "UNKNOWN"}\n` +
    `- Source fetched: ${model.fetched_sources.join(", ") || "NONE"}\n` +
    `- Rejected source excluded: ${model.rejected_sources_excluded.join(", ")}\n` +
    `- Live fetch status: ${model.fetch_status}\n` +
    `- TLS trust mode: ${model.source_health.tls_trust_mode || "NODE_BUNDLED_CA"}\n` +
    `- ${tlsVerification}\n` +
    `- Acceptance recommendation: **${model.status}**\n- Comparison status: ${model.comparison_status}\n` +
    `- Baseline item count: ${s.baseline_total}\n- Proposed item count: ${s.proposed_total}\n` +
    `- Source fetch failed: ${s.source_fetch_failed}\n- Added: ${s.added_count}\n- Removed: ${s.removed_count}\n` +
    `- Changed: ${s.changed_count}\n- Unchanged: ${s.unchanged_count}\n- Valid item count: ${s.valid_item_count}\n` +
    `- Invalid item count: ${s.invalid_item_count}\n- Duplicate count: ${s.duplicate_count}\n` +
    `- Missing date count: ${s.missing_date_count}\n- Missing organization count: ${s.missing_organization_count}\n` +
    `- Invalid date count: ${s.invalid_date_count}\n- Invalid organization count: ${s.invalid_organization_count}\n` +
    `- Date completeness: ${s.date_completeness_percent}%\n` +
    `- Minimum date completeness: ${s.minimum_date_completeness_percent}%\n` +
    `- Official provenance completeness: ${s.provenance_completeness_percent}%\n` +
    `- Valid official link: ${s.valid_link_percent}%\n` +
    `- Production unchanged: ${s.production_unchanged}\n\n## Warnings\n\n${markdownMessages(model.warnings)}\n\n` +
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
function boundedPercent(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function normalize(value) { return text(value).toLowerCase().replace(/\s+/g, " "); }
function sum(values) { return values.reduce((total, value) => total + number(value), 0); }
function strings(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string") : []; }
function stringsOrObjects(value) { return Array.isArray(value) ? value : []; }
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
    minimumDateCompletenessPercent: args["minimum-date-completeness-percent"] ||
      process.env.RADAR_SOURCE_MINIMUM_DATE_COMPLETENESS_PERCENT,
  });
  writeReports(model, {
    outputDir: args["output-dir"], templateDir: args["template-dir"],
    includeHtml: String(args["include-html"] || "true").toLowerCase() !== "false",
  });
  console.log(`Refresh report: ${model.status}`);
  return model;
}

module.exports = {
  STATUS, DEFAULT_MINIMUM_DATE_COMPLETENESS_PERCENT, buildReportModel, assessMetadataQuality,
  assessItemMetadata, proposedSourceItems, sourceMarkdown, triggerMarkdown, writeReports,
  safeEmbeddedJson, main,
};

if (require.main === module) {
  try { main(); } catch (error) { console.error(`Report gagal: ${error.message}`); process.exitCode = 1; }
}
