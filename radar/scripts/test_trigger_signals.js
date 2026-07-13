#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const vm = require("vm");
const builder = require("./build_trigger_signals.js");

const ROOT = path.resolve(__dirname, "../..");
const FILES = {
  taxonomy: path.join(ROOT, "radar", "config", "trigger_taxonomy.json"),
  tenders: path.join(ROOT, "radar", "data", "tenders.json"),
  events: path.join(ROOT, "radar", "data", "events.json"),
  reviewQueue: path.join(ROOT, "radar", "docs", "data", "review_queue.json"),
  qualification: path.join(ROOT, "radar", "docs", "data", "qualification_readiness.json"),
  output: path.join(ROOT, "radar", "docs", "data", "trigger_signals.json"),
  dashboard: path.join(ROOT, "radar", "docs", "index.html"),
};

const initialHashes = hashFiles(FILES);
const taxonomy = builder.readTaxonomy(FILES.taxonomy);
const tenderData = builder.readDataset(FILES.tenders, "tender");
const eventData = builder.readDataset(FILES.events, "event");
const output = readJson(FILES.output);
let passed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashFiles(files) {
  return {
    tenders: hash(files.tenders),
    events: hash(files.events),
    reviewQueue: hash(files.reviewQueue),
    qualification: hash(files.qualification),
  };
}

function candidate(title, type = "event", organization = "Organisasi Contoh", eventDate = "") {
  const item = type === "tender"
    ? {
        judul: title,
        sumber: "Sumber Publik",
        link: "https://example.test/source",
        published: "2026-07-13T01:00:00.000Z",
        instansi_terdeteksi: organization,
      }
    : {
        nama_event: title,
        sumber: "Sumber Publik",
        link_resmi: "https://example.test/source",
        tanggal: eventDate || null,
        published: "2026-07-13T01:00:00.000Z",
        penyelenggara: organization,
      };
  return builder.normalizeItem(item, type, 0);
}

function evaluate(title, type = "event", organization = "Organisasi Contoh", eventDate = "") {
  return builder.evaluateCandidate(
    candidate(title, type, organization, eventDate), taxonomy, output.generated_at
  );
}

function triggerCodes(title, type, organization) {
  return builder.detectTriggers(candidate(title, type, organization), taxonomy)
    .map((trigger) => trigger.trigger_code);
}

function hasNumericScore(value) {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some((key) => {
    if (/score/i.test(key) && typeof value[key] === "number") return true;
    return hasNumericScore(value[key]);
  });
}

function createDashboardVmContext(fetchImplementation) {
  const html = fs.readFileSync(FILES.dashboard, "utf8");
  const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)][0][1];
  const elements = {};
  function mockElement(id) {
    if (!elements[id]) {
      elements[id] = {
        id, textContent: "", innerHTML: "", value: "", checked: false,
        style: {}, dataset: {}, className: "",
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {}, setAttribute() {}, removeAttribute() {},
        appendChild() {}, remove() {}, click() {}, focus() {}, select() {},
        querySelectorAll() { return []; },
      };
    }
    return elements[id];
  }
  const document = {
    body: mockElement("body"),
    getElementById: mockElement,
    querySelectorAll() { return []; },
    createElement(tag) { return mockElement("created-" + tag); },
    execCommand() { return true; },
  };
  const context = {
    console, document, Blob, URL, Promise, Date, Math, JSON, Object, Array, String,
    Number, RegExp, Set, Map, Intl, setTimeout, clearTimeout,
    fetch: fetchImplementation,
    navigator: { clipboard: null },
    location: { href: "http://127.0.0.1/docs/index.html" },
    open() {},
  };
  context.window = context;
  vm.runInNewContext(script, context, { filename: "dashboard-runtime.js" });
  return { context, elements };
}

test("1. taxonomy valid", () => {
  assert.strictEqual(builder.validateTaxonomy(taxonomy), true);
});

test("2. trigger code unik", () => {
  const codes = taxonomy.triggers.map((entry) => entry.code);
  assert.strictEqual(new Set(codes).size, codes.length);
});

