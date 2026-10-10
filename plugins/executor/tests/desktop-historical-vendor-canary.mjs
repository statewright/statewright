// Native protocol canary: disposable history, no credentials, model turn, or
// user's transcript. Exercises the installed vendor parser, not a fake server.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
let buffer = "", diagnostics = "", sequence = 0, broker, bridge;
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
  await writeFile(join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n');
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
    state: { client_id: clientId, gateway_url: "https://fixture.invalid/mcp" }, home,
    environment: { HOME: home }, getCredential: async () => "fixture-only", withLanePool: true,
  });
  broker = await runDesktopAppServerBroker({ argv: ["app-server"], home, stdin: input, stdout: output, stderr: errors,
    environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome,
      STATEWRIGHT_DESKTOP_ORIGINAL_CODEX: process.env.STATEWRIGHT_DESKTOP_CODEX_BIN,
      STATEWRIGHT_DESKTOP_CLIENT_ID: clientId,
      STATEWRIGHT_DESKTOP_BRIDGE_POOL_URL: bridge.poolUrl, STATEWRIGHT_DESKTOP_BRIDGE_POOL_TOKEN: bridge.poolToken },
  });
  await rpc("initialize", { clientInfo: { name: "statewright-history-canary", version: "1" }, capabilities: { experimentalApi: true } });
  input.write(`${JSON.stringify({ method: "initialized" })}\n`);
  for (const id of ids) {
    const read = await rpc("thread/read", { threadId: id, includeTurns: false });
    assert.equal(read.thread.id, id);
    const resumed = await rpc("thread/resume", { threadId: id });
    assert.equal(resumed.thread.id, id);
  }
  assert.equal((await rpc("thread/resume", { threadId: ids[0] })).thread.id, ids[0]);
  console.log("NATIVE_DESKTOP_TWO_PROJECT_RESUME_PASS (disposable history; no model turn)");
} finally {
  await broker?.close(); await bridge?.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  await rm(home, { recursive: true, force: true });
}
