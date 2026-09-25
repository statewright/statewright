import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";
import { DESKTOP_RUNTIME_ROOT, desktopRuntimeDrift } from "../scripts/sync-desktop-runtime.mjs";

test("Desktop broker runtime is a complete synchronized Codex plugin bundle", async () => {
  assert.deepEqual(await desktopRuntimeDrift(), []);
  await access(`${DESKTOP_RUNTIME_ROOT}/codex-desktop-app-server-launcher.mjs`, constants.R_OK);
  await access(`${DESKTOP_RUNTIME_ROOT}/codex-app-server-route-proxy.mjs`, constants.R_OK);
  const runtime = await import("../scripts/lib/desktop-runtime/codex-desktop-app-server-launcher.mjs");
  assert.equal(typeof runtime.runDesktopAppServerBroker, "function");
  const launcher = await readFile("plugins/codex/scripts/statewright-desktop-codex.mjs", "utf8");
  assert.match(launcher, /desktop-runtime\/codex-desktop-app-server-launcher/);
  assert.match(launcher, /readDesktopState/);
});
