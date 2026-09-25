#!/usr/bin/env node

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const CODEX_ROOT = resolve(SCRIPT_ROOT, "..");
const EXECUTOR_LIB = resolve(CODEX_ROOT, "..", "executor", "lib");
export const DESKTOP_RUNTIME_ROOT = resolve(CODEX_ROOT, "scripts", "lib", "desktop-runtime");
const ENTRY = resolve(EXECUTOR_LIB, "codex-desktop-app-server-launcher.mjs");
const PACKAGED_IMPORT_REWRITES = new Map([
  ["ws", "../../../vendor/ws/wrapper.mjs"],
]);

function packagedRuntimeSource(source) {
  return source.replace(/(from\s+|import\s*\()(["'])([^"']+)\2/g, (match, prefix, quote, specifier) => {
    const packaged = PACKAGED_IMPORT_REWRITES.get(specifier);
    return packaged ? `${prefix}${quote}${packaged}${quote}` : match;
  });
}

function relativeImports(source) {
  return [...source.matchAll(/(?:from\s+|import\s*\()\s*["'](\.[^"']+)["']/g)].map(match => match[1]);
}

async function runtimeSources() {
  const pending = [ENTRY];
  const sources = new Set();
  while (pending.length) {
    const source = pending.pop();
    if (sources.has(source)) continue;
    const sourceText = await readFile(source, "utf8");
    sources.add(source);
    for (const specifier of relativeImports(sourceText)) {
      const imported = resolve(dirname(source), specifier);
      if (!imported.startsWith(`${EXECUTOR_LIB}/`) || !imported.endsWith(".mjs")) {
        throw new Error(`Desktop runtime import must stay inside executor/lib: ${relative(source, imported)}`);
      }
      pending.push(imported);
    }
  }
  return [...sources].sort();
}

export async function desktopRuntimeDrift() {
  const drift = [];
  for (const source of await runtimeSources()) {
    const target = resolve(DESKTOP_RUNTIME_ROOT, relative(EXECUTOR_LIB, source));
    let targetText = null;
    try { targetText = await readFile(target, "utf8"); } catch { /* missing is drift */ }
    if (targetText !== packagedRuntimeSource(await readFile(source, "utf8"))) drift.push(relative(EXECUTOR_LIB, source));
  }
  const expected = new Set((await runtimeSources()).map(source => relative(EXECUTOR_LIB, source)));
  async function checkExtras(directory, prefix = "") {
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const next = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await checkExtras(resolve(directory, entry.name), `${next}/`);
      else if (!expected.has(next)) drift.push(`unexpected:${next}`);
    }
  }
  await checkExtras(DESKTOP_RUNTIME_ROOT);
  return drift.sort();
}

export async function syncDesktopRuntime() {
  const sources = await runtimeSources();
  await rm(DESKTOP_RUNTIME_ROOT, { recursive: true, force: true });
  await mkdir(DESKTOP_RUNTIME_ROOT, { recursive: true });
  for (const source of sources) {
    const target = resolve(DESKTOP_RUNTIME_ROOT, relative(EXECUTOR_LIB, source));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, packagedRuntimeSource(await readFile(source, "utf8")));
  }
  return sources.map(source => relative(EXECUTOR_LIB, source));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const drift = await desktopRuntimeDrift();
    if (drift.length) throw new Error(`Codex Desktop runtime bundle is stale: ${drift.join(", ")}`);
  } else {
    await syncDesktopRuntime();
  }
}
