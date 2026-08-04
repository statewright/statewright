#!/usr/bin/env node

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const CLAUDE_ROOT = resolve(SCRIPT_ROOT, "..");
const EXECUTOR_ROOT = resolve(CLAUDE_ROOT, "..", "executor");

export const MANAGED_CLIENT_FILES = [
  ["statewright-managed-client.mjs", "executor/statewright-managed-client.mjs"],
  ["lib/managed-client-supervisor.mjs", "executor/lib/managed-client-supervisor.mjs"],
  ["lib/managed-client-identity.mjs", "executor/lib/managed-client-identity.mjs"],
  ["lib/managed-mcp-bridge.mjs", "executor/lib/managed-mcp-bridge.mjs"],
  ["lib/remote-client.mjs", "executor/lib/remote-client.mjs"],
];

export async function managedClientBundleDrift({ sourceRoot = EXECUTOR_ROOT, targetRoot = CLAUDE_ROOT } = {}) {
  const drift = [];
  for (const [sourceRelative, targetRelative] of MANAGED_CLIENT_FILES) {
    const source = await readFile(resolve(sourceRoot, sourceRelative));
    let target = null;
    try { target = await readFile(resolve(targetRoot, targetRelative)); } catch { /* report below */ }
    if (!target?.equals(source)) drift.push(targetRelative);
  }
  return drift;
}

export async function syncManagedClientBundle({ sourceRoot = EXECUTOR_ROOT, targetRoot = CLAUDE_ROOT } = {}) {
  for (const [sourceRelative, targetRelative] of MANAGED_CLIENT_FILES) {
    const target = resolve(targetRoot, targetRelative);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(sourceRoot, sourceRelative), target);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const drift = await managedClientBundleDrift();
    if (drift.length) throw new Error(`Claude managed-client bundle is stale: ${drift.join(", ")}`);
  } else {
    await syncManagedClientBundle();
  }
}