test("3. positive terms valid", () => {
  taxonomy.triggers.forEach((entry) => {
    assert.ok(Array.isArray(entry.positive_terms));
    assert.ok(entry.phrase_terms.length > 0);
    entry.positive_terms.concat(entry.phrase_terms).forEach((term) => {
      assert.strictEqual(typeof term, "string");
      assert.ok(term.trim().length > 0);
    });
  });
});

test("4. negative terms valid", () => {
  taxonomy.triggers.forEach((entry) => {
    assert.ok(Array.isArray(entry.negative_terms));
    entry.negative_terms.forEach((term) => assert.ok(typeof term === "string" && term.trim()));
  });
});

test("5. invalid trigger ditolak", () => {
  const invalid = JSON.parse(JSON.stringify(taxonomy));
  invalid.triggers[0].trigger_class = "commercial_rank";
  assert.throws(() => builder.validateTaxonomy(invalid), /trigger_class/);
});

test("6. one item multiple triggers", () => {
  const codes = triggerCodes("Pembukaan pabrik baru disertai rekrutmen massal pegawai");
  assert.ok(codes.includes("FACILITY_OPENING"));
  assert.ok(codes.includes("MASS_RECRUITMENT"));
});

test("7. deterministic primary trigger", () => {
  const triggers = builder.detectTriggers(
    candidate("Pembukaan pabrik baru disertai rekrutmen massal pegawai"), taxonomy
  );
  const first = builder.selectPrimaryTrigger(triggers, taxonomy).trigger_code;
  const reversed = builder.selectPrimaryTrigger(triggers.slice().reverse(), taxonomy).trigger_code;
  assert.strictEqual(first, "FACILITY_OPENING");
  assert.strictEqual(reversed, first);
});

test("8. direct procurement detection", () => {
  const triggers = builder.detectTriggers(candidate("Tender pengadaan seragam pegawai", "tender"), taxonomy);
  const direct = triggers.find((trigger) => trigger.trigger_code === "DIRECT_PROCUREMENT");
  assert.ok(direct);
  assert.strictEqual(direct.evidence_strength, "STRONG");
});

test("9. facility opening detection", () => {
  assert.ok(triggerCodes("Perusahaan meresmikan pembukaan hotel baru").includes("FACILITY_OPENING"));
});

test("10. mass recruitment detection", () => {
  assert.ok(triggerCodes("Perusahaan membuka rekrutmen massal pegawai").includes("MASS_RECRUITMENT"));
});

test("11. event detection", () => {
  const triggers = builder.detectTriggers(candidate("Family gathering dan seminar nasional perusahaan"), taxonomy);
  const event = triggers.find((trigger) => trigger.trigger_code === "CORPORATE_OR_INSTITUTIONAL_EVENT");
  assert.ok(event);
  assert.strictEqual(event.evidence_strength, "MODERATE");
});

test("12. safety trigger detection", () => {
  assert.ok(triggerCodes("Program K3 dan safety campaign untuk operasi lapangan")
    .includes("SAFETY_OR_OPERATIONAL_PROGRAM"));
});

test("13. historical procurement detection", () => {
  const triggers = builder.detectTriggers(
    candidate("Kejari menyidik dugaan korupsi pengadaan seragam lama", "tender"), taxonomy
  );
  assert.ok(triggers.some((trigger) => trigger.trigger_code === "HISTORICAL_PROCUREMENT_PATTERN"));
  assert.ok(triggers.some((trigger) => trigger.trigger_code === "DIRECT_PROCUREMENT"));
  const primary = builder.selectPrimaryTrigger(
    triggers, taxonomy,
    candidate("Kejari menyidik dugaan korupsi pengadaan seragam lama", "tender")
  );
  assert.strictEqual(primary.trigger_code, "HISTORICAL_PROCUREMENT_PATTERN");
});

test("14. negative rule ekspansi kredit", () => {
  assert.ok(!triggerCodes("Bank mencatat ekspansi kredit dan pembiayaan")
    .includes("BUSINESS_EXPANSION"));
});

