#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const vm = require("vm");
const sourceCompare = require("./compare_source_snapshots.js");
const triggerCompare = require("./compare_trigger_outputs.js");
const report = require("./build_source_refresh_report.js");

const ROOT = path.resolve(__dirname, "../..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "source-pilot-refresh.yml");
const TEMPLATE_DIR = path.join(ROOT, "radar", "templates");
const DASHBOARD = path.join(ROOT, "radar", "docs", "index.html");
const PROTECTED = [
  "radar/data/tenders.json", "radar/data/events.json", "radar/docs/data/review_queue.json",
  "radar/docs/data/qualification_readiness.json", "radar/docs/data/source_pilot_items.json",
  "radar/docs/data/source_pilot_health.json", "radar/docs/data/trigger_signals.json",
  "radar/config/trigger_taxonomy.json", "radar/config/human_feedback_rules.json",
  "radar/docs/js/human_feedback.js",
].map((name) => path.join(ROOT, name));
const initialHashes = hashes(PROTECTED);
const workflow = fs.readFileSync(WORKFLOW, "utf8");
const htmlTemplate = fs.readFileSync(path.join(TEMPLATE_DIR, "source_refresh_report.html"), "utf8");
const cssTemplate = fs.readFileSync(path.join(TEMPLATE_DIR, "source_refresh_report.css"), "utf8");
const jsTemplate = fs.readFileSync(path.join(TEMPLATE_DIR, "source_refresh_report.js"), "utf8");
const dashboard = fs.readFileSync(DASHBOARD, "utf8");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "radar-source-refresh-"));
let passed = 0;
let failed = 0;

function test(number, name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${number}. ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${number}. ${name}: ${error.message}`); }
}

function sourceItem(id, overrides = {}) {
  const slug = overrides.slug || id;
  const link = `https://www.bkpm.go.id/id/info/siaran-pers/${slug}`;
  return Object.assign({
    id, source_code: "BKPM_PRESS_RELEASES",
    source_name: "Kementerian Investasi dan Hilirisasi/BKPM - Siaran Pers",
    title: `Judul resmi ${id}`, link, published_at: "2026-07-10", organization_hint: "",
    excerpt: `Keterangan resmi untuk ${id} tentang groundbreaking pembangunan pabrik.`,
    provenance: { listing_url: "https://www.bkpm.go.id/id/info/siaran-pers", detail_url: link,
      official_domain: "www.bkpm.go.id", retrieval_method: "static_html" },
    quality: { title_valid: true, link_valid: true, date_status: "valid",
      organization_status: "unknown", excerpt_status: "available" },
    classification_hint: { category: "OTHER_OFFICIAL_NEWS" }, content_hash: `hash-${id}`,
  }, overrides);
}

function snapshot(items, duplicateCount = 0) {
  return { schema_version: "1.0.0", content_reference_date: "2026-07-10",
    source_summary: { configured_sources: 1, healthy_sources: 0, degraded_sources: 1,
      unavailable_sources: 0, raw_items: items.length + duplicateCount,
      normalized_items: items.length, duplicate_items: duplicateCount, invalid_items: 0 }, items };
}

function health(overrides = {}) {
  return { schema_version: "1.0.0", sources: [Object.assign({ source_code: "BKPM_PRESS_RELEASES",
    status: "DEGRADED", http_status: 200, content_type: "text/html; charset=UTF-8",
    listing_links_found: 10, detail_pages_attempted: 10, valid_items: 10, invalid_items: 0,
    warnings: [], errors: [] }, overrides)] };
}

function production(id = "prod-1") {
  return { id, type: "tender", data_origin: "tender_corpus", title: "Production item",
    source: "Tender source", link: "https://example.test/tender", date: "2026-07-10",
    organization: "Target", triggers: [], primary_trigger: "", timing_status: "FUTURE_OR_OPEN",
    suggested_next_action: "VERIFY", human_review_required: true };
}

