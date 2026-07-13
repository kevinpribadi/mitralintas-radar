"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const feedback = require("../docs/js/human_feedback.js");

const configPath = path.resolve(__dirname, "../config/human_feedback_rules.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
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

function inputFor(decision) {
  const values = {
    QUALIFIED: {
      human_decision: "QUALIFIED",
      reason_codes: ["PRODUCT_FIT_CONFIRMED"],
      reviewer_alias: "KP",
      note: "Bukti publik telah diperiksa.",
      next_action: "PREPARE_REQUIREMENT_BRIEF",
      review_date: ""
    },
    NEEDS_RESEARCH: {
      human_decision: "NEEDS_RESEARCH",
      reason_codes: ["VERIFY_ORGANIZATION"],
      reviewer_alias: "KP",
      note: "Organisasi perlu diverifikasi.",
      next_action: "VERIFY_ORGANIZATION",
      review_date: ""
    },
    WATCHLIST: {
      human_decision: "WATCHLIST",
      reason_codes: ["EARLY_TRIGGER"],
      reviewer_alias: "KP",
      note: "Pantau buying window.",
      next_action: "",
      review_date: "2026-08-01"
    },
    NOT_RELEVANT: {
      human_decision: "NOT_RELEVANT",
      reason_codes: ["NO_PRODUCT_FIT"],
      reviewer_alias: "KP",
      note: "Tidak ada product fit berdasarkan review manusia.",
      next_action: "",
      review_date: ""
    }
  };
  return JSON.parse(JSON.stringify(values[decision]));
}

function buildRecord(itemId, decision, timestamp, eventId, existing) {
  const result = feedback.createOrUpdateRecord(existing || null, itemId, inputFor(decision), config, {
    now: timestamp,
    event_id: eventId
  });
  assert.strictEqual(result.valid, true, result.errors.join(" "));
  return result.record;
}

test("1. config valid", () => {
  const result = feedback.validateConfig(config);
  assert.strictEqual(result.valid, true, result.errors.join(" "));
});

test("2. QUALIFIED tanpa reason gagal", () => {
  const input = inputFor("QUALIFIED");
  input.reason_codes = [];
  assert.strictEqual(feedback.validateDecisionInput(input, config).valid, false);
});

test("3. QUALIFIED tanpa next action gagal", () => {
  const input = inputFor("QUALIFIED");
  input.next_action = "";
  assert.strictEqual(feedback.validateDecisionInput(input, config).valid, false);
});

test("4. NEEDS_RESEARCH tanpa reason gagal", () => {
  const input = inputFor("NEEDS_RESEARCH");
  input.reason_codes = [];
  assert.strictEqual(feedback.validateDecisionInput(input, config).valid, false);
});

test("5. NEEDS_RESEARCH tanpa next action gagal", () => {
  const input = inputFor("NEEDS_RESEARCH");
  input.next_action = "";
  assert.strictEqual(feedback.validateDecisionInput(input, config).valid, false);
});

test("6. WATCHLIST tanpa reason gagal", () => {
  const input = inputFor("WATCHLIST");
  input.reason_codes = [];
  assert.strictEqual(feedback.validateDecisionInput(input, config).valid, false);
});

test("7. WATCHLIST tanpa review date dan next action gagal", () => {
  const input = inputFor("WATCHLIST");
  input.review_date = "";
  input.next_action = "";
  assert.strictEqual(feedback.validateDecisionInput(input, config).valid, false);
});

test("8. NOT_RELEVANT tanpa reason gagal", () => {
  const input = inputFor("NOT_RELEVANT");
  input.reason_codes = [];
  assert.strictEqual(feedback.validateDecisionInput(input, config).valid, false);
});

test("9. valid record diterima", () => {
  assert.strictEqual(feedback.validateDecisionInput(inputFor("QUALIFIED"), config).valid, true);
});

test("10. invalid decision ditolak", () => {
  const input = inputFor("QUALIFIED");
  input.human_decision = "WON";
  assert.strictEqual(feedback.validateDecisionInput(input, config).valid, false);
});

test("11. invalid reason ditolak", () => {
  const input = inputFor("QUALIFIED");
  input.reason_codes = ["NO_PRODUCT_FIT"];
  assert.strictEqual(feedback.validateDecisionInput(input, config).valid, false);
});

test("12. invalid next action ditolak", () => {
  const input = inputFor("QUALIFIED");
  input.next_action = "SEND_EMAIL";
  assert.strictEqual(feedback.validateDecisionInput(input, config).valid, false);
});

test("13. note lebih dari 500 karakter ditolak", () => {
  const input = inputFor("QUALIFIED");
  input.note = "x".repeat(501);
  assert.strictEqual(feedback.validateDecisionInput(input, config).valid, false);
});

test("14. alias lebih dari 50 karakter ditolak", () => {
  const input = inputFor("QUALIFIED");
  input.reviewer_alias = "x".repeat(51);
  assert.strictEqual(feedback.validateDecisionInput(input, config).valid, false);
});

test("15. history append-only", () => {
  const first = buildRecord("item-1", "QUALIFIED", "2026-07-13T01:00:00.000Z", "event-1");
  const originalHistory = JSON.stringify(first.history);
  buildRecord("item-1", "NEEDS_RESEARCH", "2026-07-13T02:00:00.000Z", "event-2", first);
  assert.strictEqual(JSON.stringify(first.history), originalHistory);
});

test("16. update membuat history event baru", () => {
  const first = buildRecord("item-2", "QUALIFIED", "2026-07-13T01:00:00.000Z", "event-a");
  const second = buildRecord("item-2", "WATCHLIST", "2026-07-13T02:00:00.000Z", "event-b", first);
  assert.strictEqual(second.history.length, 2);
  assert.strictEqual(second.history[1].event_type, "DECISION_UPDATED");
  assert.strictEqual(second.history[1].previous_decision, "QUALIFIED");
});

test("17. import merge tidak menghapus history", () => {
  const local = buildRecord("item-3", "QUALIFIED", "2026-07-13T01:00:00.000Z", "local-event");
  const imported = buildRecord("item-3", "NEEDS_RESEARCH", "2026-07-13T02:00:00.000Z", "import-event");
  const merged = feedback.mergeRecord(local, imported);
  assert.deepStrictEqual(merged.history.map((event) => event.event_id), ["local-event", "import-event"]);
});

test("18. duplicate event ID tidak menggandakan history", () => {
  const record = buildRecord("item-4", "QUALIFIED", "2026-07-13T01:00:00.000Z", "same-event");
  const merged = feedback.mergeRecord(record, JSON.parse(JSON.stringify(record)));
  assert.strictEqual(merged.history.length, 1);
});

test("19. updated_at terbaru menjadi current state", () => {
  const local = buildRecord("item-5", "QUALIFIED", "2026-07-13T01:00:00.000Z", "older");
  const imported = buildRecord("item-5", "NOT_RELEVANT", "2026-07-13T03:00:00.000Z", "newer");
  assert.strictEqual(feedback.mergeRecord(local, imported).human_decision, "NOT_RELEVANT");
});

test("20. orphaned record dipertahankan", () => {
  const orphan = buildRecord("orphan-1", "WATCHLIST", "2026-07-13T01:00:00.000Z", "orphan-event");
  const payload = { schema_version: config.schema_version, records: { "orphan-1": orphan } };
  const preview = feedback.previewImport(payload, feedback.emptyRoot(config.schema_version), config, ["active-1"]);
  const merged = feedback.applyImport(preview, feedback.emptyRoot(config.schema_version), config, "2026-07-13T02:00:00.000Z");
  assert.strictEqual(preview.counts.orphaned, 1);
  assert.ok(merged.records["orphan-1"]);
});

test("21. user input tidak dirender sebagai HTML", () => {
  const fakeElement = { textContent: "" };
  feedback.setText(fakeElement, '<img src=x onerror="alert(1)">');
  assert.strictEqual(fakeElement.textContent, '<img src=x onerror="alert(1)">');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(fakeElement, "innerHTML"), false);
});