test("15. negative rule pembukaan perdagangan", () => {
  assert.ok(!triggerCodes("Bursa memulai pembukaan perdagangan pagi ini")
    .includes("FACILITY_OPENING"));
});

test("16. weak generic keyword", () => {
  const triggers = builder.detectTriggers(candidate("HUT organisasi diperingati hari ini"), taxonomy);
  const event = triggers.find((trigger) => trigger.trigger_code === "CORPORATE_OR_INSTITUTIONAL_EVENT");
  assert.ok(event);
  assert.strictEqual(event.evidence_strength, "WEAK");
});

test("17. human_review_required true", () => {
  output.items.forEach((item) => {
    assert.strictEqual(item.human_review_required, true);
    item.triggers.forEach((trigger) => assert.strictEqual(trigger.human_review_required, true));
  });
});

test("18. tidak ada numeric score", () => {
  assert.strictEqual(hasNumericScore(output), false);
});

test("19. tidak ada forbidden action", () => {
  output.items.forEach((item) => {
    assert.ok(!builder.FORBIDDEN_ACTIONS.has(item.suggested_next_action));
    assert.ok(taxonomy.allowed_actions.includes(item.suggested_next_action));
  });
});

test("20. output counts konsisten", () => {
  assert.strictEqual(builder.validateOutput(output, taxonomy), true);
  assert.strictEqual(output.source_summary.evaluated_total, 1079);
});

test("21. output idempotent", () => {
  const first = builder.buildOutput({ tenderData, eventData, taxonomy });
  const second = builder.buildOutput({ tenderData, eventData, taxonomy });
  assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
  assert.strictEqual(JSON.stringify(first), JSON.stringify(output));
});

test("22. source hashes tidak berubah", () => {
  const current = hashFiles(FILES);
  assert.strictEqual(current.tenders, initialHashes.tenders);
  assert.strictEqual(current.events, initialHashes.events);
});

test("23. qualification readiness hash tidak berubah", () => {
  assert.strictEqual(hash(FILES.qualification), initialHashes.qualification);
});

test("24. review queue hash tidak berubah", () => {
  assert.strictEqual(hash(FILES.reviewQueue), initialHashes.reviewQueue);
});

