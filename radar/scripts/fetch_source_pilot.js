#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  SourceError, readJson, validateRegistry, isAllowedUrl, parseRobots, detectLoginPage,
  parseListing, parseDetail, normalizeItem, deduplicateItems, validateNormalizedItem,
  requestUrl, writeJsonAtomic, sleep,
} = require("./lib/source_utils.js");

async function main() {
  const registryFile = process.env.RADAR_SOURCE_REGISTRY ||
    path.join("radar", "config", "source_registry.json");
  const itemsFile = process.env.RADAR_SOURCE_PILOT_OUTPUT ||
    path.join("radar", "docs", "data", "source_pilot_items.json");
  const healthFile = process.env.RADAR_SOURCE_HEALTH_OUTPUT ||
    path.join("radar", "docs", "data", "source_pilot_health.json");
  const fixtureDir = process.env.RADAR_SOURCE_FIXTURE_DIR ||
    path.join("radar", "tests", "fixtures", "sources");
  const offline = /^(1|true)$/i.test(process.env.RADAR_SOURCE_OFFLINE || "");
  const registry = readJson(registryFile, "source registry");
  validateRegistry(registry);
  const options = resolveOptions(registry, process.env);
  const transport = offline
    ? createFixtureTransport(fixtureDir)
    : createLiveTransport(registry, options);
  const result = await runPilot({ registry, options, transport });
  const writeResult = preserveOrWriteOutputs({ result, itemsFile, healthFile, offline });
  console.log(
    `${offline ? "Offline" : "Live"} source pilot: ` +
    `${result.itemsOutput.source_summary.normalized_items} item, ` +
    `${result.itemsOutput.source_summary.healthy_sources} healthy, ` +
    `${result.itemsOutput.source_summary.degraded_sources} degraded.`
  );
  if (writeResult.preserved) {
    throw new Error("Seluruh sumber live gagal; last-known-good dipertahankan dan output item tidak ditimpa.");
  }
  return result;
}

