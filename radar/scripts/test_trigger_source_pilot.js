#!/usr/bin/env node
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const builder = require("./build_trigger_signals");

const ROOT = path.resolve(__dirname, "..", "..");
const FILES = {
  tenders: path.join(ROOT, "radar", "data", "tenders.json"),
  events: path.join(ROOT, "radar", "data", "events.json"),
  reviewQueue: path.join(ROOT, "radar", "docs", "data", "review_queue.json"),
  qualification: path.join(ROOT, "radar", "docs", "data", "qualification_readiness.json"),
  pilot: path.join(ROOT, "radar", "docs", "data", "source_pilot_items.json"),
  registry: path.join(ROOT, "radar", "config", "source_registry.json"),
  taxonomy: path.join(ROOT, "radar", "config", "trigger_taxonomy.json"),
  dashboard: path.join(ROOT, "radar", "docs", "index.html"),
  workflow: path.join(ROOT, ".github", "workflows", "radar.yml"),
};

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function hasNumericScore(value) {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some((key) =>
    (/score/i.test(key) && typeof value[key] === "number") || hasNumericScore(value[key]));
}

const taxonomy = readJson(FILES.taxonomy);
const registry = readJson(FILES.registry);
const snapshot = readJson(FILES.pilot);
const production = {
  tenderData: builder.readDataset(FILES.tenders, "tender"),
  eventData: builder.readDataset(FILES.events, "event"),
};
const protectedHashes = Object.fromEntries(
  ["tenders", "events", "reviewQueue", "qualification"].map((key) => [key, hash(FILES[key])]));

function samplePilot(overrides = {}) {
  const item = {
    id: "src_test_facility_001",
    source_code: "BKPM_PRESS_RELEASES",
    source_name: "Kementerian Investasi dan Hilirisasi/BKPM - Siaran Pers",
    source_type: "official_press_release",
    title: "Groundbreaking Pabrik Nusantara Dimulai",
    link: "https://www.bkpm.go.id/id/info/siaran-pers/groundbreaking-pabrik-contoh",
    published_at: "2026-06-30",
    organization_hint: "",
    excerpt: "Rencana pembangunan fasilitas fisik memasuki tahap konstruksi.",
    provenance: {
      listing_url: "https://www.bkpm.go.id/id/info/siaran-pers",
      detail_url: "https://www.bkpm.go.id/id/info/siaran-pers/groundbreaking-pabrik-contoh",
      official_domain: "www.bkpm.go.id",
      retrieval_method: "static_html",
    },
  };
  return Object.assign(item, overrides);
}

function build(options = {}) {
  return builder.buildOutput({
    tenderData: options.tenderData || { generatedAt: "2026-07-01T00:00:00.000Z", items: [] },
    eventData: options.eventData || { generatedAt: "2026-07-01T00:00:00.000Z", items: [] },
    taxonomy,
    sourcePilotData: options.sourcePilotData === undefined
      ? { items: [samplePilot()] } : options.sourcePilotData,
    sourceRegistry: options.sourceRegistry === undefined ? registry : options.sourceRegistry,
    sourceRegistryValid: options.sourceRegistryValid === undefined
      ? true : options.sourceRegistryValid,
  });
}

function dashboardRuntime(triggerOutput) {
  const html = fs.readFileSync(FILES.dashboard, "utf8");
  const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)][0][1];
  const elements = {};
  function element(id) {
    if (!elements[id]) elements[id] = {
      id, textContent: "", innerHTML: "", value: "", checked: false,
      style: {}, dataset: {}, className: "",
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, setAttribute() {}, removeAttribute() {}, appendChild() {},
      remove() {}, click() {}, focus() {}, select() {}, querySelectorAll() { return []; },
    };
    return elements[id];
  }
  const context = {
    console, Blob, URL, Promise, Date, Math, JSON, Object, Array, String, Number,
    RegExp, Set, Map, Intl, setTimeout, clearTimeout,
    document: {
      body: element("body"), getElementById: element, querySelectorAll() { return []; },
      createElement(tag) { return element("created-" + tag); }, execCommand() { return true; },
    },
    fetch(url) {
      if (String(url).includes("trigger_signals.json")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(triggerOutput) });
      }
      return Promise.reject(new Error("synthetic 404"));
    },
    navigator: { clipboard: null }, location: { href: "http://127.0.0.1/docs/index.html" },
    open() {},
  };
  context.window = context;
  vm.runInNewContext(script, context, { filename: "dashboard-j2b.js" });
  return { context, elements };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("1. accepted BKPM item diproses", () => {
  assert.strictEqual(registry.sources.find((source) => source.code === "BKPM_PRESS_RELEASES")
    .acceptance_status, "ACCEPTED_FOR_TRIGGER_PILOT");
  const output = build();
  assert.strictEqual(output.source_summary.source_pilot_integrated_total, 1);
  assert.strictEqual(output.items[0].source_code, "BKPM_PRESS_RELEASES");
});

