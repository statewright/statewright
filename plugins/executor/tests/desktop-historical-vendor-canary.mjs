// Native protocol canary: disposable history, no credentials, model turn, or
// user's transcript. Exercises the installed vendor parser, not a fake server.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runDesktopAppServerBroker, startProfileDesktopMcpBridge } from "../lib/codex-desktop-app-server-launcher.mjs";

if (!process.env.STATEWRIGHT_DESKTOP_CODEX_BIN) {
  console.log("SKIP: set STATEWRIGHT_DESKTOP_CODEX_BIN to the installed vendor executable.");
  process.exit(0);
}
const home = await mkdtemp(join(tmpdir(), "statewright-desktop-history-canary-"));
const codexHome = join(home, ".codex");
const sessions = join(codexHome, "sessions", "2026", "10", "10");
const ids = [randomUUID(), randomUUID()];
const clientId = `swc_${randomUUID().replaceAll("-", "")}`;
const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
let buffer = "", diagnostics = "", sequence = 0, broker, bridge, gateway;
const pending = new Map();
output.on("data", chunk => {
  buffer += String(chunk);
  for (;;) {
    const end = buffer.indexOf("\n"); if (end < 0) break;
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    const request = pending.get(message.id);
    if (request && !message.method) {
      pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    }
  }
});
errors.on("data", chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000); });
function rpc(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${diagnostics}`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    input.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
try {
  await mkdir(sessions, { recursive: true });
  const pluginRoot = fileURLToPath(new URL("../../codex/", import.meta.url));
  const mcp = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.statewright;
  await writeFile(join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n'
    + '[mcp_servers.statewright]\ncommand = "/bin/bash"\n'
    + `args = [${JSON.stringify(join(pluginRoot, "mcp-proxy.sh"))}]\n`
    + `env_vars = ${JSON.stringify(mcp.env_vars)}\nstartup_timeout_sec = 10\n`);
  gateway = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const rpc = JSON.parse(raw);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id,
      result: rpc.method === "tools/list" ? { tools: [{ name: "statewright_get_state", inputSchema: { type: "object" } }] } : {} }));
  });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  for (const [index, id] of ids.entries()) {
    const cwd = join(home, `project-${index}`);
    await mkdir(cwd);
    const timestamp = "2026-10-10T00:00:00.000Z";
    const rows = [
      { timestamp, type: "session_meta", payload: { id, timestamp, cwd, originator: "codex_cli_rs", cli_version: "0.0.0", source: "cli", model_provider: "openai" } },
      { timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fixture history; do not run a model turn." }] } },
    ];
    await writeFile(join(sessions, `rollout-2026-10-10T00-00-00-${id}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  }
  bridge = await startProfileDesktopMcpBridge({
    state: { client_id: clientId, gateway_url: `http://127.0.0.1:${gateway.address().port}/mcp` }, home,
    environment: { HOME: home }, getCredential: async () => "fixture-only", withLanePool: true,
  });
  broker = await runDesktopAppServerBroker({ argv: ["app-server"], home, stdin: input, stdout: output, stderr: errors,
    environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, CODEX_HOME: codexHome,
      STATEWRIGHT_NODE_BIN: process.execPath,
      STATEWRIGHT_DESKTOP_ORIGINAL_CODEX: process.env.STATEWRIGHT_DESKTOP_CODEX_BIN,
      STATEWRIGHT_DESKTOP_CLIENT_ID: clientId,
      STATEWRIGHT_DESKTOP_BRIDGE_POOL_URL: bridge.poolUrl, STATEWRIGHT_DESKTOP_BRIDGE_POOL_TOKEN: bridge.poolToken },
  });
  await rpc("initialize", { clientInfo: { name: "statewright-history-canary", version: "1" }, capabilities: { experimentalApi: true } });
  // The signed Desktop AppServerConnection proceeds on the initialize result
  // without this optional client notification. Test that path by default.
  if (process.env.STATEWRIGHT_CANARY_SEND_INITIALIZED === "1") {
    input.write(`${JSON.stringify({ method: "initialized" })}\n`);
  }
  for (const id of ids) {
    const read = await rpc("thread/read", { threadId: id, includeTurns: false });
    assert.equal(read.thread.id, id);
    const resumed = await rpc("thread/resume", { threadId: id });
    assert.equal(resumed.thread.id, id);
    const status = await rpc("mcpServerStatus/list", { threadId: id });
    assert.ok(status.data.some(server => Object.keys(server.tools ?? {}).some(name => name.endsWith("statewright_get_state"))),
      `Native MCP discovery failed: ${diagnostics}`);
  }
  assert.equal((await rpc("thread/resume", { threadId: ids[0] })).thread.id, ids[0]);
  console.log("NATIVE_DESKTOP_TWO_PROJECT_RESUME_AND_MCP_PASS (real shell proxy; restricted PATH; fixture gateway; no model turn)");
} finally {
  await broker?.close(); await bridge?.close();
  if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); }
  for (const request of pending.values()) clearTimeout(request.timer);
  await rm(home, { recursive: true, force: true });
}
