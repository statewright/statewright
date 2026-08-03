#!/usr/bin/env node

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const CODEX_ROOT = resolve(SCRIPT_ROOT, "..");
const EXECUTOR_ROOT = resolve(CODEX_ROOT, "..", "executor");

export const EXECUTOR_CORE_FILES = [
  ["lib/delivery-config.mjs", "scripts/lib/delivery-config.mjs"],
  ["lib/delivery-controller.mjs", "scripts/lib/delivery-controller.mjs"],
  ["lib/hook-process.mjs", "scripts/lib/hook-process.mjs"],
  ["lib/telemetry.mjs", "scripts/lib/telemetry.mjs"],
  ["lib/workspace-session.mjs", "scripts/lib/workspace-session.mjs"],
  ["taskfile-delivery-adapter.mjs", "scripts/taskfile-delivery-adapter.mjs"],
];

export async function executorCoreDrift() {
  const drift = [];
  for (const [sourceRelative, targetRelative] of EXECUTOR_CORE_FILES) {
    const source = resolve(EXECUTOR_ROOT, sourceRelative);
    const target = resolve(CODEX_ROOT, targetRelative);
    let targetBytes = null;
    try {
      targetBytes = await readFile(target);
    } catch {
      // Report missing generated files as drift.
    }
    const sourceBytes = await readFile(source);
    if (!targetBytes?.equals(sourceBytes)) drift.push(targetRelative);
  }
  return drift;
}

export async function syncExecutorCore() {
  for (const [sourceRelative, targetRelative] of EXECUTOR_CORE_FILES) {
    const source = resolve(EXECUTOR_ROOT, sourceRelative);
    const target = resolve(CODEX_ROOT, targetRelative);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const drift = await executorCoreDrift();
    if (drift.length) {
      throw new Error(`Codex executor-core bundle is stale: ${drift.join(", ")}`);
    }
  } else {
    await syncExecutorCore();
  }
}
