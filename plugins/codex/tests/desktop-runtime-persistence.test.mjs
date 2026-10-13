import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { persistDesktopRuntime } from "../scripts/statewright-desktop-setup.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "statewright-desktop-runtime-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pluginRoot = join(root, "cache", "plugin"), statePath = join(root, "state", "desktop.json");
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "scripts"), { recursive: true });
  await mkdir(dirname(statePath));
  await mkdir(join(pluginRoot, "vendor"));
  await writeFile(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "statewright", version: "0.3.4+fixture" }));
  await writeFile(join(pluginRoot, "scripts", "statewright-desktop-codex.mjs"), 'export { result } from "../vendor/dependency.mjs";\n');
  await writeFile(join(pluginRoot, "vendor", "dependency.mjs"), 'export const result = "survived";\n');
  return { root, pluginRoot, statePath };
}

test("Desktop broker and dependencies survive cache eviction", async t => {
  const f = await fixture(t);
  const wrapper = await persistDesktopRuntime(f);
  assert.ok(wrapper.startsWith(join(f.root, "state", "runtime", "codex-desktop")));
  await rm(f.pluginRoot, { recursive: true });
  assert.equal((await import(pathToFileURL(wrapper))).result, "survived");
});

test("changed bytes under the same capability version create a new snapshot", async t => {
  const f = await fixture(t);
  const first = await persistDesktopRuntime(f);
  await writeFile(join(f.pluginRoot, "vendor", "dependency.mjs"), 'export const result = "updated";\n');
  const second = await persistDesktopRuntime(f);
  assert.notEqual(first, second);
  assert.equal((await import(pathToFileURL(first))).result, "survived");
  assert.equal((await import(pathToFileURL(second))).result, "updated");
});

test("unchanged packages reuse the same complete snapshot across concurrent profiles", async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 3 }, () => persistDesktopRuntime(f)));
  assert.equal(new Set(results).size, 1);
  assert.equal(await persistDesktopRuntime(f), results[0]);
  assert.equal((await readdir(join(f.root, "state", "runtime", "codex-desktop"))).length, 1);
});

test("a changed durable snapshot is refused, never overwritten", async t => {
  const f = await fixture(t);
  const wrapper = await persistDesktopRuntime(f);
  await writeFile(wrapper, "tampered");
  await assert.rejects(persistDesktopRuntime(f), /refusing to overwrite/);
  assert.equal(await readFile(wrapper, "utf8"), "tampered");
});

test("package symlinks cannot create a cache-dependent snapshot", async t => {
  const f = await fixture(t);
  await symlink(join(f.pluginRoot, "vendor"), join(f.pluginRoot, "scripts", "linked"));
  await assert.rejects(persistDesktopRuntime(f), /symbolic link/);
});

test("an existing snapshot cannot be substituted with a symlink", async t => {
  const f = await fixture(t);
  const wrapper = await persistDesktopRuntime(f), snapshot = dirname(dirname(wrapper));
  await rename(snapshot, snapshot + ".saved");
  await symlink(snapshot + ".saved", snapshot);
  await assert.rejects(persistDesktopRuntime(f), /not a directory/);
});

test("runtime storage inside the source package is rejected, including alias paths", async t => {
  const f = await fixture(t);
  const alias = join(f.root, "alias");
  await symlink(f.pluginRoot, alias);
  await assert.rejects(persistDesktopRuntime({ ...f, statePath: join(alias, "desktop.json") }), /outside the plugin/);
});

test("a storage-directory symlink cannot redirect snapshots into the cache", async t => {
  const f = await fixture(t);
  await symlink(f.pluginRoot, join(dirname(f.statePath), "runtime"));
  await assert.rejects(persistDesktopRuntime(f), /outside the plugin/);
});

test("default Desktop provisioning persists its actual package before recording the broker path", async t => {
  const f = await fixture(t);
  const sourcePlugin = new URL("../", import.meta.url);
  await rm(f.pluginRoot, { recursive: true });
  await cp(sourcePlugin, f.pluginRoot, { recursive: true, filter: path => !path.split("/").includes("node_modules") });
  await symlink(f.root, join(f.pluginRoot, "node_modules")); // Not a runtime dependency; must not be followed or copied.
  const { enableDesktop, desktopDoctor } = await import(pathToFileURL(join(f.pluginRoot, "scripts", "statewright-desktop-setup.mjs")));
  const executable = join(f.root, "fake-host");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const state = await enableDesktop({
    statePath: f.statePath, original: executable, app: executable, applicationsDirectory: join(f.root, "apps"),
    nativeLauncherCandidate: join(f.root, "absent-native"), requireNativeLauncher: false,
  });
  assert.ok(!state.wrapper.startsWith(f.pluginRoot));
  await rm(f.pluginRoot, { recursive: true });
  assert.equal((await desktopDoctor({ statePath: f.statePath, credentialStatus: async () => ({ ok: true, status: "configured" }) })).ok, true);
  assert.equal(typeof (await import(pathToFileURL(join(dirname(state.wrapper), "lib/desktop-runtime/codex-desktop-app-server-launcher.mjs")))).runDesktopAppServerBroker, "function");
});
