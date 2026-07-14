#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  SourceError, readJson, validateRegistry, isAllowedUrl, parseRobots, detectLoginPage,
  parseListing, parseDetail, normalizeItem, deduplicateItems, validateNormalizedItem,
  requestUrl, writeJsonAtomic, sleep, isAllowedRequestUrl, sanitizeDiagnosticMessage,
} = require("./lib/source_utils.js");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");
const MANUAL_OUTPUT_DIR = path.join(".source-refresh-work", "manual");
const COMMITTED_ITEMS_FILE = path.join("radar", "docs", "data", "source_pilot_items.json");
const COMMITTED_HEALTH_FILE = path.join("radar", "docs", "data", "source_pilot_health.json");
const ACCEPTED_STATUS = "ACCEPTED_FOR_TRIGGER_PILOT";

async function main() {
  const registryFile = process.env.RADAR_SOURCE_REGISTRY ||
    path.join("radar", "config", "source_registry.json");
  const itemsFile = process.env.RADAR_SOURCE_PILOT_OUTPUT ||
    path.join(MANUAL_OUTPUT_DIR, "proposed_source_pilot_items.json");
  const healthFile = process.env.RADAR_SOURCE_HEALTH_OUTPUT ||
    path.join(MANUAL_OUTPUT_DIR, "proposed_source_pilot_health.json");
  const lastKnownGoodFile = process.env.RADAR_SOURCE_LAST_KNOWN_GOOD_FILE || COMMITTED_ITEMS_FILE;
  const fixtureDir = process.env.RADAR_SOURCE_FIXTURE_DIR ||
    path.join("radar", "tests", "fixtures", "sources");
  const offline = /^(1|true)$/i.test(process.env.RADAR_SOURCE_OFFLINE || "");
  assertOutputWriteAllowed(itemsFile, healthFile, process.env);
  const registry = readJson(registryFile, "source registry");
  validateRegistry(registry);
  const options = resolveOptions(registry, process.env);
  const transport = offline
    ? createFixtureTransport(fixtureDir)
    : createLiveTransport(registry, options);
  const result = await runPilot({ registry, options, transport });
  const writeResult = preserveOrWriteOutputs({
    result, itemsFile, healthFile, lastKnownGoodFile, offline,
  });
  result.healthOutput.sources.filter((health) => health.error_code).forEach((health) => {
    console.error(`${health.source_code} failed at ${health.failure_stage}: ${health.error_code}`);
  });
  console.log(
    `${offline ? "Offline" : "Live"} source pilot: ` +
    `${result.itemsOutput.source_summary.normalized_items} item, ` +
    `${result.itemsOutput.source_summary.healthy_sources} healthy, ` +
    `${result.itemsOutput.source_summary.degraded_sources} degraded.`
  );
  if (writeResult.fetchFailed) {
    throw new Error(`SOURCE_FETCH_FAILED: ${writeResult.errorCode}`);
  }
  return result;
}

function resolveOptions(registry, env) {
  const requestedCodes = String(env.RADAR_SOURCE_CODES || "").split(",")
    .map((value) => value.trim()).filter(Boolean);
  const maxItems = positiveInteger(env.RADAR_SOURCE_MAX_ITEMS, registry.max_items_per_source);
  const timeoutMs = positiveInteger(env.RADAR_SOURCE_TIMEOUT_MS, registry.request_timeout_ms);
  const acceptedSources = registry.sources.filter((source) =>
    source.enabled_for_pilot && source.acceptance_status === ACCEPTED_STATUS);
  const selectedSources = acceptedSources.filter((source) =>
    !requestedCodes.length || requestedCodes.includes(source.code));
  if (requestedCodes.some((code) => !registry.sources.some((source) => source.code === code))) {
    throw new Error("RADAR_SOURCE_CODES memuat source code yang tidak dikenal.");
  }
  if (requestedCodes.some((code) => !acceptedSources.some((source) => source.code === code))) {
    throw new Error("SOURCE_NOT_SELECTABLE: source harus berstatus ACCEPTED_FOR_TRIGGER_PILOT.");
  }
  return {
    selectedSources,
    maxItems: Math.min(maxItems, registry.max_items_per_source),
    maxDetails: Math.min(registry.max_detail_requests_per_source, maxItems),
    timeoutMs,
    intervalMs: registry.request_interval_ms,
    userAgent: registry.user_agent,
  };
}