test("22. fallback localStorage unavailable tidak crash", () => {
  const unavailable = {
    setItem() { throw new Error("blocked"); },
    getItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); }
  };
  const storage = feedback.createStorage(unavailable, config);
  const root = feedback.emptyRoot(config.schema_version);
  root.records.test = { item_id: "test" };
  assert.strictEqual(storage.persistent, false);
  assert.doesNotThrow(() => storage.save(root));
  assert.ok(storage.load().records.test);
});

test("23. Review Berikutnya hanya memilih UNREVIEWED sesuai prioritas", () => {
  const items = [
    { id: "info", readiness_state: "NEEDS_MORE_INFORMATION" },
    { id: "ready-reviewed", readiness_state: "READY_FOR_HUMAN_QUALIFICATION" },
    { id: "data-review", readiness_state: "NEEDS_DATA_REVIEW" }
  ];
  const records = { "ready-reviewed": { human_decision: "QUALIFIED" } };
  assert.strictEqual(feedback.nextUnreviewed(items, records).item.id, "data-review");
});

test("24. invalid review date ditolak", () => {
  const input = inputFor("WATCHLIST");
  input.review_date = "2026-02-30";
  assert.strictEqual(feedback.validateDecisionInput(input, config).valid, false);
});

test("25. import schema invalid ditolak", () => {
  const preview = feedback.previewImport({ schema_version: "2.0.0", records: {} },
    feedback.emptyRoot(config.schema_version), config, []);
  assert.strictEqual(preview.valid, false);
});

