import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { managedClientVersion } from "../scripts/statewright-managed-client.mjs";

const codexRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(path) {
  return JSON.parse(await readFile(resolve(codexRoot, path), "utf8"));
}

test("release metadata and npm lock agree on the Codex maintenance version", async () => {
  const manifest = await readJson(".codex-plugin/plugin.json");
  const version = manifest.version.split("+")[0];
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal((await readJson("package.json")).version, version);
  const lock = await readJson("package-lock.json");
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""].version, version);
  await readFile(resolve(codexRoot, `../../docs/releases/codex-${version}.md`));
});

test("managed diagnostic versions follow the host without interpreting child arguments", async () => {
  const codex = (await readJson(".codex-plugin/plugin.json")).version.split("+")[0];
  const claude = (await readJson("../claude-code/.claude-plugin/plugin.json")).version;
  assert.equal(managedClientVersion([]), codex);
  assert.equal(managedClientVersion(["--host", "codex"]), codex);
  assert.equal(managedClientVersion(["--host", "claude"]), claude);
  assert.equal(managedClientVersion(["--host", "codex", "--", "--host", "claude"]), codex);
  assert.equal(managedClientVersion(["--host", "claude", "--", "--host", "codex"]), claude);
  assert.equal(managedClientVersion(["--", "--host", "claude"]), codex);
  const supervisor = await readFile(resolve(codexRoot, "scripts/lib/desktop-runtime/managed-client-supervisor.mjs"), "utf8");
  assert.ok(supervisor.includes(`version: host === "claude" ? "${claude}" : "${codex}"`));
});

test("Codex connection telemetry and native reporters use the release version", async () => {
  const version = (await readJson(".codex-plugin/plugin.json")).version.split("+")[0];
  const entry = await readFile(resolve(codexRoot, "scripts/statewright-codex.mjs"), "utf8");
  assert.equal(entry.match(/const PLUGIN_VERSION = "([^"]+)"/)[1], version);
  for (const path of ["scripts/statewright-desktop-setup.mjs", "scripts/lib/desktop-runtime/codex-app-server-resident.mjs", "scripts/lib/desktop-runtime/codex-app-server-transport.mjs"]) {
    const source = await readFile(resolve(codexRoot, path), "utf8");
    const reporters = [...source.matchAll(/plugin: "codex", version: "([^"]+)"/g)];
    assert.ok(reporters.length > 0, path);
    for (const match of reporters) assert.equal(match[1], version, path);
  }
});

test("plugin hooks resolve commands from the Codex-provided plugin root", async () => {
  const manifest = await readJson(".codex-plugin/plugin.json");
  assert.equal(manifest.hooks, "./hooks/hooks.json");

  const config = await readJson(manifest.hooks);
  const commands = Object.values(config.hooks)
    .flatMap((entries) => entries)
    .flatMap((entry) => entry.hooks)
    .map((hook) => hook.command);
  assert.ok(commands.length > 0);
  assert.ok(commands.every((command) => command.includes("$PLUGIN_ROOT/")));
  assert.ok(commands.every((command) => !command.includes("dirname $0")));
});

test("plugin MCP transport launches from the installed plugin root", async () => {
  const config = await readJson(".mcp.json");
  const server = config.mcpServers.statewright;

  assert.equal(server.command, "bash");
  assert.deepEqual(server.args, ["./mcp-proxy.sh"]);
  assert.equal(server.cwd, ".");
  assert.deepEqual(server.env_vars, [
    "STATEWRIGHT_NODE_BIN",
    "STATEWRIGHT_GATEWAY_URL",
    "STATEWRIGHT_PB_URL",
    "STATEWRIGHT_API_KEY",
    "STATEWRIGHT_CLIENT_ID",
    "STATEWRIGHT_BRANCH_SESSION_ID",
    "STATEWRIGHT_TELEMETRY_DIR",
    "STATEWRIGHT_TELEMETRY_PORT",
    "STATEWRIGHT_TELEMETRY_SUPERVISE_ONLY",
    "STATEWRIGHT_MCP_SESSION_ID",
    "STATEWRIGHT_ADAPTER_URL",
    "STATEWRIGHT_ADAPTER_TOKEN",
    "STATEWRIGHT_MANAGED_MCP_URL",
    "STATEWRIGHT_MANAGED_MCP_TOKEN",
  ]);
  assert.equal(server.env, undefined);
  assert.ok(
    !JSON.stringify(server).includes("${"),
    "Codex does not expand hook-style placeholders in MCP launch fields",
  );
});