async function runPilot({ registry, options, transport }) {
  validateRegistry(registry);
  const sourceResults = [];
  for (const source of options.selectedSources) {
    sourceResults.push(await processSource(source, options, transport));
  }

  const allItems = sourceResults.flatMap((result) => result.items);
  const deduplicated = deduplicateItems(allItems);
  const healthSources = sourceResults.map((result) => result.health);
  const rawItems = sourceResults.reduce((sum, result) => sum + result.rawItems, 0);
  const invalidItems = sourceResults.reduce((sum, result) => sum + result.invalidItems, 0);
  const healthySources = healthSources.filter((source) => source.status === "HEALTHY").length;
  const degradedSources = healthSources.filter((source) => source.status === "DEGRADED").length;
  const validDates = deduplicated.items.map((item) => item.published_at).filter(Boolean).sort();

  const itemsOutput = {
    schema_version: "1.0.0",
    content_reference_date: validDates.length ? validDates[validDates.length - 1] : "",
    source_summary: {
      configured_sources: options.selectedSources.length,
      healthy_sources: healthySources,
      degraded_sources: degradedSources,
      unavailable_sources: options.selectedSources.length - healthySources - degradedSources,
      raw_items: rawItems,
      normalized_items: deduplicated.items.length,
      duplicate_items: deduplicated.duplicateCount,
      invalid_items: invalidItems,
    },
    deduplication: { reason_counts: deduplicated.reasonCounts },
    items: deduplicated.items,
  };
  const healthOutput = { schema_version: "1.0.0", sources: healthSources };
  validatePilotOutputs(itemsOutput, healthOutput, registry);
  return { itemsOutput, healthOutput };
}

async function processSource(source, options, transport) {
  const health = createHealth(source.code);
  const result = { health, items: [], rawItems: 0, invalidItems: 0 };
  let currentStage = "LISTING_REQUEST";
  let attemptedUrl = source.listing_url;
  try {
    const robotsUrl = `https://${source.official_domain}/robots.txt`;
    attemptedUrl = robotsUrl;
    const robots = await transport.request(source, robotsUrl, "robots");
    if (robots.status === 401 || robots.status === 403 || robots.status === 429) {
      throw responseError(`HTTP_${robots.status}`, `robots.txt HTTP ${robots.status}.`,
        robots, "LISTING_REQUEST");
    }
    if (robots.status === 200 && !parseRobots(
      robots.body, new URL(source.listing_url).pathname, options.userAgent)) {
      throw responseError("ROBOTS_DISALLOWED", "Listing dilarang robots.txt.",
        robots, "LISTING_REQUEST");
    }
    if (robots.status !== 200) health.warnings.push(`ROBOTS_HTTP_${robots.status}`);
    await transport.pause(options.intervalMs);

    attemptedUrl = source.listing_url;
    currentStage = "LISTING_REQUEST";
    const listing = await transport.request(source, source.listing_url, "listing");
    health.http_status = listing.status;
    health.content_type = listing.contentType;
    assertUsableHtml(listing, "listing");
    if (detectLoginPage(listing.body)) throw responseError(
      "LOGIN_REQUIRED", "Listing memerlukan login.", listing, "LISTING_PARSE");
    currentStage = "LISTING_PARSE";
    const parsedListing = parseListing(listing.body, source);
    health.listing_links_found = parsedListing.records.length;
    if (parsedListing.externalLinks) health.warnings.push(
      `EXTERNAL_LINKS_IGNORED:${parsedListing.externalLinks}`);
    if (!parsedListing.records.length) {
      throw responseError("LISTING_PARSE_EMPTY", "Listing tidak menghasilkan detail link resmi.",
        listing, "LISTING_PARSE");
    }
    const candidates = parsedListing.records.slice(0, options.maxDetails);
    result.rawItems = candidates.length;
    let firstDetailError = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const listingItem = candidates[index];
      if (index > 0) await transport.pause(options.intervalMs);
      health.detail_pages_attempted += 1;
      try {
        attemptedUrl = listingItem.link;
        currentStage = "DETAIL_REQUEST";
        const detailResponse = await transport.request(source, listingItem.link, "detail");
        assertUsableHtml(detailResponse, "detail");
        if (detectLoginPage(detailResponse.body)) throw responseError(
          "LOGIN_REQUIRED", "Detail memerlukan login.", detailResponse, "DETAIL_PARSE");
        currentStage = "DETAIL_PARSE";
        const detail = parseDetail(detailResponse.body, source, listingItem.link);
        if (!isAllowedUrl(detail.canonicalUrl, source)) {
          health.warnings.push(`${listingItem.link}:CANONICAL_IGNORED_NOT_ALLOWED`);
          detail.canonicalUrl = listingItem.link;
        }
        const item = normalizeItem(listingItem, detail, source);
        const errors = validateNormalizedItem(item, source);
        if (errors.length) throw new SourceError("ITEM_INVALID", errors.join(","));
        result.items.push(item);
        health.valid_items += 1;
        if (item.quality.date_status !== "valid") health.warnings.push(
          `${item.id}:${item.quality.date_status.toUpperCase()}_DATE`);
        if (item.quality.excerpt_status === "missing") health.warnings.push(`${item.id}:MISSING_EXCERPT`);
      } catch (error) {
        enrichSourceError(error, currentStage, attemptedUrl);
        if (!firstDetailError) firstDetailError = error;
        recordHealthFailure(health, error, source);
        result.invalidItems += 1;
        health.invalid_items += 1;
        health.errors.push(`DETAIL_FAILURE:${safeErrorCode(error.code)}`);
      }
      if (result.items.length >= options.maxItems) break;
    }

    if (!result.items.length) throw firstDetailError || new SourceError(
      "DETAIL_PARSE_EMPTY", "Tidak ada detail item valid.", {
        failureStage: "DETAIL_PARSE", attemptedUrl,
      });
    const optionalWarnings = health.warnings.some((warning) =>
      /MISSING|INVALID_DATE|CANONICAL_IGNORED/.test(warning));
    health.status = optionalWarnings || health.invalid_items > 0 ? "DEGRADED" : "HEALTHY";
  } catch (error) {
    enrichSourceError(error, currentStage, attemptedUrl);
    health.status = statusForError(error);
    recordHealthFailure(health, error, source);
    health.errors.push(`${safeErrorCode(error.code)}:${sanitizeDiagnosticMessage(error.message)}`);
    result.items = [];
    result.invalidItems = Math.max(result.invalidItems, health.invalid_items);
  }
  health.warnings = [...new Set(health.warnings)].sort();
  health.errors = [...new Set(health.errors)].sort();
  return result;
}

