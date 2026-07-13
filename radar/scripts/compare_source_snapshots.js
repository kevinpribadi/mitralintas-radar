#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ALLOWED_SOURCE = "BKPM_PRESS_RELEASES";
const CHANGE_RULES = [
  { reason: "CONTENT_CHANGED", fields: ["title", "excerpt", "content_hash"] },
  { reason: "DATE_CHANGED", fields: ["published_at"] },
  { reason: "LINK_CHANGED", fields: ["link"] },
  { reason: "QUALITY_CHANGED", fields: ["quality"] },
  { reason: "PROVENANCE_CHANGED", fields: ["provenance"] },
  { reason: "ORGANIZATION_HINT_CHANGED", fields: ["organization_hint"] },
  { reason: "CLASSIFICATION_HINT_CHANGED", fields: ["classification_hint"] },
];

function compareSourceSnapshots(oldSnapshot, proposedSnapshot, options = {}) {
  const sourceCode = options.sourceCode || ALLOWED_SOURCE;
  const oldItems = validItems(oldSnapshot);
  const newItems = validItems(proposedSnapshot);
  const oldById = new Map(oldItems.map((item) => [item.id, item]));
  const newById = new Map(newItems.map((item) => [item.id, item]));
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  newById.forEach((item, id) => {
    if (!oldById.has(id)) {
      added.push(snapshotItem(item));
      return;
    }
    const previous = oldById.get(id);
    const details = changedDetails(previous, item);
    if (details.reasons.length) {
      changed.push({
        id,
        title: text(item.title) || text(previous.title),
        changed_fields: details.fields,
        reasons: details.reasons,
        old_item: snapshotItem(previous),
        new_item: snapshotItem(item),
      });
    } else {
      unchanged.push(snapshotItem(item));
    }
  });
  oldById.forEach((item, id) => {
    if (!newById.has(id)) removed.push(snapshotItem(item));
  });

  [added, removed, changed, unchanged].forEach((items) => items.sort(compareItems));
  const validation = validateProposal(oldSnapshot, proposedSnapshot, options);
  return {
    schema_version: "1.0.0",
    source_code: sourceCode,
    reference_date: text(proposedSnapshot && proposedSnapshot.content_reference_date),
    old_total: oldItems.length,
    new_total: newItems.length,
    added_count: added.length,
    removed_count: removed.length,
    changed_count: changed.length,
    unchanged_count: unchanged.length,
    added,
    removed,
    changed,
    unchanged,
    source_health_changed: stableStringify(healthSummary(options.oldHealth, sourceCode)) !==
      stableStringify(healthSummary(options.proposedHealth, sourceCode)),
    old_health: healthSummary(options.oldHealth, options.sourceCode || ALLOWED_SOURCE),
    proposed_health: healthSummary(options.proposedHealth, options.sourceCode || ALLOWED_SOURCE),
    validation,
  };
}

