#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const OUTPUT_DIR_LABEL = ".source-refresh-work/manual";
const OUTPUT_DIR = path.join(".source-refresh-work", "manual");
const ITEMS_OUTPUT = path.join(OUTPUT_DIR, "proposed_source_pilot_items.json");
const HEALTH_OUTPUT = path.join(OUTPUT_DIR, "proposed_source_pilot_health.json");

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, filePath), "utf8")); }
  catch (_) { return null; }
}

function printSummary(health) {
  const sources = health && Array.isArray(health.sources) ? health.sources : [];
  const source = sources.find((entry) => entry && entry.source_code === "BKPM_PRESS_RELEASES") || {};
  const warningCount = sources.reduce((total, entry) =>
    total + (Array.isArray(entry.warnings) ? entry.warnings.length : 0), 0);
  const validItemCount = sources.reduce((total, entry) => total + (Number(entry.valid_items) || 0), 0);
  console.log("\nSafe source refresh summary");
  console.log(`source: ${source.source_code || "BKPM_PRESS_RELEASES"}`);
  console.log(`status: ${source.status || health && health.fetch_status || "FAILED_BEFORE_HEALTH_OUTPUT"}`);
  console.log(`tls trust mode: ${source.tls_trust_mode || "SYSTEM_CA"}`);
  console.log(`valid item count: ${validItemCount}`);
  console.log(`warning count: ${warningCount}`);
  console.log(`error code: ${source.error_code || ""}`);
  console.log(`output directory: ${OUTPUT_DIR_LABEL}`);
}

function main() {
  const absoluteOutputDir = path.join(ROOT, OUTPUT_DIR);
  fs.mkdirSync(absoluteOutputDir, { recursive: true });
  [ITEMS_OUTPUT, HEALTH_OUTPUT].forEach((file) =>
    fs.rmSync(path.join(ROOT, file), { force: true }));

  const env = Object.assign({}, process.env, {
    RADAR_SOURCE_CODES: "BKPM_PRESS_RELEASES",
    RADAR_SOURCE_PILOT_OUTPUT: ITEMS_OUTPUT,
    RADAR_SOURCE_HEALTH_OUTPUT: HEALTH_OUTPUT,
    RADAR_SOURCE_LAST_KNOWN_GOOD_FILE: path.join("radar", "docs", "data", "source_pilot_items.json"),
  });
  delete env.RADAR_ALLOW_COMMITTED_SOURCE_WRITE;

  const child = spawnSync(process.execPath,
    ["--use-system-ca", path.join("radar", "scripts", "fetch_source_pilot.js")], {
      cwd: ROOT,
      env,
      stdio: "inherit",
    });
  const health = readJson(HEALTH_OUTPUT);
  printSummary(health);
  if (child.error) {
    console.error(`Safe source refresh gagal dijalankan: ${child.error.message}`);
    return 1;
  }
  return child.status === 0 ? 0 : (child.status || 1);
}

if (require.main === module) process.exitCode = main();

module.exports = { main, printSummary, OUTPUT_DIR, OUTPUT_DIR_LABEL, ITEMS_OUTPUT, HEALTH_OUTPUT };