function createLiveTransport(registry, options) {
  return {
    offline: false,
    pause: sleep,
    async request(source, url, kind) {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await requestUrl(url, source, {
            timeoutMs: options.timeoutMs,
            userAgent: registry.user_agent,
            accept: kind === "robots" ? "text/plain,*/*" : "text/html,application/xhtml+xml",
          });
          if (response.status >= 500 && attempt === 0) {
            await sleep(options.intervalMs);
            continue;
          }
          response.retryCount = attempt;
          return response;
        } catch (error) {
          lastError = error;
          if (kind === "detail" && error.failureStage === "LISTING_REQUEST") {
            error.failureStage = "DETAIL_REQUEST";
          }
          error.retryCount = attempt;
          if (attempt === 0 && ["TIMEOUT", "NETWORK_ERROR", "ECONNRESET", "EAI_AGAIN"].includes(error.code)) {
            await sleep(options.intervalMs);
            continue;
          }
          throw error;
        }
      }
      throw lastError;
    },
  };
}

function createFixtureTransport(fixtureDir) {
  return {
    offline: true,
    pause: async () => {},
    async request(source, url, kind) {
      if (kind === "robots") return { status: 200, contentType: "text/plain", body: "User-agent: *\nDisallow: /login\n", url };
      const suffix = kind === "listing" ? "listing" : "detail";
      const filePath = path.join(fixtureDir, `${source.fixture_prefix}_${suffix}.html`);
      return { status: 200, contentType: "text/html; charset=UTF-8", body: fs.readFileSync(filePath, "utf8"), url };
    },
  };
}