function validateProposal(oldSnapshot, proposedSnapshot, options = {}) {
  const errors = [];
  const warnings = [];
  const items = validItems(proposedSnapshot);
  const summary = proposedSnapshot && proposedSnapshot.source_summary || {};
  const sourceCode = options.sourceCode || ALLOWED_SOURCE;
  const requestedMax = boundedInteger(options.requestedMaxItems, 1, 50, 25);
  const reasonableMinimum = Math.max(1, Math.min(5, requestedMax,
    Math.max(1, validItems(oldSnapshot).length)));
  const proposedHealth = healthSummary(options.proposedHealth, sourceCode);
  let validLinkCount = 0;
  let provenanceCompleteCount = 0;
  let missingDateCount = 0;
  let missingOrganizationCount = 0;
  let invalidItemCount = 0;

  if (!proposedSnapshot || typeof proposedSnapshot !== "object" || Array.isArray(proposedSnapshot)) {
    errors.push("PROPOSED_SNAPSHOT_INVALID");
  }
  if (!items.length) errors.push("PROPOSED_OUTPUT_EMPTY");
  if (items.length < reasonableMinimum) errors.push("VALID_ITEM_COUNT_BELOW_MINIMUM");
  if (new Set(items.map((item) => item.id)).size !== items.length) errors.push("DUPLICATE_STABLE_ID");
  if (Number(summary.normalized_items) !== items.length) errors.push("NORMALIZED_COUNT_MISMATCH");
  if (Number(summary.invalid_items) > 0) errors.push("INVALID_ITEMS_PRESENT");
  if (Number(summary.raw_items) > 0 && Number(summary.duplicate_items) /
      Number(summary.raw_items) > 0.5) errors.push("DUPLICATE_RATE_ABNORMAL");

  items.forEach((item) => {
    let itemInvalid = false;
    if (item.source_code !== sourceCode || item.source_code === "KEMENPERIN_IMC_NEWS") {
      errors.push(`SOURCE_NOT_ACCEPTED:${text(item.id) || "unknown"}`);
      itemInvalid = true;
    }
    if (isValidOfficialLink(item.link, item.provenance, sourceCode)) validLinkCount += 1;
    else {
      errors.push(`OFFICIAL_LINK_INVALID:${text(item.id) || "unknown"}`);
      itemInvalid = true;
    }
    if (completeProvenance(item.provenance)) provenanceCompleteCount += 1;
    else {
      errors.push(`PROVENANCE_INCOMPLETE:${text(item.id) || "unknown"}`);
      itemInvalid = true;
    }
    if (!text(item.published_at)) missingDateCount += 1;
    else if (!/^20\d{2}-\d{2}-\d{2}$/.test(item.published_at) ||
        !Number.isFinite(Date.parse(item.published_at + "T00:00:00Z")) ||
        !item.quality || item.quality.date_status !== "valid") {
      errors.push(`DATE_UNVERIFIED_OR_FABRICATED:${text(item.id) || "unknown"}`);
      itemInvalid = true;
    }
    if (!text(item.organization_hint)) missingOrganizationCount += 1;
    else if (!item.quality || item.quality.organization_status !== "explicit" ||
        normalize(item.organization_hint) === normalize(item.source_name) ||
        /^(bkpm|kementerian investasi dan hilirisasi(?:\/bkpm)?)/i.test(item.organization_hint)) {
      errors.push(`ORGANIZATION_HINT_UNVERIFIED:${text(item.id) || "unknown"}`);
      itemInvalid = true;
    }
    if (!text(item.title) || !text(item.excerpt) || !item.quality ||
        item.quality.title_valid !== true || item.quality.link_valid !== true ||
        item.quality.excerpt_status !== "available") {
      errors.push(`SOURCE_FIELDS_INCOMPLETE:${text(item.id) || "unknown"}`);
      itemInvalid = true;
    }
    if (containsNumericScore(item)) {
      errors.push(`NUMERIC_SCORE_FORBIDDEN:${text(item.id) || "unknown"}`);
      itemInvalid = true;
    }
    if (itemInvalid) invalidItemCount += 1;
  });

  if (items.some((item) => item.source_code === "KEMENPERIN_IMC_NEWS")) {
    errors.push("KEMENPERIN_ITEM_FORBIDDEN");
  }
  if (!proposedHealth) errors.push("PROPOSED_HEALTH_MISSING");
  else {
    if (!["HEALTHY", "DEGRADED"].includes(proposedHealth.status)) {
      errors.push(`SOURCE_HEALTH_UNACCEPTABLE:${proposedHealth.status || "UNKNOWN"}`);
    }
    if (proposedHealth.http_status !== 200) errors.push("SOURCE_HTTP_NOT_200");
    if (!/^text\/html\b/i.test(proposedHealth.content_type || "")) errors.push("SOURCE_NOT_HTML");
    if ((proposedHealth.errors || []).length) errors.push("SOURCE_HEALTH_HAS_ERRORS");
  }
  if (missingDateCount) warnings.push(`MISSING_DATE:${missingDateCount}`);
  if (missingOrganizationCount) warnings.push(`MISSING_ORGANIZATION:${missingOrganizationCount}`);
  if (Number(summary.duplicate_items) > 0) warnings.push(`DUPLICATES_REMOVED:${summary.duplicate_items}`);

  return {
    proposal_eligible: unique(errors).length === 0,
    reasonable_minimum_valid_items: reasonableMinimum,
    valid_item_count: Math.max(0, items.length - invalidItemCount),
    invalid_item_count: invalidItemCount,
    duplicate_count: Number(summary.duplicate_items) || 0,
    missing_date_count: missingDateCount,
    missing_organization_count: missingOrganizationCount,
    valid_link_count: validLinkCount,
    valid_link_percent: percent(validLinkCount, items.length),
    provenance_complete_count: provenanceCompleteCount,
    provenance_completeness_percent: percent(provenanceCompleteCount, items.length),
    warnings: unique(warnings).sort(),
    errors: unique(errors).sort(),
  };
}