function resolveOptions(registry, env) {
  const requestedCodes = String(env.RADAR_SOURCE_CODES || "").split(",")
    .map((value) => value.trim()).filter(Boolean);
  const maxItems = positiveInteger(env.RADAR_SOURCE_MAX_ITEMS, registry.max_items_per_source);
  const timeoutMs = positiveInteger(env.RADAR_SOURCE_TIMEOUT_MS, registry.request_timeout_ms);
  const selectedSources = registry.sources.filter((source) => source.enabled_for_pilot &&
    (!requestedCodes.length || requestedCodes.includes(source.code)));
  if (requestedCodes.some((code) => !registry.sources.some((source) => source.code === code))) {
    throw new Error("RADAR_SOURCE_CODES memuat source code yang tidak dikenal.");
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
  try {
    const robotsUrl = `https://${source.official_domain}/robots.txt`;
    const robots = await transport.request(source, robotsUrl, "robots");
    if (robots.status === 401 || robots.status === 403 || robots.status === 429) {
      throw new SourceError("ROBOTS_BLOCKED", `robots.txt HTTP ${robots.status}`, { status: robots.status });
    }
    if (robots.status === 200 && !parseRobots(
      robots.body, new URL(source.listing_url).pathname, options.userAgent)) {
      throw new SourceError("ROBOTS_DISALLOWED", "Listing dilarang robots.txt.", { status: robots.status });
    }
    if (robots.status !== 200) health.warnings.push(`ROBOTS_HTTP_${robots.status}`);
    await transport.pause(options.intervalMs);

    const listing = await transport.request(source, source.listing_url, "listing");
    health.http_status = listing.status;
    health.content_type = listing.contentType;
    assertUsableHtml(listing, "listing");
    if (detectLoginPage(listing.body)) throw new SourceError("LOGIN_REQUIRED", "Listing memerlukan login.");
    const parsedListing = parseListing(listing.body, source);
    health.listing_links_found = parsedListing.records.length;
    if (parsedListing.externalLinks) health.warnings.push(
      `EXTERNAL_LINKS_IGNORED:${parsedListing.externalLinks}`);
    if (!parsedListing.records.length) {
      throw new SourceError("NO_STATIC_DETAIL_LINKS", "Tidak ada detail link statis yang valid.");
    }
    const candidates = parsedListing.records.slice(0, options.maxDetails);
    result.rawItems = candidates.length;

    for (let index = 0; index < candidates.length; index += 1) {
      const listingItem = candidates[index];
      if (index > 0) await transport.pause(options.intervalMs);
      health.detail_pages_attempted += 1;
      try {
        const detailResponse = await transport.request(source, listingItem.link, "detail");
        assertUsableHtml(detailResponse, "detail");
        if (detectLoginPage(detailResponse.body)) throw new SourceError("LOGIN_REQUIRED", "Detail memerlukan login.");
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
        result.invalidItems += 1;
        health.invalid_items += 1;
        health.errors.push(`${listingItem.link}:${error.code || "DETAIL_ERROR"}`);
      }
      if (result.items.length >= options.maxItems) break;
    }

    if (!result.items.length) throw new SourceError("NO_VALID_ITEMS", "Tidak ada detail item valid.");
    const optionalWarnings = health.warnings.some((warning) =>
      /MISSING|INVALID_DATE|CANONICAL_IGNORED/.test(warning));
    health.status = optionalWarnings || health.invalid_items > 0 ? "DEGRADED" : "HEALTHY";
  } catch (error) {
    health.status = statusForError(error);
    if (error.status && !health.http_status) health.http_status = error.status;
    health.errors.push(`${error.code || "SOURCE_ERROR"}:${error.message}`);
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
          return response;
        } catch (error) {
          lastError = error;
          if (attempt === 0 && ["TIMEOUT", "NETWORK_ERROR"].includes(error.code)) {
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

function preserveOrWriteOutputs({ result, itemsFile, healthFile, offline }) {
  writeJsonAtomic(healthFile, result.healthOutput);
  const successfulSources = result.itemsOutput.source_summary.healthy_sources +
    result.itemsOutput.source_summary.degraded_sources;
  if (!offline && (!successfulSources || !result.itemsOutput.items.length)) {
    if (hasLastKnownGood(itemsFile)) return { preserved: true };
    throw new Error("Seluruh sumber live gagal dan tidak ada last-known-good non-empty.");
  }
  writeJsonAtomic(itemsFile, result.itemsOutput);
  return { preserved: false };
}

function hasLastKnownGood(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && parsed.schema_version === "1.0.0" && Array.isArray(parsed.items) && parsed.items.length > 0;
  } catch (_) {
    return false;
  }
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
  return true;
}

function createHealth(sourceCode) {
  return {
    source_code: sourceCode,
    status: "UNAVAILABLE",
    http_status: 0,
    content_type: "",
    listing_links_found: 0,
    detail_pages_attempted: 0,
    valid_items: 0,
    invalid_items: 0,
    warnings: [],
    errors: [],
  };
}

function assertUsableHtml(response, label) {
  if ([401, 403, 429].includes(response.status)) {
    throw new SourceError(`HTTP_${response.status}`, `${label} HTTP ${response.status}.`, { status: response.status });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SourceError("HTTP_UNAVAILABLE", `${label} HTTP ${response.status}.`, { status: response.status });
  }
  if (!/^text\/html\b/i.test(response.contentType || "")) {
    throw new SourceError("NON_HTML", `${label} bukan HTML.`);
  }
}

function statusForError(error) {
  if (["HTTP_401", "HTTP_403", "HTTP_429", "ROBOTS_BLOCKED", "ROBOTS_DISALLOWED",
    "LOGIN_REQUIRED"].includes(error.code)) return "BLOCKED";
  if (error.code === "NO_STATIC_DETAIL_LINKS") return "UNSUPPORTED_DYNAMIC_PAGE";
  if (error.code === "INVALID_CONFIGURATION") return "INVALID_CONFIGURATION";
  return "UNAVAILABLE";
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
  assertUsableHtml, statusForError,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`Source pilot gagal: ${error.message}`);
    process.exitCode = 1;
  });
}
