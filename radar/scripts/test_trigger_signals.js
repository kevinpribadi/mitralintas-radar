#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
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

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("PASS " + name);
  } catch (error) {
    console.error("FAIL " + name + ": " + error.message);
    process.exitCode = 1;
  }
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

function candidate(title, type = "event", organization = "Organisasi Contoh") {
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
        published: "2026-07-13T01:00:00.000Z",
        penyelenggara: organization,
      };
  return builder.normalizeItem(item, type, 0);
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

test("1. taxonomy valid", () => {
  assert.strictEqual(builder.validateTaxonomy(taxonomy), true);
});

test("2. trigger code unik", () => {
  const codes = taxonomy.triggers.map((entry) => entry.code);
  assert.strictEqual(new Set(codes).size, codes.length);
});

test("3. positive terms valid", () => {
  taxonomy.triggers.forEach((entry) => {
    assert.ok(entry.positive_terms.length > 0);
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
  assert.ok(!triggers.some((trigger) => trigger.trigger_code === "DIRECT_PROCUREMENT"));
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

if (!process.exitCode) console.log(`\nTrigger signal tests passed: ${passed}/${passed}`);
