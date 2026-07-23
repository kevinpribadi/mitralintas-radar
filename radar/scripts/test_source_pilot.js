#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const utils = require("./lib/source_utils.js");
const pilot = require("./fetch_source_pilot.js");

const root = path.resolve(__dirname, "..", "..");
const registryPath = path.join(root, "radar", "config", "source_registry.json");
const fixtureDir = path.join(root, "radar", "tests", "fixtures", "sources");
const tempDir = path.join(root, ".tmp", `source-pilot-tests-${process.pid}`);
const registry = utils.readJson(registryPath, "source registry test");
const protectedFiles = [
  "radar/data/tenders.json",
  "radar/data/events.json",
  "radar/docs/data/review_queue.json",
  "radar/docs/data/qualification_readiness.json",
  "radar/docs/data/source_pilot_items.json",
  "radar/docs/data/source_pilot_health.json",
  "radar/docs/data/trigger_signals.json",
];
const initialHashes = hashFiles(protectedFiles);
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

function fixture(name) {
  return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

function source(code) {
  return registry.sources.find((entry) => entry.code === code);
}

function options(sources = registry.sources) {
  return {
    selectedSources: sources,
    maxItems: 50,
    maxDetails: 25,
    timeoutMs: 15000,
    intervalMs: 0,
    userAgent: registry.user_agent,
  };
}

function response(status, contentType, body, url = "") {
  return { status, contentType, body, url };
}

function fixtureTransport(overrides = {}) {
  const transport = pilot.createFixtureTransport(fixtureDir);
  return {
    pause: async () => {},
    async request(sourceConfig, url, kind) {
      if (overrides.request) return overrides.request(sourceConfig, url, kind, transport);
      return transport.request(sourceConfig, url, kind);
    },
  };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function sampleItem(overrides = {}) {
  return Object.assign({
    id: "src_example",
    source_code: "BKPM_PRESS_RELEASES",
    title: "Pabrik Baru Mulai Beroperasi",
    link: "https://www.bkpm.go.id/id/info/siaran-pers/pabrik-baru",
    content_hash: "hash-a",
    published_at: "2026-07-12",
  }, overrides);
}

function hashFiles(files) {
  return Object.fromEntries(files.map((relative) => [relative,
    crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex")]));
}

function failedResult() {
  return {
    itemsOutput: {
      schema_version: "1.0.0",
      content_reference_date: "",
      source_summary: {
        configured_sources: 2, healthy_sources: 0, degraded_sources: 0,
        unavailable_sources: 2, raw_items: 0, normalized_items: 0,
        duplicate_items: 0, invalid_items: 0,
      },
      deduplication: { reason_counts: { canonical_url: 0, content_hash: 0, normalized_title_source: 0 } },
      items: [],
    },
    healthOutput: {
      schema_version: "1.0.0",
      sources: registry.sources.map((entry) => Object.assign(pilot.createHealth(entry.code), {
        errors: ["NETWORK_ERROR:test"],
      })),
    },
  };
}

test("1. source registry valid", () => assert.strictEqual(utils.validateRegistry(registry), true));
test("2. source code unik", () => {
  const codes = registry.sources.map((entry) => entry.code);
  assert.strictEqual(new Set(codes).size, codes.length);
});
test("3. maksimal dua sumber", () => assert.ok(registry.sources.length <= 2));
test("4. exact domain allowlist", () => {
  const bkpm = source("BKPM_PRESS_RELEASES");
  assert.strictEqual(utils.isAllowedUrl(bkpm.listing_url, bkpm), true);
  assert.strictEqual(utils.isAllowedUrl("https://sub.www.bkpm.go.id/id/info/siaran-pers/x", bkpm), false);
  assert.strictEqual(utils.isAllowedUrl("http://www.bkpm.go.id/id/info/siaran-pers/x", bkpm), false);
});
test("5. redirect keluar domain ditolak", () => {
  const bkpm = source("BKPM_PRESS_RELEASES");
  assert.strictEqual(utils.isAllowedRequestUrl("https://evil.example/robots.txt", bkpm), false);
  assert.strictEqual(utils.isAllowedRequestUrl("https://www.bkpm.go.id/robots.txt", bkpm), true);
});
test("6. non-HTML ditolak", () => {
  assert.throws(() => pilot.assertUsableHtml(response(200, "application/json", "{}"), "listing"), /bukan HTML/);
});
test("7. login page terdeteksi", async () => {
  const bkpm = source("BKPM_PRESS_RELEASES");
  const result = await pilot.processSource(bkpm, options([bkpm]), fixtureTransport({
    request: async (config, url, kind, base) => kind === "listing"
      ? response(200, "text/html", '<form class="login"><input type="password"></form>', url)
      : base.request(config, url, kind),
  }));
  assert.strictEqual(result.health.status, "BLOCKED");
});
test("8. 403 ditangani fail-closed", () => {
  assert.throws(() => pilot.assertUsableHtml(response(403, "text/html", ""), "listing"), /HTTP 403/);
});
test("9. 429 ditangani fail-closed", () => {
  assert.throws(() => pilot.assertUsableHtml(response(429, "text/html", ""), "listing"), /HTTP 429/);
});
test("10. timeout tidak membuat output kosong palsu", () => {
  const itemsFile = path.join(tempDir, "last-good-items.json");
  const healthFile = path.join(tempDir, "failed-health.json");
  const lastGood = { schema_version: "1.0.0", items: [{ id: "src_kept" }] };
  utils.writeJsonAtomic(itemsFile, lastGood);
  const before = utils.sha256(fs.readFileSync(itemsFile));
  const result = pilot.preserveOrWriteOutputs({
    result: failedResult(), itemsFile, healthFile, offline: false,
  });
  assert.strictEqual(result.preserved, true);
  assert.strictEqual(utils.sha256(fs.readFileSync(itemsFile)), before);
});
test("11. one-source failure tidak merusak source lain", async () => {
  const run = await pilot.runPilot({
    registry,
    options: options(),
    transport: fixtureTransport({
      request: async (config, url, kind, base) =>
        config.code === "KEMENPERIN_IMC_NEWS" && kind === "listing"
          ? response(403, "text/html", "", url)
          : base.request(config, url, kind),
    }),
  });
  assert.ok(run.itemsOutput.items.length > 0);
  assert.ok(run.itemsOutput.items.every((item) => item.source_code === "BKPM_PRESS_RELEASES"));
  assert.strictEqual(run.healthOutput.sources.find((entry) =>
    entry.source_code === "KEMENPERIN_IMC_NEWS").status, "BLOCKED");
});
test("12. listing parser menemukan detail link", () => {
  const parsed = utils.parseListing(fixture("bkpm_listing.html"), source("BKPM_PRESS_RELEASES"));
  assert.strictEqual(parsed.records.length, 2);
});
test("13. detail parser mengambil title", () => {
  const parsed = utils.parseDetail(fixture("bkpm_detail.html"), source("BKPM_PRESS_RELEASES"),
    "https://www.bkpm.go.id/id/info/siaran-pers/pabrik-baterai-baru");
  assert.strictEqual(parsed.title, "Pabrik Baterai Baru Mulai Beroperasi");
});
test("14. valid date diterima", () => {
  assert.deepStrictEqual(utils.parsePublicDate("12 Juli 2026"), { value: "2026-07-12", status: "valid" });
});
test("15. missing date tidak difabrikasi", () => {
  assert.deepStrictEqual(utils.parsePublicDate(""), { value: "", status: "missing" });
});
test("16. organization publisher tidak dianggap target organization", () => {
  const parsed = utils.parseDetail(fixture("bkpm_detail.html"), source("BKPM_PRESS_RELEASES"),
    "https://www.bkpm.go.id/id/info/siaran-pers/pabrik-baterai-baru");
  assert.strictEqual(parsed.organizationHint, "");
});
test("17. excerpt bersumber dari HTML", () => {
  const html = fixture("bkpm_detail.html");
  const parsed = utils.parseDetail(html, source("BKPM_PRESS_RELEASES"),
    "https://www.bkpm.go.id/id/info/siaran-pers/pabrik-baterai-baru");
  assert.ok(html.includes(parsed.excerpt));
});
test("18. excerpt maksimal 500 karakter", () => {
  const detail = `<html><head><meta name="description" content="${"x".repeat(700)}"></head><body><h1>Judul Detail Valid</h1></body></html>`;
  const parsed = utils.parseDetail(detail, source("BKPM_PRESS_RELEASES"),
    "https://www.bkpm.go.id/id/info/siaran-pers/detail-valid");
  assert.strictEqual(parsed.excerpt.length, 500);
});
test("19. canonical URL dedup", () => {
  const result = utils.deduplicateItems([sampleItem(), sampleItem({ id: "two", content_hash: "hash-b" })]);
  assert.strictEqual(result.reasonCounts.canonical_url, 1);
});
test("20. content hash dedup", () => {
  const result = utils.deduplicateItems([sampleItem(), sampleItem({
    id: "two", link: "https://www.bkpm.go.id/id/info/siaran-pers/different", title: "Judul Berbeda",
  })]);
  assert.strictEqual(result.reasonCounts.content_hash, 1);
});
test("21. normalized title dedup", () => {
  const result = utils.deduplicateItems([sampleItem(), sampleItem({
    id: "two", link: "https://www.bkpm.go.id/id/info/siaran-pers/different",
    title: "PABRIK baru, mulai beroperasi!", content_hash: "hash-b",
  })]);
  assert.strictEqual(result.reasonCounts.normalized_title_source, 1);
});
test("22. stable item ID", () => {
  const args = ["BKPM_PRESS_RELEASES", "https://www.bkpm.go.id/id/info/siaran-pers/x", "Judul X"];
  assert.strictEqual(utils.stableItemId(...args), utils.stableItemId(...args));
});
test("23. stable sorting", () => {
  const items = [sampleItem({ id: "b", title: "B" }), sampleItem({ id: "a", title: "A" })];
  assert.deepStrictEqual(items.slice().sort(utils.compareItems).map((item) => item.id), ["a", "b"]);
});
test("24. atomic output", () => {
  const file = path.join(tempDir, "atomic", "output.json");
  utils.writeJsonAtomic(file, { ok: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { ok: true });
  assert.strictEqual(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp")), false);
});
test("25. output idempotent", async () => {
  const transport = fixtureTransport();
  const first = await pilot.runPilot({ registry, options: options(), transport });
  const second = await pilot.runPilot({ registry, options: options(), transport });
  assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
});
test("26. last-known-good dipertahankan saat seluruh live source gagal", () => {
  const itemsFile = path.join(tempDir, "preserved-items.json");
  const healthFile = path.join(tempDir, "preserved-health.json");
  utils.writeJsonAtomic(itemsFile, { schema_version: "1.0.0", items: [{ id: "src_lkg" }] });
  assert.strictEqual(pilot.preserveOrWriteOutputs({
    result: failedResult(), itemsFile, healthFile, offline: false,
  }).preserved, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(itemsFile, "utf8")).items[0].id, "src_lkg");
});
test("27. external link tidak diikuti", () => {
  const parsed = utils.parseListing(fixture("bkpm_listing.html"), source("BKPM_PRESS_RELEASES"));
  assert.strictEqual(parsed.externalLinks, 1);
  assert.ok(parsed.records.every((item) => new URL(item.link).hostname === "www.bkpm.go.id"));
});
test("27b. external canonical diabaikan tanpa diikuti", async () => {
  const bkpm = source("BKPM_PRESS_RELEASES");
  const listingHtml = '<a href="/id/info/siaran-pers/canonical-test"><p class="date">12 Juli 2026</p><h3>Canonical Test Valid</h3></a>';
  const detailHtml = '<html><head><meta name="description" content="Excerpt publik valid.">' +
    '<link rel="canonical" href="https://external.example/canonical-test"></head>' +
    '<body><h1>Canonical Test Valid</h1></body></html>';
  const result = await pilot.processSource(bkpm, options([bkpm]), fixtureTransport({
    request: async (config, url, kind, base) => {
      if (kind === "listing") return response(200, "text/html", listingHtml, url);
      if (kind === "detail") return response(200, "text/html", detailHtml, url);
      return base.request(config, url, kind);
    },
  }));
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].link,
    "https://www.bkpm.go.id/id/info/siaran-pers/canonical-test");
  assert.strictEqual(result.health.status, "DEGRADED");
  assert.ok(result.health.warnings.some((warning) => warning.includes("CANONICAL_IGNORED_NOT_ALLOWED")));
});
test("28. tidak ada numeric score", async () => {
  const run = await pilot.runPilot({ registry, options: options(), transport: fixtureTransport() });
  assert.strictEqual(/"[^"\n]*score[^"\n]*"\s*:/i.test(JSON.stringify(run)), false);
});
test("29. tidak ada forbidden action", async () => {
  const run = await pilot.runPilot({ registry, options: options(), transport: fixtureTransport() });
  assert.strictEqual(/SEND_EMAIL|SEND_WHATSAPP|CONTACT_PERSON|SUBMIT_OFFER|SUBMIT_BID|SET_PRICE/.test(JSON.stringify(run)), false);
});
test("30. tidak ada kontak pribadi", async () => {
  const run = await pilot.runPilot({ registry, options: options(), transport: fixtureTransport() });
  assert.strictEqual(/"(?:email|phone|telephone|nik|contact_person)"\s*:/i.test(JSON.stringify(run)), false);
});
test("31. source production hashes tidak berubah", () => {
  const current = hashFiles(["radar/data/tenders.json", "radar/data/events.json"]);
  assert.deepStrictEqual(current, Object.fromEntries(Object.entries(initialHashes)
    .filter(([file]) => file.startsWith("radar/data/"))));
});
test("32. trigger_signals hash tidak berubah", () => {
  assert.strictEqual(hashFiles(["radar/docs/data/trigger_signals.json"])["radar/docs/data/trigger_signals.json"],
    initialHashes["radar/docs/data/trigger_signals.json"]);
});
test("33. qualification hash tidak berubah", () => {
  assert.strictEqual(hashFiles(["radar/docs/data/qualification_readiness.json"])["radar/docs/data/qualification_readiness.json"],
    initialHashes["radar/docs/data/qualification_readiness.json"]);
});
test("34. human feedback regression tetap lulus", () => {
  const run = spawnSync(process.execPath, [path.join(root, "radar", "scripts", "test_human_feedback.js")], {
    cwd: root, encoding: "utf8",
  });
  assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

async function listingFailure(resultOrError) {
  const bkpm = source("BKPM_PRESS_RELEASES");
  return pilot.processSource(bkpm, options([bkpm]), fixtureTransport({
    request: async (config, url, kind, base) => {
      if (kind !== "listing") return base.request(config, url, kind);
      if (resultOrError instanceof Error) throw resultOrError;
      return Object.assign({}, resultOrError, { url });
    },
  }));
}

test("35. HTTP 502 tersimpan sebagai LISTING_REQUEST / HTTP_502", async () => {
  const result = await listingFailure(response(502, "text/html", "upstream unavailable"));
  assert.strictEqual(result.health.failure_stage, "LISTING_REQUEST");
  assert.strictEqual(result.health.error_code, "HTTP_502");
  assert.strictEqual(result.health.http_status, 502);
});
test("36. HTTP 403 tersimpan spesifik", async () => {
  const result = await listingFailure(response(403, "text/html", "forbidden"));
  assert.strictEqual(result.health.error_code, "HTTP_403");
  assert.strictEqual(result.health.status, "BLOCKED");
});
test("37. HTTP 429 tersimpan spesifik", async () => {
  const result = await listingFailure(response(429, "text/html", "limited"));
  assert.strictEqual(result.health.error_code, "HTTP_429");
  assert.strictEqual(result.health.status, "BLOCKED");
});
test("38. TLS error code tersimpan", async () => {
  const result = await listingFailure(new utils.SourceError("CERT_HAS_EXPIRED", "certificate has expired", {
    failureStage: "TLS", networkErrorCode: "CERT_HAS_EXPIRED",
    attemptedUrl: source("BKPM_PRESS_RELEASES").listing_url,
  }));
  assert.strictEqual(result.health.failure_stage, "TLS");
  assert.strictEqual(result.health.network_error_code, "CERT_HAS_EXPIRED");
  assert.strictEqual(result.health.error_code, "CERT_HAS_EXPIRED");
});
test("39. DNS error code tersimpan", async () => {
  const result = await listingFailure(new utils.SourceError("ENOTFOUND", "getaddrinfo ENOTFOUND", {
    failureStage: "DNS", networkErrorCode: "ENOTFOUND",
    attemptedUrl: source("BKPM_PRESS_RELEASES").listing_url,
  }));
  assert.strictEqual(result.health.failure_stage, "DNS");
  assert.strictEqual(result.health.network_error_code, "ENOTFOUND");
});
test("40. redirect keluar domain tersimpan tanpa URL eksternal", async () => {
  const result = await listingFailure(new utils.SourceError("REDIRECT_OUTSIDE_DOMAIN",
    "Redirect keluar domain resmi ditolak.", { failureStage: "REDIRECT", redirectHost: "evil.example",
      httpStatus: 302, attemptedUrl: source("BKPM_PRESS_RELEASES").listing_url }));
  assert.strictEqual(result.health.failure_stage, "REDIRECT");
  assert.strictEqual(result.health.redirect_host, "evil.example");
  assert.strictEqual(result.health.attempted_url, source("BKPM_PRESS_RELEASES").listing_url);
  assert.doesNotMatch(JSON.stringify(result.health), /https:\/\/evil\.example/);
});
test("41. content type invalid tersimpan", async () => {
  const result = await listingFailure(response(200, "application/json", "{}"));
  assert.strictEqual(result.health.failure_stage, "CONTENT_TYPE");
  assert.strictEqual(result.health.error_code, "CONTENT_TYPE_INVALID");
  assert.strictEqual(result.health.content_type, "application/json");
});
test("42. listing parser kosong tersimpan", async () => {
  const result = await listingFailure(response(200, "text/html", "<html><body>Tidak ada link</body></html>"));
  assert.strictEqual(result.health.failure_stage, "LISTING_PARSE");
  assert.strictEqual(result.health.error_code, "LISTING_PARSE_EMPTY");
  assert.strictEqual(result.health.listing_links_found, 0);
});
test("43. health ditulis dan LKG eksplisit dibaca sebelum fetch exit", () => {
  const lkgFile = path.join(tempDir, "explicit-lkg.json");
  const proposedFile = path.join(tempDir, "must-not-exist.json");
  const healthFile = path.join(tempDir, "diagnostic-before-exit.json");
  utils.writeJsonAtomic(lkgFile, { schema_version: "1.0.0", items: [{ id: "lkg-1" }, { id: "lkg-2" }] });
  const result = failedResult();
  result.healthOutput.sources[0].error_code = "HTTP_502";
  const write = pilot.preserveOrWriteOutputs({ result, itemsFile: proposedFile, healthFile,
    lastKnownGoodFile: lkgFile, offline: false });
  const saved = JSON.parse(fs.readFileSync(healthFile, "utf8"));
  assert.strictEqual(write.fetchFailed, true);
  assert.strictEqual(write.errorCode, "HTTP_502");
  assert.strictEqual(saved.fetch_status, "LIVE_FETCH_FAILED_USING_LAST_KNOWN_GOOD");
  assert.strictEqual(saved.last_known_good.item_count, 2);
  assert.strictEqual(saved.sources[0].fetch_status, "LIVE_FETCH_FAILED_USING_LAST_KNOWN_GOOD");
  assert.strictEqual(fs.existsSync(proposedFile), false, "LKG tidak boleh dianggap proposal live");
});
test("44. secret header dan response body disanitasi", async () => {
  const message = "Authorization: Bearer topsecret Cookie: session=abc response body: <html>private-body</html>";
  const result = await listingFailure(new utils.SourceError("NETWORK_ERROR", message, {
    failureStage: "LISTING_REQUEST", attemptedUrl: source("BKPM_PRESS_RELEASES").listing_url,
  }));
  const diagnostic = JSON.stringify(result.health);
  assert.doesNotMatch(diagnostic, /topsecret|session=abc|private-body|<html>/i);
  assert.match(result.health.error_message, /REDACTED/);
});
test("45. default selection hanya source accepted", () => {
  const resolved = pilot.resolveOptions(registry, {});
  assert.deepStrictEqual(resolved.selectedSources.map((entry) => entry.code), ["BKPM_PRESS_RELEASES"]);
});
test("46. rejected source tidak selectable secara eksplisit", () => {
  assert.throws(() => pilot.resolveOptions(registry, {
    RADAR_SOURCE_CODES: "KEMENPERIN_IMC_NEWS",
  }), /SOURCE_NOT_SELECTABLE/);
});
test("47. tls trust mode hanya SYSTEM_CA ketika flag aktif", () => {
  assert.strictEqual(pilot.resolveTlsTrustMode({}, []), "NODE_BUNDLED_CA");
  assert.strictEqual(pilot.resolveTlsTrustMode({}, ["--use-system-ca"]), "SYSTEM_CA");
  assert.strictEqual(pilot.resolveTlsTrustMode({ NODE_OPTIONS: "--use-system-ca" }, []), "SYSTEM_CA");
});
test("48. committed source output write diblokir tanpa opt-in", () => {
  assert.throws(() => pilot.assertOutputWriteAllowed(
    "radar/docs/data/source_pilot_items.json", path.join(tempDir, "health.json"), {}),
  /COMMITTED_SOURCE_OUTPUT_WRITE_BLOCKED/);
});
test("49. direct offline fetch tanpa output env memakai default temporary", () => {
  const directDir = path.join(tempDir, "direct-default");
  fs.mkdirSync(directDir, { recursive: true });
  const run = spawnSync(process.execPath, [path.join(root, "radar", "scripts", "fetch_source_pilot.js")], {
    cwd: directDir,
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      RADAR_SOURCE_OFFLINE: "true",
      RADAR_SOURCE_REGISTRY: registryPath,
      RADAR_SOURCE_FIXTURE_DIR: fixtureDir,
    }),
  });
  assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const healthFile = path.join(directDir, ".source-refresh-work", "manual",
    "proposed_source_pilot_health.json");
  const itemsFile = path.join(directDir, ".source-refresh-work", "manual",
    "proposed_source_pilot_items.json");
  assert.strictEqual(fs.existsSync(healthFile), true);
  assert.strictEqual(fs.existsSync(itemsFile), true);
  const saved = JSON.parse(fs.readFileSync(healthFile, "utf8"));
  assert.deepStrictEqual(saved.sources.map((entry) => entry.source_code), ["BKPM_PRESS_RELEASES"]);
});

async function main() {
  fs.mkdirSync(tempDir, { recursive: true });
  let passed = 0;
  try {
    for (const entry of tests) {
      try {
        await entry.fn();
        passed += 1;
        console.log(`PASS ${entry.name}`);
      } catch (error) {
        console.error(`FAIL ${entry.name}: ${error.stack || error.message}`);
        process.exitCode = 1;
      }
    }
    assert.deepStrictEqual(hashFiles(protectedFiles), initialHashes,
      "Protected production files berubah selama test.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(`\n${passed}/${tests.length} source pilot tests passed.`);
  if (passed !== tests.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Source pilot test fatal: ${error.stack || error.message}`);
  process.exitCode = 1;
});