function pilot(id, overrides = {}) {
  const link = `https://www.bkpm.go.id/id/info/siaran-pers/${id}`;
  return Object.assign({ id, type: "official_source", data_origin: "official_source_pilot",
    source_code: "BKPM_PRESS_RELEASES", title: `Pilot ${id}`, link, date: "2026-07-10", organization: "",
    triggers: [{ trigger_code: "FACILITY_DEVELOPMENT", trigger_label: "Facility development",
      trigger_class: "indirect", evidence_strength: "STRONG", matched_terms: ["groundbreaking"],
      matched_evidence: [{ term: "groundbreaking", field: "title", excerpt: `Pilot ${id} groundbreaking` }],
      evidence_excerpt: `Pilot ${id} groundbreaking`, product_hypotheses: ["wearpack — perlu verifikasi"],
      human_review_required: true }], primary_trigger: "FACILITY_DEVELOPMENT",
    timing_status: "FUTURE_OR_OPEN", suggested_next_action: "VERIFY_TRIGGER",
    human_review_required: true, official_provenance: { source_name: "BKPM Siaran Pers",
      official_domain: "www.bkpm.go.id", detail_url: link, published_at: "2026-07-10",
      retrieval_method: "static_html" } }, overrides);
}

const oldItems = [sourceItem("keep"), sourceItem("change"), sourceItem("remove")];
const changedItem = sourceItem("change", { excerpt: "Konten resmi berubah tentang groundbreaking pembangunan pabrik.", content_hash: "hash-new" });
const proposedItems = [sourceItem("add-b"), changedItem, sourceItem("keep"), sourceItem("add-a")];
const sourceDiff = sourceCompare.compareSourceSnapshots(snapshot(oldItems), snapshot(proposedItems), {
  oldHealth: health({ valid_items: 3 }), proposedHealth: health({ valid_items: 4 }), requestedMaxItems: 25,
});
const oldPilot = pilot("change");
const proposedChangedPilot = pilot("change", {
  primary_trigger: "BUSINESS_EXPANSION", timing_status: "CURRENT_OR_UNCLEAR",
  triggers: [{ trigger_code: "BUSINESS_EXPANSION", trigger_label: "Business expansion",
    trigger_class: "indirect", evidence_strength: "STRONG", matched_terms: ["ekspansi"],
    matched_evidence: [{ term: "ekspansi", field: "excerpt", excerpt: "Konten resmi berubah tentang ekspansi." }],
    evidence_excerpt: "Konten resmi berubah tentang ekspansi.", product_hypotheses: [], human_review_required: true }],
  });
const committedTrigger = { items: [production(), oldPilot] };
const proposedTrigger = { items: [pilot("add-a"), proposedChangedPilot, production()] };
const triggerDiff = triggerCompare.compareTriggerOutputs(committedTrigger, proposedTrigger);
const model = report.buildReportModel(sourceDiff, triggerDiff, { committedTrigger, proposedTrigger });
const reportDir = path.join(temp, "report");
report.writeReports(model, { outputDir: reportDir, templateDir: TEMPLATE_DIR, includeHtml: true });
const renderedHtml = fs.readFileSync(path.join(reportDir, "source_refresh_report.html"), "utf8");
const sourceMd = fs.readFileSync(path.join(reportDir, "source_snapshot_summary.md"), "utf8");
const triggerMd = fs.readFileSync(path.join(reportDir, "trigger_diff_summary.md"), "utf8");

