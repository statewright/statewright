import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CLAUDE_ROOT, RUNTIME_FILES, discoverRuntimeRoots, runtimeDrift, syncRuntime } from "../scripts/sync-runtime.mjs";

async function copyRuntime(sourceRoot, targetRoot) {
  for (const path of RUNTIME_FILES) {
    const target = resolve(targetRoot, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await copyFile(resolve(sourceRoot, path), target);
  }
}

test("runtime sync discovers the installed cache and local directory marketplace", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-claude-runtime-"));
  const home = join(root, "home");
  const cache = join(home, ".claude/plugins/cache/statewright/statewright/0.3.0");
  const marketplace = join(root, "marketplace");
  const directoryPlugin = join(marketplace, "plugins/statewright");
  try {
    await copyRuntime(CLAUDE_ROOT, cache);
    await copyRuntime(CLAUDE_ROOT, directoryPlugin);
    await mkdir(join(home, ".claude/plugins"), { recursive: true });
    await writeFile(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({
      plugins: { "statewright@statewright": [{ installPath: cache }] },
    }));
    await mkdir(join(marketplace, ".claude-plugin"), { recursive: true });
    await writeFile(join(marketplace, ".claude-plugin/marketplace.json"), JSON.stringify({
      plugins: [{ name: "statewright", source: "./plugins/statewright" }],
    }));
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude/settings.json"), JSON.stringify({
      extraKnownMarketplaces: { statewright: { source: { source: "directory", path: marketplace } } },
    }));

    assert.deepEqual(await discoverRuntimeRoots({ home, sourceRoot: CLAUDE_ROOT }), [cache, directoryPlugin].sort());
    await writeFile(join(directoryPlugin, "mcp-proxy.sh"), "stale\n");
    const before = await runtimeDrift({ sourceRoot: CLAUDE_ROOT, targetRoots: [cache, directoryPlugin] });
    assert.deepEqual(before, [{ root: directoryPlugin, files: ["mcp-proxy.sh"] }]);
    await syncRuntime({ sourceRoot: CLAUDE_ROOT, targetRoots: [cache, directoryPlugin] });
    assert.deepEqual(await runtimeDrift({ sourceRoot: CLAUDE_ROOT, targetRoots: [cache, directoryPlugin] }), []);
    assert.deepEqual(await readFile(join(directoryPlugin, "mcp-proxy.sh")), await readFile(join(CLAUDE_ROOT, "mcp-proxy.sh")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
