#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const CURRENT_DIR = process.env.RADAR_CURRENT_DIR || path.join("radar", "data");
const PREVIOUS_DIR = process.env.RADAR_PREVIOUS_DIR || ".radar-prev";
const MIN_TENDER_ITEMS = readNumberEnv("RADAR_MIN_TENDER_ITEMS", 5);
const MIN_EVENT_ITEMS = readNumberEnv("RADAR_MIN_EVENT_ITEMS", 5);
const MAX_DROP_RATIO = readNumberEnv("RADAR_MAX_DROP_RATIO", 0.70);

const checks = [
  {
    label: "tenders.json",
    file: "tenders.json",
    minItems: MIN_TENDER_ITEMS,
  },
  {
    label: "events.json",
    file: "events.json",
    minItems: MIN_EVENT_ITEMS,
  },
];

const failures = [];

checks.forEach((check) => {
  const currentPath = path.join(CURRENT_DIR, check.file);
  const previousPath = path.join(PREVIOUS_DIR, check.file);
  const currentCount = readItemCount(currentPath);

  if (currentCount === 0) {
    fail(`${check.label}: hasil scrape 0 item. Publikasi dihentikan untuk review.`);
  } else if (currentCount < check.minItems) {
    fail(
      `${check.label}: hasil scrape ${currentCount} item, di bawah threshold ` +
      `${check.minItems}. Publikasi dihentikan untuk review.`
    );
  }

  if (!fs.existsSync(previousPath)) {
    console.warn(
      `::warning::${check.label}: snapshot sebelumnya tidak ditemukan di ` +
      `${previousPath}; cek drop dilewati.`
    );
    return;
  }

  const previousCount = readItemCount(previousPath);
  if (previousCount <= 0) {
    console.warn(
      `::warning::${check.label}: snapshot sebelumnya berisi ${previousCount} item; ` +
      "cek drop dilewati."
    );
    return;
  }

  const dropRatio = (previousCount - currentCount) / previousCount;
  if (dropRatio > MAX_DROP_RATIO) {
    fail(
      `${check.label}: jumlah item turun ${(dropRatio * 100).toFixed(1)}% ` +
      `(${previousCount} -> ${currentCount}), melebihi batas ` +
      `${(MAX_DROP_RATIO * 100).toFixed(0)}%. Publikasi dihentikan untuk review.`
    );
  }

  console.log(
    `${check.label}: ${currentCount} item baru; snapshot sebelumnya ` +
    `${previousCount} item; drop ${(Math.max(dropRatio, 0) * 100).toFixed(1)}%`
  );
});

if (failures.length > 0) {
  console.error("Guard data radar gagal:");
  failures.forEach((message) => console.error(`- ${message}`));
  process.exit(1);
}

console.log("Guard data radar lulus.");

function readNumberEnv(name, fallback) {
  if (process.env[name] == null || process.env[name] === "") return fallback;
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} harus angka >= 0, diterima: ${process.env[name]}`);
  }
  return value;
}

function readItemCount(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    fail(`${filePath}: gagal dibaca/parse JSON (${err.message}).`);
    return 0;
  }

  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) {
    return parsed.items.length;
  }

  fail(`${filePath}: root JSON harus array item atau object dengan field items array.`);
  return 0;
}

function fail(message) {
  failures.push(message);
  console.error(`::error::${message}`);
}
