#!/usr/bin/env node

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = resolve(SCRIPT_ROOT, "../..");
const SOURCE = resolve(PLUGINS_ROOT, "executor/lib/error-reporting.mjs");
export const ERROR_REPORTING_TARGETS = [
  "codex/scripts/lib/error-reporting.mjs",
  "claude-code/executor/lib/error-reporting.mjs",
  "pi/src/error-reporting.mjs",
  "opencode/src/error-reporting.mjs",
  "omx/src/error-reporting.mjs",
];

export async function errorReportingDrift() {
  const source = await readFile(SOURCE);
  const stale = [];
  for (const relative of ERROR_REPORTING_TARGETS) {
    let target = null;
    try { target = await readFile(resolve(PLUGINS_ROOT, relative)); } catch { /* missing is stale */ }
    if (!target?.equals(source)) stale.push(relative);
    const helper = relative.replace('error-reporting.mjs', 'diagnostic-event.mjs');
    let helperBytes = null;
    try { helperBytes = await readFile(resolve(PLUGINS_ROOT, helper)); } catch { /* missing */ }
    if (!helperBytes?.equals(await readFile(resolve(PLUGINS_ROOT, 'executor/lib/diagnostic-event.mjs')))) stale.push(helper);
  }
  return stale;
}

export async function syncErrorReporting() {
  for (const relative of ERROR_REPORTING_TARGETS) {
    const target = resolve(PLUGINS_ROOT, relative);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(SOURCE, target);
    await copyFile(resolve(PLUGINS_ROOT, 'executor/lib/diagnostic-event.mjs'), target.replace('error-reporting.mjs', 'diagnostic-event.mjs'));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const stale = await errorReportingDrift();
    if (stale.length) throw new Error(`Plugin error-reporting bundle is stale: ${stale.join(", ")}`);
  } else {
    await syncErrorReporting();
  }
}
