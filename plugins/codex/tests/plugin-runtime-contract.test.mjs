import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const codexRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(path) {
  return JSON.parse(await readFile(resolve(codexRoot, path), "utf8"));
}

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