function changedDetails(oldItem, newItem) {
  const fields = [];
  const reasons = [];
  CHANGE_RULES.forEach((rule) => {
    const changedFields = rule.fields.filter((field) =>
      stableStringify(oldItem[field]) !== stableStringify(newItem[field]));
    if (changedFields.length) {
      reasons.push(rule.reason);
      fields.push(...changedFields);
    }
  });
  return { fields: unique(fields).sort(), reasons: unique(reasons).sort() };
}

function snapshotItem(item) {
  return {
    id: text(item.id), source_code: text(item.source_code), source_name: text(item.source_name),
    title: text(item.title), link: text(item.link), published_at: text(item.published_at),
    organization_hint: text(item.organization_hint), excerpt: text(item.excerpt).slice(0, 500),
    provenance: clone(item.provenance || null), quality: clone(item.quality || null),
    classification_hint: clone(item.classification_hint || null), content_hash: text(item.content_hash),
  };
}

function healthSummary(health, sourceCode) {
  if (!health || !Array.isArray(health.sources)) return null;
  const source = health.sources.find((entry) => entry && entry.source_code === sourceCode);
  if (!source) return null;
  return {
    source_code: text(source.source_code), status: text(source.status),
    http_status: Number(source.http_status) || 0, content_type: text(source.content_type),
    listing_links_found: Number(source.listing_links_found) || 0,
    detail_pages_attempted: Number(source.detail_pages_attempted) || 0,
    valid_items: Number(source.valid_items) || 0, invalid_items: Number(source.invalid_items) || 0,
    warnings: stringArray(source.warnings), errors: stringArray(source.errors),
  };
}

function completeProvenance(value) {
  return value && typeof value === "object" &&
    ["listing_url", "detail_url", "official_domain", "retrieval_method"]
      .every((field) => text(value[field])) && value.retrieval_method === "static_html";
}

function isValidOfficialLink(link, provenance, sourceCode) {
  if (sourceCode !== ALLOWED_SOURCE || !completeProvenance(provenance)) return false;
  try {
    const parsed = new URL(link);
    const detail = new URL(provenance.detail_url);
    return parsed.protocol === "https:" && detail.protocol === "https:" &&
      parsed.hostname === "www.bkpm.go.id" && detail.hostname === "www.bkpm.go.id" &&
      parsed.pathname.startsWith("/id/info/siaran-pers/") &&
      detail.pathname.startsWith("/id/info/siaran-pers/") &&
      provenance.official_domain === "www.bkpm.go.id";
  } catch (_) { return false; }
}

function containsNumericScore(value) {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some((key) =>
    (/score/i.test(key) && typeof value[key] === "number") || containsNumericScore(value[key]));
}

function validItems(snapshot) {
  return snapshot && Array.isArray(snapshot.items)
    ? snapshot.items.filter((item) => item && typeof item === "object" && text(item.id)) : [];
}
function compareItems(a, b) { return text(a.id).localeCompare(text(b.id)) || text(a.title).localeCompare(text(b.title)); }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function normalize(value) { return text(value).toLowerCase().replace(/\s+/g, " "); }
function stringArray(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string").sort() : []; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function unique(values) { return Array.from(new Set(values)); }
function percent(count, total) { return total ? Number(((count / total) * 100).toFixed(2)) : 0; }
function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value); return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    args[name] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return args;
}
function readJson(file, optional) {
  if (!file && optional) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (optional) return null; throw new Error(`Gagal membaca ${file}: ${error.message}`); }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.old || !args.new || !args.output) {
    throw new Error("Gunakan --old, --new, dan --output.");
  }
  const result = compareSourceSnapshots(readJson(args.old), readJson(args.new), {
    oldHealth: readJson(args["old-health"], true),
    proposedHealth: readJson(args["new-health"], true),
    sourceCode: args["source-code"] || ALLOWED_SOURCE,
    requestedMaxItems: args["requested-max-items"],
  });
  writeJson(args.output, result);
  console.log(`Snapshot diff: +${result.added_count} -${result.removed_count} ~${result.changed_count}`);
  if (args.strict && !result.validation.proposal_eligible) process.exitCode = 2;
  return result;
}

module.exports = {
  ALLOWED_SOURCE, CHANGE_RULES, compareSourceSnapshots, validateProposal, changedDetails,
  stableStringify, snapshotItem, healthSummary, containsNumericScore, main,
};

if (require.main === module) {
  try { main(); } catch (error) { console.error(`Snapshot diff gagal: ${error.message}`); process.exitCode = 1; }
}
