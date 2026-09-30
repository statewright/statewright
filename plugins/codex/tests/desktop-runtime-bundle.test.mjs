import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DESKTOP_RUNTIME_ROOT, PACKAGED_MANAGED_CLIENT, desktopRuntimeDrift } from "../scripts/sync-desktop-runtime.mjs";

test("Desktop broker runtime is a complete synchronized Codex plugin bundle", async () => {
  assert.deepEqual(await desktopRuntimeDrift(), []);
  await access(`${DESKTOP_RUNTIME_ROOT}/codex-desktop-app-server-launcher.mjs`, constants.R_OK);
  await access(`${DESKTOP_RUNTIME_ROOT}/codex-app-server-route-proxy.mjs`, constants.R_OK);
  await access(PACKAGED_MANAGED_CLIENT, constants.R_OK);
  await access("plugins/codex/vendor/ws/wrapper.mjs", constants.R_OK);
  await access("plugins/codex/vendor/ws/LICENSE", constants.R_OK);
  for (const file of ["codex-desktop-app-server-launcher.mjs", "codex-app-server-route-proxy.mjs"]) {
    const bundled = await readFile(`${DESKTOP_RUNTIME_ROOT}/${file}`, "utf8");
    assert.doesNotMatch(bundled, /from ["']ws["']/);
    assert.match(bundled, /vendor\/ws\/wrapper\.mjs/);
  }
  const runtime = await import("../scripts/lib/desktop-runtime/codex-desktop-app-server-launcher.mjs");
  assert.equal(typeof runtime.runDesktopAppServerBroker, "function");
  const launcher = await readFile("plugins/codex/scripts/statewright-desktop-codex.mjs", "utf8");
  assert.match(launcher, /desktop-runtime\/codex-desktop-app-server-launcher/);
  assert.match(launcher, /readDesktopState/);
  const managedClient = await readFile(PACKAGED_MANAGED_CLIENT, "utf8");
  assert.match(managedClient, /\.\/lib\/desktop-runtime\/managed-client-supervisor\.mjs/);
  assert.match(managedClient, /\.\/lib\/desktop-runtime\/error-reporting\.mjs/);
  for (const [, specifier] of managedClient.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    await access(fileURLToPath(new URL(specifier, pathToFileURL(PACKAGED_MANAGED_CLIENT))), constants.R_OK);
  }
  const proxy = await readFile("plugins/codex/mcp-proxy.sh", "utf8");
  assert.match(proxy, /scripts\/statewright-managed-client\.mjs/);
  assert.doesNotMatch(proxy, /\.\.\/executor\/statewright-managed-client\.mjs/);
});