test("25. dashboard fallback tidak crash", () => {
  const html = fs.readFileSync(FILES.dashboard, "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1]);
  scripts.forEach((script, index) => new vm.Script(script, { filename: `dashboard-${index}.js` }));
  assert.ok(html.includes("triggerSignalsAvailable"));
  assert.ok(html.includes("Data trigger belum tersedia"));
});

test("26. stable item ID kompatibel qualification readiness", () => {
  const qualification = readJson(FILES.qualification);
  const qualificationIds = new Set(qualification.items.map((item) => item.id));
  tenderData.items.forEach((item, index) => {
    assert.ok(qualificationIds.has(builder.normalizeItem(item, "tender", index).id));
  });
  eventData.items.forEach((item, index) => {
    assert.ok(qualificationIds.has(builder.normalizeItem(item, "event", index).id));
  });
});

test("27. seluruh trigger memiliki matched evidence dari judul", () => {
  output.items.forEach((item) => item.triggers.forEach((trigger) => {
    assert.ok(trigger.matched_terms.length > 0);
    assert.ok(item.title.includes(trigger.evidence_excerpt));
  }));
});

test("28. seluruh input dievaluasi atau dihitung tanpa trigger", () => {
  const source = output.source_summary;
  assert.strictEqual(source.signal_total + source.items_without_trigger, source.evaluated_total);
  assert.strictEqual(source.evaluated_total, tenderData.items.length + eventData.items.length);
});

test("29. field audit sama dengan qualification readiness", () => {
  const qualification = readJson(FILES.qualification);
  const byId = new Map(qualification.items.map((item) => [item.id, item]));
  output.items.forEach((item) => {
    const sourceItem = byId.get(item.id);
    assert.ok(sourceItem);
    ["type", "title", "source", "link", "date", "organization"].forEach((field) => {
      assert.strictEqual(item[field], sourceItem[field], `${item.id} field ${field}`);
    });
  });
});

test("30. artikel rekomendasi gathering ditolak", () => {
  const codes = triggerCodes("10 Tempat Outing Kantor untuk Corporate Gathering");
  assert.ok(!codes.includes("CORPORATE_OR_INSTITUTIONAL_EVENT"));
});

test("31. primary memakai evidence lebih kuat dalam kelas sama", () => {
  const triggers = builder.detectTriggers(candidate("Jalan Sehat HUT ke-20 Organisasi"), taxonomy);
  const primary = builder.selectPrimaryTrigger(triggers, taxonomy);
  assert.strictEqual(primary.trigger_code, "SPORTS_OR_COMMUNITY_EVENT");
  assert.strictEqual(primary.evidence_strength, "MODERATE");
});

test("32. akan digelar adalah future atau open", () => {
  assert.strictEqual(evaluate("Family gathering akan digelar bulan depan").timing_status,
    "FUTURE_OR_OPEN");
});

test("33. telah digelar adalah completed atau past", () => {
  assert.strictEqual(evaluate("Family gathering telah digelar perusahaan").timing_status,
    "COMPLETED_OR_PAST");
});

test("34. meriahkan adalah completed atau past", () => {
  assert.strictEqual(evaluate("Ribuan pelari meriahkan fun run perusahaan").timing_status,
    "COMPLETED_OR_PAST");
});

test("35. akan gelar tidak salah dibaca completed", () => {
  assert.strictEqual(evaluate("Perusahaan akan gelar family gathering").timing_status,
    "FUTURE_OR_OPEN");
});

test("36. recommendation dan listicle disuppress", () => {
  const result = builder.detectTriggersWithAudit(
    candidate("10 Rekomendasi tempat gathering perusahaan"), taxonomy);
  assert.strictEqual(result.editorialSuppressed, true);
  assert.ok(!result.triggers.some((trigger) =>
    trigger.trigger_code === "CORPORATE_OR_INSTITUTIONAL_EVENT"));
});

test("37. hidden gem family gathering disuppress", () => {
  assert.strictEqual(evaluate("4 Pantai Hidden Gem untuk Family Gathering"), null);
});

test("38. tema family gathering disuppress", () => {
  assert.strictEqual(evaluate("3 Tema Family Gathering untuk perusahaan"), null);
  assert.strictEqual(evaluate("Daftar Event Seru di Malang: Marathon dan Festival"), null);
});

test("39. tenaga kerja lokal bukan recruitment", () => {
  assert.ok(!triggerCodes("Berhasil Serap 72 Persen Tenaga Kerja Lokal")
    .includes("MASS_RECRUITMENT"));
});

test("40. membuka lowongan adalah recruitment", () => {
  assert.ok(triggerCodes("Perusahaan membuka lowongan untuk operator baru")
    .includes("MASS_RECRUITMENT"));
});

test("41. investasi generik bukan expansion", () => {
  assert.ok(!triggerCodes("Danantara Game Changer Investasi dari BUMN")
    .includes("BUSINESS_EXPANSION"));
});

test("42. ekspansi pabrik adalah expansion", () => {
  assert.ok(triggerCodes("Perusahaan memulai ekspansi pabrik di Jawa")
    .includes("BUSINESS_EXPANSION"));
});

test("43. mulai beroperasi adalah facility opening", () => {
  assert.ok(triggerCodes("Pabrik baru mulai beroperasi bulan ini")
    .includes("FACILITY_OPENING"));
  assert.ok(triggerCodes("Rumah sakit resmi dibuka bulan ini")
    .includes("FACILITY_OPENING"));
  assert.ok(!triggerCodes("Pendaftaran lomba resmi dibuka")
    .includes("FACILITY_OPENING"));
});

test("44. pembukaan perdagangan bukan facility opening", () => {
  assert.ok(!triggerCodes("Pembukaan perdagangan bursa berlangsung pagi ini")
    .includes("FACILITY_OPENING"));
});

test("45. pengadaan aktif mengalahkan historical secondary", () => {
  const item = evaluate(
    "Rencana pengadaan seragam tetap berjalan setelah temuan BPK", "tender");
  assert.ok(item.triggers.some((trigger) =>
    trigger.trigger_code === "HISTORICAL_PROCUREMENT_PATTERN"));
  assert.strictEqual(item.primary_trigger, "DIRECT_PROCUREMENT");
});

test("46. artikel korupsi dan audit tetap historical primary", () => {
  const item = evaluate(
    "Audit BPK bongkar dugaan korupsi pengadaan seragam lama", "tender");
  assert.strictEqual(item.primary_trigger, "HISTORICAL_PROCUREMENT_PATTERN");
  assert.strictEqual(item.timing_status, "HISTORICAL_REFERENCE");
});

test("47. timing counts konsisten", () => {
  const total = Object.values(output.trigger_summary.timing_counts)
    .reduce((sum, value) => sum + value, 0);
  assert.strictEqual(total, output.source_summary.signal_total);
  output.items.forEach((item) => assert.ok(builder.TIMING_STATUSES.includes(item.timing_status)));
});

test("48. editorial suppression count tersedia", () => {
  assert.ok(Number.isInteger(output.source_summary.suppressed_editorial_total));
  assert.ok(output.source_summary.suppressed_editorial_total > 0);
});

test("49. explicit event date bukan published date", () => {
  const past = evaluate("Fun run siap digelar", "event", "Organisasi Contoh", "2025-01-01");
  assert.strictEqual(past.timing_status, "COMPLETED_OR_PAST");
  const noEventDate = evaluate("Family gathering perusahaan");
  assert.strictEqual(noEventDate.timing_status, "CURRENT_OR_UNCLEAR");
});

test("50. dashboard memuat timing filter dan suppression summary", () => {
  const html = fs.readFileSync(FILES.dashboard, "utf8");
  assert.ok(html.includes("triggerTimingFilter"));
  assert.ok(html.includes("suppressed_editorial_total"));
});

test("51. human feedback regression tetap lulus", () => {
  const result = childProcess.spawnSync(
    process.execPath, [path.join(ROOT, "radar", "scripts", "test_human_feedback.js")],
    { encoding: "utf8" }
  );
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
});

test("52. dashboard 404 fallback tidak crash saat dieksekusi", async () => {
  const runtime = createDashboardVmContext(
    () => Promise.reject(new Error("synthetic 404")));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(runtime.elements.triggerSignalsStatus.textContent,
    "Data trigger belum tersedia. Dashboard lain tetap dapat digunakan.");
  assert.strictEqual(runtime.context.state.triggerSignalsAvailable, false);
});

test("53. dashboard timing priority, filter, dan limit 20", async () => {
  const runtime = createDashboardVmContext((url) => {
    if (String(url).includes("trigger_signals.json")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(output) });
    }
    return Promise.reject(new Error("synthetic 404"));
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const initialHtml = runtime.elements.triggerSignalsItems.innerHTML;
  assert.strictEqual((initialHtml.match(/class="review-item"/g) || []).length, 20);
  const firstFutureDirect = output.items.find((item) => {
    const primary = item.triggers.find((trigger) => trigger.trigger_code === item.primary_trigger);
    return item.timing_status === "FUTURE_OR_OPEN" && primary.trigger_class === "direct";
  });
  assert.ok(firstFutureDirect);
  assert.ok(initialHtml.indexOf(firstFutureDirect.title) >= 0);
  runtime.context.state.triggerFilters.timing = "COMPLETED_OR_PAST";
  runtime.context.renderTriggerSignals();
  assert.ok(runtime.elements.triggerSignalsStatus.textContent.includes("dari 60"));
  assert.ok(runtime.elements.triggerSignalsItems.innerHTML.includes("Selesai / lewat"));
  assert.ok(!runtime.elements.triggerSignalsItems.innerHTML.includes("Akan datang / terbuka"));
});

async function runTests() {
  for (const entry of tests) {
    try {
      await entry.fn();
      passed += 1;
      console.log("PASS " + entry.name);
    } catch (error) {
      console.error("FAIL " + entry.name + ": " + error.message);
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) console.log(`\nTrigger signal tests passed: ${passed}/${tests.length}`);
}

runTests();