function preserveOrWriteOutputs({ result, itemsFile, healthFile, lastKnownGoodFile = "", offline }) {
  const successfulSources = result.itemsOutput.source_summary.healthy_sources +
    result.itemsOutput.source_summary.degraded_sources;
  if (!offline && (!successfulSources || !result.itemsOutput.items.length)) {
    const lkgFile = lastKnownGoodFile || itemsFile;
    const hasLkg = hasLastKnownGood(lkgFile);
    const errorCode = primaryFailureCode(result.healthOutput);
    result.healthOutput.fetch_status = hasLkg
      ? "LIVE_FETCH_FAILED_USING_LAST_KNOWN_GOOD" : "LIVE_FETCH_FAILED";
    result.healthOutput.last_known_good = {
      available: hasLkg,
      item_count: hasLkg ? lastKnownGoodCount(lkgFile) : 0,
    };
    result.healthOutput.sources.forEach((source) => {
      source.fetch_status = result.healthOutput.fetch_status;
    });
    writeJsonAtomic(healthFile, result.healthOutput);
    return { fetchFailed: true, preserved: hasLkg, errorCode };
  }
  result.healthOutput.fetch_status = offline ? "OFFLINE_FIXTURE_SUCCEEDED" : "LIVE_FETCH_SUCCEEDED";
  writeJsonAtomic(healthFile, result.healthOutput);
  writeJsonAtomic(itemsFile, result.itemsOutput);
  return { fetchFailed: false, preserved: false, errorCode: "" };
}

function hasLastKnownGood(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && parsed.schema_version === "1.0.0" && Array.isArray(parsed.items) && parsed.items.length > 0;
  } catch (_) {
    return false;
  }
}

function lastKnownGoodCount(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")).items.length; }
  catch (_) { return 0; }
}

function primaryFailureCode(healthOutput) {
  const failed = healthOutput.sources.find((source) => source.error_code);
  return failed ? failed.error_code : "LIVE_FETCH_FAILED";
}

function validatePilotOutputs(itemsOutput, healthOutput, registry) {
  const summary = itemsOutput.source_summary;
  if (summary.normalized_items !== itemsOutput.items.length) throw new Error("normalized_items tidak konsisten.");
  if (summary.healthy_sources + summary.degraded_sources + summary.unavailable_sources !==
      summary.configured_sources) throw new Error("source status count tidak konsisten.");
  const sourceByCode = new Map(registry.sources.map((source) => [source.code, source]));
  itemsOutput.items.forEach((item) => {
    const source = sourceByCode.get(item.source_code);
    if (!source || validateNormalizedItem(item, source).length) throw new Error(`Item output tidak valid: ${item.id}`);
  });
  if (!Array.isArray(healthOutput.sources) || healthOutput.sources.some((source) =>
    !["HEALTHY", "DEGRADED", "UNAVAILABLE", "BLOCKED",
      "UNSUPPORTED_DYNAMIC_PAGE", "INVALID_CONFIGURATION"].includes(source.status))) {
    throw new Error("Health output tidak valid.");
  }
  if (healthOutput.sources.some((source) =>
    !["SYSTEM_CA", "NODE_BUNDLED_CA"].includes(source.tls_trust_mode))) {
    throw new Error("TLS trust mode health output tidak valid.");
  }
  return true;
}

function createHealth(sourceCode) {
  return {
    source_code: sourceCode,
    tls_trust_mode: resolveTlsTrustMode(process.env, process.execArgv),
    status: "UNAVAILABLE",
    failure_stage: "",
    error_code: "",
    error_message: "",
    attempted_url: "",
    http_status: 0,
    content_type: "",
    redirect_host: "",
    network_error_code: "",
    retry_count: 0,
    listing_links_found: 0,
    detail_pages_attempted: 0,
    valid_items: 0,
    invalid_items: 0,
    warnings: [],
    errors: [],
  };
}

function resolveTlsTrustMode(env = process.env, execArgv = process.execArgv) {
  const nodeOptions = String(env.NODE_OPTIONS || "").split(/\s+/).filter(Boolean);
  const argv = Array.isArray(execArgv) ? execArgv : [];
  return argv.includes("--use-system-ca") || nodeOptions.includes("--use-system-ca")
    ? "SYSTEM_CA" : "NODE_BUNDLED_CA";
}

function assertOutputWriteAllowed(itemsFile, healthFile, env = process.env) {
  if (/^true$/i.test(String(env.RADAR_ALLOW_COMMITTED_SOURCE_WRITE || ""))) return true;
  const committed = [COMMITTED_ITEMS_FILE, COMMITTED_HEALTH_FILE]
    .map((file) => path.resolve(REPOSITORY_ROOT, file));
  const outputs = [itemsFile, healthFile].map((file) => path.resolve(REPOSITORY_ROOT, file));
  if (outputs.some((file) => committed.includes(file))) {
    const error = new Error("COMMITTED_SOURCE_OUTPUT_WRITE_BLOCKED");
    error.code = "COMMITTED_SOURCE_OUTPUT_WRITE_BLOCKED";
    throw error;
  }
  return true;
}