test("2. rejected Kemenperin item tidak diproses", () => {
  const kemenperinConfig = registry.sources.find((source) => source.code === "KEMENPERIN_IMC_NEWS");
  assert.strictEqual(kemenperinConfig.acceptance_status, "REJECTED");
  assert.strictEqual(kemenperinConfig.acceptance_reason, "TLS_CERT_EXPIRED");
  const rejected = samplePilot({
    id: "src_kemenperin_rejected", source_code: "KEMENPERIN_IMC_NEWS",
    source_name: "IMC Kemenperin", link: "https://imc.kemenperin.go.id/berita/contoh",
    provenance: {
      detail_url: "https://imc.kemenperin.go.id/berita/contoh",
      official_domain: "imc.kemenperin.go.id", retrieval_method: "static_html",
    },
  });
  const output = build({ sourcePilotData: { items: [samplePilot(), rejected] } });
  assert.strictEqual(output.source_summary.rejected_source_items, 1);
  assert.ok(!output.items.some((item) => item.source_code === "KEMENPERIN_IMC_NEWS"));
});

test("3. source pilot missing tidak merusak production build", () => {
  const inputs = builder.readSourcePilotInputs(
    path.join(ROOT, "radar", "docs", "data", "missing-source-pilot.json"), FILES.registry);
  assert.strictEqual(inputs.sourcePilotData, null);
  const output = builder.buildOutput({ ...production, taxonomy });
  assert.strictEqual(output.source_summary.production_evaluated_total, 1079);
});

test("4. invalid registry fail-closed untuk pilot", () => {
  const invalid = clone(registry);
  delete invalid.acceptance_statuses;
  const output = build({ sourceRegistry: invalid, sourceRegistryValid: true });
  assert.strictEqual(output.source_summary.source_pilot_integrated_total, 0);
  assert.strictEqual(output.source_summary.rejected_source_items, 1);
});

test("5. production stable ID tidak berubah", () => {
  const qualificationIds = new Set(readJson(FILES.qualification).items.map((item) => item.id));
  production.tenderData.items.forEach((item, index) =>
    assert.ok(qualificationIds.has(builder.normalizeItem(item, "tender", index).id)));
  production.eventData.items.forEach((item, index) =>
    assert.ok(qualificationIds.has(builder.normalizeItem(item, "event", index).id)));
});

test("6. source pilot stable ID dipertahankan", () => {
  assert.strictEqual(build().items[0].id, "src_test_facility_001");
});

test("7. no ID collision", () => {
  const tender = { judul: "Tender pengadaan seragam", sumber: "Sumber", link: "https://x.test/a" };
  const id = builder.normalizeItem(tender, "tender", 0).id;
  assert.throws(() => build({
    tenderData: { generatedAt: null, items: [tender] },
    sourcePilotData: { items: [samplePilot({ id })] },
  }), /ID collision/);
});

test("8. title evidence dicatat", () => {
  const trigger = build().items[0].triggers[0];
  assert.ok(trigger.matched_evidence.some((evidence) => evidence.field === "title"));
});

test("9. excerpt evidence dicatat", () => {
  const trigger = build().items[0].triggers[0];
  assert.ok(trigger.matched_evidence.some((evidence) => evidence.field === "excerpt"));
});

test("10. evidence benar-benar berasal dari input", () => {
  const input = samplePilot();
  build().items[0].triggers.forEach((trigger) => trigger.matched_evidence.forEach((evidence) => {
    assert.ok(input[evidence.field].includes(evidence.excerpt));
    assert.ok(evidence.excerpt.length <= 300);
  }));
});

test("11. publisher tidak dianggap buyer", () => {
  const item = build().items[0];
  assert.strictEqual(item.organization, "");
  assert.notStrictEqual(item.organization, item.source);
});