test("26. write failure beralih ke in-memory fallback", () => {
  const storageLike = {
    setItem(key) { if (!key.endsWith("_probe")) throw new Error("quota"); },
    getItem() { return null; },
    removeItem() {}
  };
  const storage = feedback.createStorage(storageLike, config);
  const root = feedback.emptyRoot(config.schema_version);
  root.records.test = { item_id: "test" };
  assert.strictEqual(storage.persistent, true);
  assert.strictEqual(storage.save(root), false);
  assert.strictEqual(storage.persistent, false);
  assert.ok(storage.load().records.test);
});

test("27. event ID lintas record pada import ditolak", () => {
  const first = buildRecord("cross-1", "QUALIFIED", "2026-07-13T01:00:00.000Z", "cross-event");
  const second = buildRecord("cross-2", "NEEDS_RESEARCH", "2026-07-13T02:00:00.000Z", "cross-event");
  const preview = feedback.previewImport({
    schema_version: config.schema_version,
    records: { "cross-1": first, "cross-2": second }
  }, feedback.emptyRoot(config.schema_version), config, ["cross-1", "cross-2"]);
  assert.strictEqual(preview.counts.valid, 1);
  assert.strictEqual(preview.counts.invalid, 1);
});

test("Audit synthetic: empat state, dua update, export/import round-trip", () => {
  const root = feedback.emptyRoot(config.schema_version);
  root.records.qualified = buildRecord("qualified", "QUALIFIED", "2026-07-13T01:00:00.000Z", "audit-q");
  root.records.research = buildRecord("research", "NEEDS_RESEARCH", "2026-07-13T01:01:00.000Z", "audit-r");
  root.records.watchlist = buildRecord("watchlist", "WATCHLIST", "2026-07-13T01:02:00.000Z", "audit-w");
  root.records.irrelevant = buildRecord("irrelevant", "NOT_RELEVANT", "2026-07-13T01:03:00.000Z", "audit-n");

  let changed = buildRecord("qualified", "NEEDS_RESEARCH", "2026-07-13T02:00:00.000Z", "audit-q-2", root.records.qualified);
  changed = buildRecord("qualified", "WATCHLIST", "2026-07-13T03:00:00.000Z", "audit-q-3", changed);
  root.records.qualified = changed;
  root.updated_at = changed.updated_at;
  assert.strictEqual(changed.history.length, 3);

  const exported = feedback.buildExport(root, config, "2026-07-13T04:00:00.000Z");
  const preview = feedback.previewImport(exported, feedback.emptyRoot(config.schema_version), config,
    ["qualified", "research", "watchlist", "irrelevant"]);
  assert.strictEqual(preview.valid, true);
  assert.strictEqual(preview.counts.valid, 4);
  const imported = feedback.applyImport(preview, feedback.emptyRoot(config.schema_version), config,
    "2026-07-13T05:00:00.000Z");
  assert.deepStrictEqual(imported.records, root.records);
  console.log("AUDIT synthetic: QUALIFIED, NEEDS_RESEARCH, WATCHLIST, NOT_RELEVANT valid; history=3; round-trip=identik");
});

if (!process.exitCode) console.log("\nHuman feedback tests passed: " + passed + "/" + passed);
