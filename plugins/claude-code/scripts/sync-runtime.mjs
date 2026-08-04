#!/usr/bin/env node

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
export const CLAUDE_ROOT = resolve(SCRIPT_ROOT, "..");

// These files participate in hook execution, MCP transport, or managed routing.
// Keep the list explicit: a local marketplace can contain user material that a
// Statewright plugin update must not overwrite.
export const RUNTIME_FILES = [
  ".mcp.json",
  "capture.sh",
  "client-id.sh",
  "hook.sh",
  "mcp-proxy.sh",
  "plugin.json",
  "scripts/transcript-telemetry.mjs",
  "executor/statewright-managed-client.mjs",
  "executor/lib/managed-client-supervisor.mjs",
  "executor/lib/managed-client-identity.mjs",
  "executor/lib/managed-mcp-bridge.mjs",
  "executor/lib/remote-client.mjs",
];

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

function marketplacePluginRoot(marketplaceRoot, manifest) {
  const entry = manifest?.plugins?.find((plugin) => plugin?.name === "statewright");
  if (!entry || typeof entry.source !== "string") return null;
  const root = resolve(marketplaceRoot, entry.source);
  return inside(marketplaceRoot, root) ? root : null;
}

export async function discoverRuntimeRoots({ home = homedir(), sourceRoot = CLAUDE_ROOT } = {}) {
  const roots = new Set();
  const installed = await readJson(resolve(home, ".claude/plugins/installed_plugins.json"), {});
  for (const plugin of installed?.plugins?.["statewright@statewright"] ?? []) {
    if (typeof plugin?.installPath === "string") roots.add(resolve(plugin.installPath));
  }

  const settings = await readJson(resolve(home, ".claude/settings.json"), {});
  for (const marketplace of Object.values(settings?.extraKnownMarketplaces ?? {})) {
    if (marketplace?.source?.source !== "directory" || typeof marketplace.source.path !== "string") continue;
    const marketplaceRoot = resolve(marketplace.source.path);
    const manifest = await readJson(resolve(marketplaceRoot, ".claude-plugin/marketplace.json"), {});
    const root = marketplacePluginRoot(marketplaceRoot, manifest);
    if (root) roots.add(root);
  }

  roots.delete(resolve(sourceRoot));
  return [...roots].sort();
}

export async function runtimeDrift({ sourceRoot = CLAUDE_ROOT, targetRoots } = {}) {
  const roots = targetRoots ?? await discoverRuntimeRoots({ sourceRoot });
  const drift = [];
  for (const root of roots) {
    const stale = [];
    for (const relativePath of RUNTIME_FILES) {
      const source = await readFile(resolve(sourceRoot, relativePath));
      let target = null;
      try { target = await readFile(resolve(root, relativePath)); } catch { /* reported below */ }
      if (!target?.equals(source)) stale.push(relativePath);
    }
    if (stale.length) drift.push({ root, files: stale });
  }
  return drift;
}

export async function syncRuntime({ sourceRoot = CLAUDE_ROOT, targetRoots } = {}) {
  const roots = targetRoots ?? await discoverRuntimeRoots({ sourceRoot });
  for (const root of roots) {
    for (const relativePath of RUNTIME_FILES) {
      const target = resolve(root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(sourceRoot, relativePath), target);
    }
  }
  return roots;
}

function parseArgs(argv) {
  const options = { sync: false, check: false };
  for (const argument of argv) {
    if (argument === "--sync") options.sync = true;
    else if (argument === "--check") options.check = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.sync === options.check) throw new Error("Choose exactly one of --sync or --check.");
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.sync) {
    const roots = await syncRuntime();
    process.stdout.write(`${JSON.stringify({ synced: roots })}\n`);
  } else {
    const drift = await runtimeDrift();
    if (drift.length) throw new Error(`Claude plugin runtime is stale: ${JSON.stringify(drift)}`);
    process.stdout.write("Claude plugin runtime is current.\n");
  }
}
