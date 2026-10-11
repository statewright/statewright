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
  const developerInstructions = "Statewright default-effort vendor canary; no inference.";
  const originalAt = notifications.length;
  await rpc("thread/settings/update", {
    threadId,
    model: "gpt-5.6-sol",
    effort: null,
    collaborationMode: { mode: "default", settings: {
      model: "gpt-5.6-sol", reasoning_effort: null, developer_instructions: developerInstructions,
    } },
  });
  const original = await waitForSettings(threadId, originalAt,
    settings => settings.model === "gpt-5.6-sol"
      && Object.hasOwn(settings, "effort") && settings.effort === null
      && settings.collaborationMode?.mode === "default"
      && settings.collaborationMode.settings?.model === "gpt-5.6-sol"
      && Object.hasOwn(settings.collaborationMode.settings, "reasoning_effort")
      && settings.collaborationMode.settings.reasoning_effort === null
      && settings.collaborationMode.settings.developer_instructions === developerInstructions);

  const routedAt = notifications.length;
  const routedCollaborationMode = structuredClone(original.collaborationMode);
  routedCollaborationMode.settings.model = "gpt-5.6-terra";
  routedCollaborationMode.settings.reasoning_effort = "medium";
  await rpc("thread/settings/update", { threadId, model: "gpt-5.6-terra", effort: "medium",
    collaborationMode: routedCollaborationMode });
  const routed = await waitForSettings(threadId, routedAt,
    settings => settings.model === "gpt-5.6-terra" && settings.effort === "medium"
      && settings.collaborationMode?.settings?.developer_instructions === developerInstructions);
  assert(routed.collaborationMode?.mode, "native settings must expose the current collaboration mode");
  assert(routed.collaborationMode?.settings, "native settings must expose collaboration settings");

  // A successful no-op has no settings/updated notification. Do not model
  // every acknowledged update as a new native event in protocol fixtures.
  const identicalAt = notifications.length;
  const identicalAck = await rpc("thread/settings/update", {threadId,
    model: "gpt-5.6-terra", effort: "medium", collaborationMode: routed.collaborationMode});
  assert.deepEqual(identicalAck, {});
  const readback = (await rpc("thread/read", {threadId, includeTurns: false})).thread;
  assert.equal(readback.model, "gpt-5.6-terra");
  assert.equal(readback.reasoningEffort, "medium");
  await new Promise(resolve => setTimeout(resolve, 200));
  const identicalEvents = notifications.slice(identicalAt)
    .filter(message => message.method === "thread/settings/updated");
  assert.equal(identicalEvents.length, 0);

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
      && Object.hasOwn(settings, "effort") && settings.effort === null
      && settings.collaborationMode?.settings?.model === "gpt-5.6-sol"
      && Object.hasOwn(settings.collaborationMode.settings, "reasoning_effort")
      && settings.collaborationMode?.settings?.reasoning_effort === null);
  assert.equal(restored.collaborationMode.mode, routed.collaborationMode.mode);
  assert.equal(restored.collaborationMode.settings.developer_instructions, developerInstructions);
  console.log(JSON.stringify({
    schema: "statewright/codex-default-effort-canary/v1",
    binary,
    result: "pass",
    inference_started: false,
    identical_update_acknowledged: true,
    identical_update_notifications: identicalEvents.length,
    original: { model: original.model, effort_present: Object.hasOwn(original, "effort"), effort: original.effort,
      collaboration_effort_present: Object.hasOwn(original.collaborationMode.settings, "reasoning_effort"),
      collaboration_effort: original.collaborationMode.settings.reasoning_effort },
    routed: { model: routed.model, effort_present: Object.hasOwn(routed, "effort"), effort: routed.effort,
      collaboration_effort_present: Object.hasOwn(routed.collaborationMode.settings, "reasoning_effort"),
      collaboration_effort: routed.collaborationMode.settings.reasoning_effort },
    restored: { model: restored.model, effort_present: Object.hasOwn(restored, "effort"), effort: restored.effort,
      collaboration_effort_present: Object.hasOwn(restored.collaborationMode.settings, "reasoning_effort"),
      collaboration_effort: restored.collaborationMode.settings.reasoning_effort },
    collaboration_mode_preserved: true,
    explicit_developer_instructions_preserved: true,
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