function assertUsableHtml(response, label) {
  if (response.status < 200 || response.status >= 300) {
    throw responseError(`HTTP_${response.status}`, `${label} HTTP ${response.status}.`, response,
      label === "detail" ? "DETAIL_REQUEST" : "LISTING_REQUEST");
  }
  if (!/^text\/html\b/i.test(response.contentType || "")) {
    throw responseError("CONTENT_TYPE_INVALID", `${label} bukan HTML.`, response, "CONTENT_TYPE");
  }
}

function statusForError(error) {
  if (["HTTP_401", "HTTP_403", "HTTP_429", "ROBOTS_BLOCKED", "ROBOTS_DISALLOWED",
    "LOGIN_REQUIRED"].includes(error.code)) return "BLOCKED";
  if (["LISTING_PARSE_EMPTY", "DETAIL_PARSE_EMPTY"].includes(error.code)) return "DEGRADED";
  return "UNAVAILABLE";
}

function responseError(code, message, response, failureStage) {
  return new SourceError(code, message, {
    failureStage,
    attemptedUrl: response && response.url || "",
    status: response && response.status || 0,
    httpStatus: response && response.status || 0,
    contentType: response && response.contentType || "",
    retryCount: response && response.retryCount || 0,
  });
}

function enrichSourceError(error, failureStage, attemptedUrl) {
  if (!(error instanceof Error)) return;
  if (!error.code) error.code = "SOURCE_ERROR";
  if (!error.failureStage) error.failureStage = failureStage;
  if (!error.attemptedUrl) error.attemptedUrl = attemptedUrl;
}

function recordHealthFailure(health, error, source) {
  health.failure_stage = safeFailureStage(error.failureStage);
  health.error_code = safeErrorCode(error.code);
  health.error_message = sanitizeDiagnosticMessage(error.message);
  health.attempted_url = safeAttemptedUrl(error.attemptedUrl, source);
  health.http_status = Number(error.httpStatus || error.status || health.http_status) || 0;
  health.content_type = sanitizeContentType(error.contentType || health.content_type);
  health.redirect_host = safeHost(error.redirectHost);
  health.network_error_code = safeErrorCode(error.networkErrorCode, "");
  health.retry_count = Math.max(0, Number(error.retryCount) || 0);
}

function safeFailureStage(value) {
  const stage = String(value || "").toUpperCase();
  return ["DNS", "TLS", "LISTING_REQUEST", "REDIRECT", "CONTENT_TYPE", "LISTING_PARSE",
    "DETAIL_REQUEST", "DETAIL_PARSE"].includes(stage) ? stage : "LISTING_REQUEST";
}

function safeErrorCode(value, fallback = "SOURCE_ERROR") {
  const code = String(value || "").toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : fallback;
}

function safeAttemptedUrl(value, source) {
  return isAllowedRequestUrl(value, source) ? new URL(value).toString() : "";
}

function safeHost(value) {
  const host = String(value || "").toLowerCase();
  return /^(?=.{1,253}$)[a-z0-9.-]+$/.test(host) ? host : "";
}

function sanitizeContentType(value) {
  const contentType = String(value || "").replace(/[\r\n]/g, "").trim();
  return /^[a-z0-9!#$&^_.+\/-]+(?:\s*;\s*[a-z0-9!#$&^_.+\/-]+=(?:[a-z0-9!#$&^_.+\/-]+|"[^"]*"))*$/i
    .test(contentType) ? contentType.slice(0, 160) : "";
}

function positiveInteger(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Environment integer tidak valid: ${value}`);
  return parsed;
}

module.exports = {
  main, resolveOptions, runPilot, processSource, createLiveTransport, createFixtureTransport,
  preserveOrWriteOutputs, hasLastKnownGood, validatePilotOutputs, createHealth,
  assertUsableHtml, statusForError, responseError, recordHealthFailure, safeFailureStage,
  safeErrorCode, safeAttemptedUrl, sanitizeContentType, primaryFailureCode,
  resolveTlsTrustMode, assertOutputWriteAllowed,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`Source pilot gagal: ${error.message}`);
    process.exitCode = 1;
  });
}