test("12. exact URL duplicate ditekan", () => {
  const pilot = samplePilot({ title: "Judul resmi berbeda" });
  const tender = {
    judul: "Tender pengadaan seragam", sumber: "Sumber Lama",
    link: pilot.provenance.detail_url, published: "2026-06-29",
  };
  const output = build({ tenderData: { generatedAt: null, items: [tender] } });
  assert.strictEqual(output.source_summary.cross_corpus_duplicates, 1);
  assert.strictEqual(output.source_summary.source_pilot_signal_total, 0);
  assert.strictEqual(output.items[0].related_official_provenance.length, 1);
});

test("13. normalized title+date duplicate ditekan", () => {
  const tender = {
    judul: "Groundbreaking   Pabrik Nusantara Dimulai", sumber: "Sumber Lama",
    link: "https://legacy.test/a", published: "2026-06-30T09:00:00+07:00",
  };
  const output = build({ tenderData: { generatedAt: null, items: [tender] } });
  assert.strictEqual(output.source_summary.cross_corpus_duplicates, 1);
});

test("14. similar but different article tidak dideduplikasi", () => {
  const tender = {
    judul: "Groundbreaking Pabrik Nusantara Lain", sumber: "Sumber Lama",
    link: "https://legacy.test/b", published: "2026-06-30",
  };
  const output = build({ tenderData: { generatedAt: null, items: [tender] } });
  assert.strictEqual(output.source_summary.cross_corpus_duplicates, 0);
  assert.strictEqual(output.source_summary.source_pilot_integrated_total, 1);
});

test("15. official provenance tersimpan", () => {
  const provenance = build().items[0].official_provenance;
  ["source_name", "official_domain", "detail_url", "published_at", "retrieval_method"]
    .forEach((key) => assert.ok(provenance[key]));
});

test("16. human_review_required true", () => {
  const item = build().items[0];
  assert.strictEqual(item.human_review_required, true);
  item.triggers.forEach((trigger) => assert.strictEqual(trigger.human_review_required, true));
});

test("17. no numeric score", () => assert.strictEqual(hasNumericScore(build()), false));

test("18. no forbidden action", () => {
  build().items.forEach((item) =>
    assert.ok(!builder.FORBIDDEN_ACTIONS.has(item.suggested_next_action)));
});

test("19. source summary konsisten", () => {
  const output = build({ sourcePilotData: { items: [samplePilot(), samplePilot({
    id: "src_no_trigger", title: "Investasi Indonesia Tetap Menarik",
    link: "https://www.bkpm.go.id/id/info/siaran-pers/investasi-menarik",
    excerpt: "Informasi kebijakan investasi.",
    provenance: {
      detail_url: "https://www.bkpm.go.id/id/info/siaran-pers/investasi-menarik",
      official_domain: "www.bkpm.go.id", retrieval_method: "static_html",
    },
  })] } });
  assert.strictEqual(output.source_summary.source_pilot_input_total, 2);
  assert.strictEqual(output.source_summary.source_pilot_signal_total, 1);
  assert.strictEqual(output.source_summary.source_pilot_without_trigger, 1);
  assert.strictEqual(builder.validateOutput(output, taxonomy), true);
});

test("20. production subset classification tidak berubah", () => {
  const withoutPilot = builder.buildOutput({ ...production, taxonomy });
  const withPilot = builder.buildOutput({
    ...production, taxonomy, sourcePilotData: { items: snapshot.items },
    sourceRegistry: registry, sourceRegistryValid: true,
  });
  const compact = (item) => ({
    id: item.id, primary_trigger: item.primary_trigger, timing_status: item.timing_status,
    suggested_next_action: item.suggested_next_action,
    triggers: item.triggers.map((trigger) => ({
      code: trigger.trigger_code, strength: trigger.evidence_strength,
      terms: trigger.matched_terms,
    })),
  });
  assert.deepStrictEqual(
    withPilot.items.filter((item) => item.data_origin !== "official_source_pilot").map(compact),
    withoutPilot.items.map(compact));
});