test(1, "workflow hanya workflow_dispatch", () => {
  const triggerBlock = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("permissions:"));
  assert.match(triggerBlock, /workflow_dispatch:/); assert.doesNotMatch(triggerBlock, /\b(push|pull_request):/);
});
test(2, "workflow tidak memiliki schedule", () => assert.doesNotMatch(workflow, /^\s*schedule\s*:/m));
test(3, "workflow tidak memiliki cron", () => assert.doesNotMatch(workflow, /\bcron\s*:/i));
test(4, "workflow tidak menjalankan git add", () => assert.doesNotMatch(workflow, /\bgit\s+add\b/i));
test(5, "workflow tidak menjalankan git commit", () => assert.doesNotMatch(workflow, /\bgit\s+commit\b/i));
test(6, "workflow tidak menjalankan git push", () => assert.doesNotMatch(workflow, /\bgit\s+push\b/i));
test(7, "workflow tidak membuat auto PR", () => assert.doesNotMatch(workflow, /\b(gh\s+pr|pull-request|create-pull-request)\b/i));
test(8, "hanya BKPM menjadi pilihan source", () => {
  const block = workflow.slice(workflow.indexOf("source_code:"), workflow.indexOf("max_items:"));
  assert.match(block, /BKPM_PRESS_RELEASES/); assert.doesNotMatch(block, /KEMENPERIN/);
});
test(9, "Kemenperin tidak dapat dipilih", () => {
  const options = workflow.match(/options:\s*\n([\s\S]*?)\n\s*default: BKPM_PRESS_RELEASES/)[1];
  assert.doesNotMatch(options, /KEMENPERIN/);
});
test(10, "max_items dibatasi 50", () => assert.match(workflow, /maxItems\s*>\s*50/));
test(11, "max_detail_requests dibatasi 25", () => assert.match(workflow, /maxDetails\s*>\s*25/));
test(12, "snapshot diff order-independent", () => {
  const reversed = sourceCompare.compareSourceSnapshots(snapshot(oldItems.slice().reverse()), snapshot(proposedItems.slice().reverse()),
    { oldHealth: health(), proposedHealth: health() });
  assert.deepStrictEqual(reversed.added.map((x) => x.id), sourceDiff.added.map((x) => x.id));
});
test(13, "added item detected", () => assert.strictEqual(sourceDiff.added_count, 2));
test(14, "removed item detected", () => assert.strictEqual(sourceDiff.removed_count, 1));
test(15, "content change detected", () => assert(sourceDiff.changed[0].reasons.includes("CONTENT_CHANGED")));
test(16, "date change detected", () => {
  const result = sourceCompare.changedDetails(sourceItem("x"), sourceItem("x", { published_at: "2026-07-11" }));
  assert(result.reasons.includes("DATE_CHANGED"));
});
test(17, "link change detected", () => {
  const next = sourceItem("x", { link: "https://www.bkpm.go.id/id/info/siaran-pers/new-link" });
  assert(sourceCompare.changedDetails(sourceItem("x"), next).reasons.includes("LINK_CHANGED"));
});
test(18, "quality change detected", () => {
  const next = sourceItem("x", { quality: Object.assign({}, sourceItem("x").quality, { excerpt_status: "missing" }) });
  assert(sourceCompare.changedDetails(sourceItem("x"), next).reasons.includes("QUALITY_CHANGED"));
});
test(19, "unchanged item tetap unchanged", () => assert.strictEqual(sourceDiff.unchanged_count, 1));
test(20, "trigger diff mendeteksi new pilot signal", () => assert.strictEqual(triggerDiff.summary.new_official_pilot_signal_count, 1));
test(21, "trigger classification change detected", () => assert.strictEqual(triggerDiff.summary.classification_change_count, 1));
test(22, "timing change detected", () => assert.strictEqual(triggerDiff.summary.timing_change_count, 1));
test(23, "evidence change detected", () => assert.strictEqual(triggerDiff.summary.evidence_change_count, 1));
test(24, "production semantic change menyebabkan rejection", () => {
  const changedProduction = production(); changedProduction.title = "Changed production";
  const diff = triggerCompare.compareTriggerOutputs({ items: [production()] }, { items: [changedProduction] });
  assert.strictEqual(diff.validation.proposal_eligible, false);
  assert.strictEqual(report.buildReportModel(sourceDiff, diff).status, "REJECT_PROPOSAL");
});
test(25, "missing source tidak mengubah committed snapshot", () => {
  const before = hashes(PROTECTED); const result = childProcess.spawnSync(process.execPath,
    [path.join(__dirname, "compare_source_snapshots.js"), "--old", "missing-file", "--new", "missing-file", "--output", path.join(temp, "no.json")],
    { cwd: ROOT, encoding: "utf8" });
  assert.notStrictEqual(result.status, 0); assert.deepStrictEqual(hashes(PROTECTED), before);
});
test(26, "proposed output kosong ditolak", () => {
  const diff = sourceCompare.compareSourceSnapshots(snapshot([sourceItem("x")]), snapshot([]), { proposedHealth: health({ valid_items: 0 }) });
  assert(diff.validation.errors.includes("PROPOSED_OUTPUT_EMPTY"));
});
test(27, "Kemenperin item ditolak", () => {
  const bad = sourceItem("bad", { source_code: "KEMENPERIN_IMC_NEWS" });
  const diff = sourceCompare.compareSourceSnapshots(snapshot([]), snapshot([bad]), { proposedHealth: health() });
  assert(diff.validation.errors.some((value) => /SOURCE_NOT_ACCEPTED|KEMENPERIN/.test(value)));
});
test(28, "artifact tidak mengandung raw source HTML", () => {
  const badDiff = JSON.parse(JSON.stringify(sourceDiff)); badDiff.added[0].excerpt = "</script><img src=x>";
  const badModel = report.buildReportModel(badDiff, triggerDiff, { committedTrigger, proposedTrigger });
  const dir = path.join(temp, "escaped"); report.writeReports(badModel, { outputDir: dir, templateDir: TEMPLATE_DIR });
  const html = fs.readFileSync(path.join(dir, "source_refresh_report.html"), "utf8");
  assert.doesNotMatch(html, /<img src=x>|<\/script><img/);
});
test(29, "artifact tidak mengandung cookie", () => assert.doesNotMatch(renderedHtml + workflow, /set-cookie|cookiejar|browser profile/i));
test(30, "artifact tidak mengandung credential", () => assert.doesNotMatch(renderedHtml + workflow, /authorization header|client_secret|private_key/i));
test(31, "report HTML tanpa external dependency", () => {
  assert.doesNotMatch(htmlTemplate, /(?:src|href)=["']https?:|cdn\.|@import/i);
});
test(32, "report HTML memiliki viewport meta", () => assert.match(htmlTemplate,
  /<meta name="viewport" content="width=device-width, initial-scale=1">/));
test(33, "report tidak menggunakan eval", () => assert.doesNotMatch(jsTemplate, /\beval\s*\(/));
test(34, "report tidak menggunakan unsafe innerHTML", () => assert.doesNotMatch(jsTemplate, /\.innerHTML\b/));
test(35, "mobile CSS 360px tersedia", () => assert.match(cssTemplate, /@media\s*\(min-width:\s*360px\)/));
test(36, "mobile CSS 390px tersedia", () => assert.match(cssTemplate, /@media\s*\(min-width:\s*390px\)/));
test(37, "interactive target minimum 44px", () => assert.match(cssTemplate, /min-height:\s*44px/));
test(38, "long URL tidak menyebabkan overflow", () => assert.match(cssTemplate, /overflow-wrap:\s*anywhere/));
test(39, "table card layout aman pada mobile", () => {
  assert.match(cssTemplate, /audit-card/); assert.doesNotMatch(htmlTemplate, /<table\b/i);
});
test(40, "keyboard focus styles tersedia", () => assert.match(cssTemplate, /:focus-visible/));
test(41, "report dapat dibuka tanpa network", () => {
  assert.doesNotMatch(htmlTemplate + jsTemplate + cssTemplate, /fetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//i);
});
test(42, "JSON output valid", () => assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(reportDir, "source_refresh_summary.json"), "utf8"))));
test(43, "Markdown summary valid", () => {
  assert.match(sourceMd, /^# /); assert.match(sourceMd, /Acceptance recommendation/); assert.match(triggerMd, /^# /);
});
test(44, "existing source pilot tests lulus", () => runRegression("radar/scripts/test_source_pilot.js"));
test(45, "trigger regression lulus", () => {
  runRegression("radar/scripts/test_trigger_source_pilot.js"); runRegression("radar/scripts/test_trigger_signals.js");
});
test(46, "human feedback regression lulus", () => runRegression("radar/scripts/test_human_feedback.js"));
test(47, "dashboard vm.Script lulus", () => {
  const scripts = Array.from(dashboard.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)).map((match) => match[1]).filter((value) => value.trim());
  scripts.forEach((source) => assert.doesNotThrow(() => new vm.Script(source)));
});
test(48, "dashboard 360px no-overflow assertion lulus", () => {
  assert.match(dashboard, /@media\s*\(max-width:\s*640px\)/); assert.match(dashboard, /overflow-wrap:\s*anywhere|word-break:\s*break-word/);
  assert.match(dashboard, /\.filters label, \.filters select, \.filters input\[type=text\] \{ width:\s*100%/);
});
test(49, "dashboard 390px no-overflow assertion lulus", () => {
  assert.match(dashboard, /\.modal[\s\S]{0,160}max-width/); assert.match(dashboard, /\.badge[\s\S]{0,250}(?:white-space|overflow-wrap|flex-wrap)/);
});
test(50, "committed production hashes tidak berubah", () => assert.deepStrictEqual(hashes(PROTECTED), initialHashes));

test("S1", "synthetic audit counts and recommendation", () => {
  assert.deepStrictEqual([model.summary.added_count, model.summary.changed_count, model.summary.removed_count], [2, 1, 1]);
  assert.deepStrictEqual([model.summary.new_trigger_count, model.summary.timing_change_count, model.summary.evidence_change_count], [1, 1, 1]);
  assert.strictEqual(model.summary.production_change_count, 0); assert.strictEqual(model.status, "REVIEW_REQUIRED");
});
test("S2", "synthetic report filter and expand execute without exception", () => {
  const dom = fakeDom();
  const context = { document: dom.document, URL, JSON, String, Object, Array };
  assert.doesNotThrow(() => new vm.Script(jsTemplate).runInNewContext(context));
  dom.nodes.changeTypeFilter.value = "ADDED"; dom.nodes.changeTypeFilter.fire("change");
  assert.match(dom.nodes.filterResult.textContent, /^2 kartu sesuai filter/);
  dom.nodes.showAllDetails.fire("click");
  assert.strictEqual(dom.nodes.addedItems.querySelector(".detail-panel").hidden, false);
  assert.match(dom.nodes.addedItems.querySelector(".source-link").href, /^https:\/\/www\.bkpm\.go\.id\/id\/info\/siaran-pers\//);
  dom.nodes.hideAllDetails.fire("click");
  assert.strictEqual(dom.nodes.addedItems.querySelector(".detail-panel").hidden, true);
});
test("S3", "synthetic report 360 and 390 layout contract", () => {
  assert.match(cssTemplate, /max-width:\s*100%/); assert.match(cssTemplate, /overflow-x:\s*hidden/);
  assert.match(cssTemplate, /grid-template-columns:\s*1fr/);
});
test("S4", "production semantic change produces reject report without committed writes", () => {
  const before = hashes(PROTECTED); const changedProduction = production(); changedProduction.timing_status = "COMPLETED_OR_HISTORICAL";
  const rejectedDiff = triggerCompare.compareTriggerOutputs({ items: [production()] }, { items: [changedProduction] });
  assert.strictEqual(report.buildReportModel(sourceDiff, rejectedDiff).status, "REJECT_PROPOSAL");
  assert.deepStrictEqual(hashes(PROTECTED), before);
});

try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) { /* test temp only */ }
console.log(`\nSource refresh tests: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;

function runRegression(script) {
  const result = childProcess.spawnSync(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stdout + result.stderr).trim() || `${script} failed`);
}
function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function hashes(files) { return Object.fromEntries(files.map((file) => [path.relative(ROOT, file), hash(file)])); }

function fakeDom() {
  class Node {
    constructor(tag = "div") { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {};
      this.listeners = {}; this.textContent = ""; this.className = ""; this.hidden = false; this.value = ""; }
    get childNodes() { return this.children; }
    appendChild(node) { this.children.push(node); return node; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    fire(name) { if (this.listeners[name]) this.listeners[name]({ target: this }); }
    querySelector(selector) {
      const className = selector.charAt(0) === "." ? selector.slice(1) : "";
      for (const child of this.children) {
        if (className && String(child.className).split(/\s+/).includes(className)) return child;
        const nested = child.querySelector && child.querySelector(selector); if (nested) return nested;
      }
      return null;
    }
  }
  const ids = Array.from(htmlTemplate.matchAll(/id="([^"]+)"/g)).map((match) => match[1]);
  const nodes = Object.fromEntries(ids.map((id) => [id, new Node(id.indexOf("Filter") >= 0 ? "select" : "div")]));
  nodes["report-data"].textContent = JSON.stringify(model);
  return { nodes, document: { getElementById: (id) => nodes[id], createElement: (tag) => new Node(tag) } };
}
