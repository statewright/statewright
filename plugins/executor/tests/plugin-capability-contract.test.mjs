import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const expectedPlugins = ["claude", "codex", "cursor", "omx", "opencode", "pi"];

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

test("plugin capability registry covers every released transport with honest evidence", async () => {
  const registry = await json("plugins/capabilities.json");
  assert.equal(registry.schema, "statewright/plugin-capabilities/v1");
  assert.deepEqual(Object.keys(registry.plugins).sort(), expectedPlugins);

  const exact = [];
  for (const [plugin, capability] of Object.entries(registry.plugins)) {
    assert.deepEqual(
      capability.production_transport.operating_systems,
      plugin === "claude" ? [] : ["ubuntu-24.04", "macos-14"],
      `${plugin} production transport matrix`,
    );
    assert.equal(capability.auth.mode, plugin === "claude" ? "oauth" : "api_key", `${plugin} auth mode`);
    assert.ok(
      ["os_browser", "host_guidance", "executor_owned", "native_claude"].includes(capability.auth.onboarding),
      `${plugin} onboarding classification`,
    );
    assert.equal(capability.adoption_telemetry.event, "ci_canary", `${plugin} adoption event`);
    assert.equal(capability.adoption_telemetry.endpoint_acknowledgement, true, `${plugin} endpoint acknowledgement`);
    assert.equal(capability.adoption_telemetry.persistence_readback, false, `${plugin} persistence boundary`);
    assert.ok(
      ["exact", "unavailable"].includes(capability.provider_usage.precision),
      `${plugin} provider precision`,
    );
    if (capability.provider_usage.precision === "exact") {
      exact.push(plugin);
      assert.ok(capability.provider_usage.test, `${plugin} exact provider usage test`);
    } else {
      assert.equal(capability.provider_usage.evidence_kind, "implementation_status", `${plugin} usage evidence kind`);
      assert.equal(capability.provider_usage.reason, "host_provider_usage_not_implemented", `${plugin} usage reason`);
      assert.equal(capability.provider_usage.test, undefined, `${plugin} must not cite circular negative evidence`);
    }

    for (const evidencePath of [
      capability.auth.test,
      capability.adoption_telemetry.test,
      ...(capability.provider_usage.test ? [capability.provider_usage.test] : []),
    ]) {
      await access(resolve(root, evidencePath));
    }
  }
  assert.deepEqual(exact.sort(), ["claude", "codex"]);
});

test("capability versions match package and runtime identities", async () => {
  const registry = await json("plugins/capabilities.json");
  const manifests = {
    claude: await json("plugins/claude-code/plugin.json"),
    codex: await json("plugins/codex/.codex-plugin/plugin.json"),
    cursor: await json("plugins/cursor/.cursor-plugin/plugin.json"),
    omx: await json("plugins/omx/package.json"),
    opencode: await json("plugins/opencode/package.json"),
    pi: await json("plugins/pi/package.json"),
  };
  manifests.codex.version = manifests.codex.version.split("+")[0];

  for (const plugin of expectedPlugins) {
    assert.equal(registry.plugins[plugin].version, manifests[plugin].version, `${plugin} manifest version`);
  }

  const runtimeSources = {
    codex: await readFile(resolve(root, "plugins/codex/scripts/statewright-codex.mjs"), "utf8"),
    omx: await readFile(resolve(root, "plugins/omx/src/hook.ts"), "utf8"),
    opencode: await readFile(resolve(root, "plugins/opencode/src/index.ts"), "utf8"),
    pi: await readFile(resolve(root, "plugins/pi/src/index.ts"), "utf8"),
  };
  for (const [plugin, source] of Object.entries(runtimeSources)) {
    const version = registry.plugins[plugin].version.replaceAll(".", "\\.");
    assert.match(source, new RegExp(`(?:PLUGIN_VERSION =|version:) ["']${version}["']`), `${plugin} runtime version`);
  }
  assert.match(
    runtimeSources.pi,
    /clientInfo: \{ name: "statewright-pi", version: PLUGIN_VERSION \}/,
    "Pi MCP client identity must use its package runtime version",
  );

  const omxBundle = await readFile(resolve(root, "plugins/omx/dist/hook.js"), "utf8");
  assert.match(
    omxBundle,
    new RegExp(`createErrorReporter\\(\\{ plugin: ["']omx["'], version: ["']${registry.plugins.omx.version.replaceAll(".", "\\.")}["']`),
    "OMX distributed bundle version",
  );
  assert.match(omxBundle, /callStatewrightGateway/,
    "OMX distributed bundle must expose the production transport canary seam");
  assert.match(omxBundle, /initializeStatewrightGateway/,
    "OMX distributed bundle must expose the production initialization canary seam");
});

test("native Windows evidence and release artifacts remain distinct", async () => {
  const registry = await json("plugins/capabilities.json");
  const nativeWindows = [];
  const releaseArtifacts = [];
  for (const [plugin, capability] of Object.entries(registry.plugins)) {
    if (capability.production_transport.native_windows) nativeWindows.push(plugin);
    if (capability.release_artifact) releaseArtifacts.push(plugin);
  }
  assert.deepEqual(nativeWindows.sort(), ["codex"]);
  assert.deepEqual(releaseArtifacts.sort(), ["claude", "codex"]);
});

test("Claude native metadata cannot borrow the retired transport's acceptance", async () => {
  const { plugins: { claude } } = await json("plugins/capabilities.json");
  assert.equal(claude.runtime.vehicle, "native_mod");
  assert.deepEqual(claude.runtime.hosts, ["claude-code-tui", "claude-desktop-code-local"]);
  assert.equal(claude.production_transport.evidence_kind, "native_acceptance_pending");
  assert.equal(claude.auth.onboarding, "native_claude");
  assert.equal(claude.auth.test, "plugins/claude-code/tests/native-connection.test.mjs");
  assert.equal(claude.provider_usage.source, "claude_native_response");
  assert.equal(claude.provider_usage.scope, "local_main_conversation_receipt");
  assert.equal(claude.adoption_telemetry.scope, "legacy_transport_canary");
  const mcp = await json("plugins/claude-code/.mcp.json");
  assert.equal(mcp.mcpServers.statewright.type, "http");
  assert.equal(mcp.mcpServers.statewright.oauth.clientId, "statewright-claude");
  const hooks = await json("plugins/claude-code/hooks/hooks.json");
  assert.deepEqual(hooks, { modules: ["./connect.js"] });
});