test("21. dashboard origin filter berfungsi", async () => {
  const output = build();
  const runtime = dashboardRuntime(output);
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.strictEqual(runtime.context.state.triggerSignalsAvailable, true);
  assert.strictEqual(runtime.context.state.triggerSignals.items.length, 1);
  assert.strictEqual(runtime.context.state.triggerSignals.items[0].data_origin,
    "official_source_pilot");
  runtime.context.state.triggerFilters.origin = "official_source_pilot";
  assert.strictEqual(runtime.context.triggerItemsAfterFilter().length, 1,
    JSON.stringify(runtime.context.state.triggerFilters));
  runtime.context.state.triggerFilters.sourceCode = "BKPM_PRESS_RELEASES";
  assert.strictEqual(runtime.context.triggerItemsAfterFilter().length, 1);
  runtime.context.renderTriggerSignals();
  assert.ok(runtime.elements.triggerSignalsItems.innerHTML.includes("Sumber resmi pilot"),
    runtime.elements.triggerSignalsItems.innerHTML);
  assert.ok(runtime.elements.triggerSignalsItems.innerHTML.includes(samplePilot().title),
    runtime.elements.triggerSignalsItems.innerHTML);

  var officialFuture = runtime.context.state.triggerSignals.items[0];
  officialFuture.timing_status = "FUTURE_OR_OPEN";
  var productionFutureDirect = JSON.parse(JSON.stringify(officialFuture));
  productionFutureDirect.id = "rq_priority_direct";
  productionFutureDirect.title = "Production future direct";
  productionFutureDirect.type = "tender";
  productionFutureDirect.data_origin = "tender_corpus";
  productionFutureDirect.source_code = "";
  productionFutureDirect.official_provenance = null;
  productionFutureDirect.primary_trigger = "DIRECT_PROCUREMENT";
  productionFutureDirect.triggers[0].trigger_code = "DIRECT_PROCUREMENT";
  productionFutureDirect.triggers[0].trigger_class = "direct";
  runtime.context.state.triggerSignals.items = [productionFutureDirect, officialFuture];
  runtime.context.state.triggerFilters.origin = "";
  runtime.context.state.triggerFilters.sourceCode = "";
  var prioritized = runtime.context.triggerItemsAfterFilter();
  assert.strictEqual(prioritized[0].data_origin, "official_source_pilot");
  assert.strictEqual(prioritized[1].id, "rq_priority_direct");
});

test("22. dashboard 404 source pilot tetap aman", async () => {
  const html = fs.readFileSync(FILES.dashboard, "utf8");
  assert.ok(!html.includes('fetchFirst(["data/source_pilot_items.json"'));
  const runtime = dashboardRuntime(build());
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(runtime.context.state.triggerSignalsAvailable, true);
});

test("23. existing trigger tests tersedia di workflow", () => {
  assert.ok(fs.readFileSync(FILES.workflow, "utf8").includes("test_trigger_signals.js"));
});

test("24. source pilot tests tetap lulus", () => {
  const result = childProcess.spawnSync(process.execPath, [
    path.join(ROOT, "radar", "scripts", "test_source_pilot.js"),
  ], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
});

test("25. human feedback regression tetap lulus", () => {
  const result = childProcess.spawnSync(process.execPath, [
    path.join(ROOT, "radar", "scripts", "test_human_feedback.js"),
  ], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
});

test("26. output idempotent", () => {
  assert.strictEqual(JSON.stringify(build()), JSON.stringify(build()));
});

test("27. production source files tidak berubah", () => {
  Object.keys(protectedHashes).forEach((key) => assert.strictEqual(hash(FILES[key]), protectedHashes[key]));
});

test("28. workflow tidak melakukan live network fetch", () => {
  const workflow = fs.readFileSync(FILES.workflow, "utf8");
  assert.ok(!workflow.includes("fetch_source_pilot.js"));
  assert.ok(workflow.includes('cron: "0 22 * * *"'));
  assert.ok(workflow.includes("source_pilot_items.json"));
});

(async () => {
  let passed = 0;
  const failures = [];
  for (const entry of tests) {
    try {
      await entry.fn();
      passed += 1;
      console.log("PASS " + entry.name);
    } catch (error) {
      failures.push({ name: entry.name, error });
      console.error("FAIL " + entry.name + ": " + error.message);
    }
  }
  if (failures.length) {
    console.error(`\n${failures.length} test(s) failed; ${passed}/${tests.length} passed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nTrigger source pilot tests passed: ${passed}/${tests.length}`);
})();
