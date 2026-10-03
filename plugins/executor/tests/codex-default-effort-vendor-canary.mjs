// Real native App Server settings canary. It creates an isolated temporary
// CODEX_HOME and never starts a model turn, invokes a tool, or contacts an MCP.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const binary = process.env.CODEX_PROBE_BINARY ?? "/opt/homebrew/bin/codex";
const home = await mkdtemp(join(tmpdir(), "statewright-default-effort-"));
const environment = { ...process.env, CODEX_HOME: home, LC_ALL: "C", LANG: "C" };
for (const name of Object.keys(environment)) {
  if ((name.startsWith("CODEX_") && name !== "CODEX_HOME") || name.startsWith("STATEWRIGHT_")
      || name === "OPENAI_API_KEY" || name === "OPENAI_BASE_URL") delete environment[name];
}

const child = spawn(binary, ["app-server", "--stdio",
  "-c", 'model="gpt-5.6-sol"',
  "-c", 'model_reasoning_effort="medium"',
  "-c", "features.code_mode=false",
], { cwd: home, env: environment, stdio: ["pipe", "pipe", "pipe"] });
const exited = once(child, "exit");
const notifications = [];
const pending = new Map();
let sequence = 0;
let stderr = "";
child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method) {
    notifications.push(message);
    return;
  }
  const request = pending.get(message.id);
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(message.id);
  if (message.error) request.reject(Object.assign(new Error(message.error.message), { rpcError: message.error }));
  else request.resolve(message.result);
});
const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`timeout ${method}: ${stderr}`));
  }, 12_000);
  pending.set(id, { resolve, reject, timer });
  send({ id, method, params });
});
const waitForSettings = async (threadId, after, predicate) => {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const found = notifications.slice(after).find(message => message.method === "thread/settings/updated"
      && message.params?.threadId === threadId && predicate(message.params.threadSettings));
    if (found) return found.params.threadSettings;
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`missing settings notification: ${stderr}`);
};

try {
  await rpc("initialize", { clientInfo: { name: "statewright_default_effort_canary", version: "1" },
    capabilities: { experimentalApi: true } });
  send({ method: "initialized", params: {} });
  const started = await rpc("thread/start", { model: "gpt-5.6-sol", cwd: home, approvalPolicy: "never" });
  const threadId = started.thread.id;
  const initialAt = notifications.length;
  await rpc("thread/settings/update", { threadId, model: "gpt-5.6-terra", effort: "medium" });
  const routed = await waitForSettings(threadId, initialAt,
    settings => settings.model === "gpt-5.6-terra" && settings.effort === "medium");
  assert(routed.collaborationMode?.mode, "native settings must expose the current collaboration mode");
  assert(routed.collaborationMode?.settings, "native settings must expose collaboration settings");

  const restoreAt = notifications.length;
  const collaborationMode = structuredClone(routed.collaborationMode);
  collaborationMode.settings.model = "gpt-5.6-sol";
  collaborationMode.settings.reasoning_effort = null;
  await rpc("thread/settings/update", {
    threadId,
    model: "gpt-5.6-sol",
    effort: null,
    collaborationMode,
  });
  const restored = await waitForSettings(threadId, restoreAt,
    settings => settings.model === "gpt-5.6-sol"
      && settings.collaborationMode?.settings?.model === "gpt-5.6-sol"
      && settings.collaborationMode?.settings?.reasoning_effort === null);
  assert.equal(restored.collaborationMode.mode, routed.collaborationMode.mode);
  const routedHasInstructions = Object.hasOwn(routed.collaborationMode.settings, "developer_instructions")
    && routed.collaborationMode.settings.developer_instructions != null;
  if (routedHasInstructions) {
    assert.equal(restored.collaborationMode.settings.developer_instructions,
      routed.collaborationMode.settings.developer_instructions);
  }
  console.log(JSON.stringify({
    schema: "statewright/codex-default-effort-canary/v1",
    binary,
    result: "pass",
    inference_started: false,
    initial: { model: "gpt-5.6-sol", effort: "medium" },
    routed: { model: routed.model, effort: routed.effort,
      collaboration_effort: routed.collaborationMode.settings.reasoning_effort ?? null },
    restored: { model: restored.model, effort: restored.effort ?? null,
      collaboration_effort: restored.collaborationMode.settings.reasoning_effort ?? null },
    collaboration_mode_preserved: true,
    explicit_developer_instructions_preserved: routedHasInstructions ? true : "implicit_default_rematerialized",
  }));
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  lines.close();
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  await exited;
  clearTimeout(killTimer);
  await rm(home, { recursive: true, force: true });
}
