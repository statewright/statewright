// Native settings only: no inference, MCP, auth copy or user-owned thread.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export async function nativeSettingsFixture(t, threadId, notify) {
  const home = await mkdtemp(join(tmpdir(), "statewright-native-settings-"));
  const env = {...process.env, HOME: home, CODEX_HOME: home, LC_ALL: "C", LANG: "C"};
  for (const key of Object.keys(env)) {
    if (key.startsWith("STATEWRIGHT_") || key.startsWith("CODEX_") && key !== "CODEX_HOME"
        || ["OPENAI_API_KEY", "OPENAI_BASE_URL"].includes(key)) delete env[key];
  }
  const binary = process.env.CODEX_PROBE_BINARY
    ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  const child = spawn(binary, ["app-server", "--stdio"], {cwd: home, env, stdio: ["pipe", "pipe", "pipe"]});
  child.stderr.resume();
  const pending = new Map();
  let spawnError;
  const exited = new Promise(resolve => {
    child.once("exit", resolve);
    child.once("error", error => {
      spawnError = error;
      for (const request of pending.values()) {clearTimeout(request.timer); request.reject(error);}
      pending.clear(); resolve();
    });
  });
  let sequence = 0, nativeId, settings, deliver = false;
  const settingsByThread = new Map();
  const lines = createInterface({input: child.stdout});
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.method === "thread/settings/updated") {
      // The native server can publish initial settings before thread/start's
      // reply gives this fixture the ID. Retain that real notification.
      settingsByThread.set(message.params.threadId, message.params.threadSettings);
      if (message.params.threadId === nativeId) {
        settings = message.params.threadSettings;
        if (deliver) notify({...message, params: {...message.params, threadId}});
      }
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (spawnError) {reject(spawnError); return;}
    const id = ++sequence;
    const timer = setTimeout(() => {pending.delete(id); reject(new Error(`Native settings timeout: ${method}`));}, 8_000);
    pending.set(id, {resolve, reject, timer});
    child.stdin.write(`${JSON.stringify({id, method, params})}\n`);
  });
  t.after(async () => {
    for (const request of pending.values()) clearTimeout(request.timer);
    lines.close(); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try { await exited; } finally {clearTimeout(timer); await rm(home, {recursive: true, force: true});}
  });
  await rpc("initialize", {clientInfo: {name: "statewright_native_settings_fixture", version: "1"},
    capabilities: {experimentalApi: true}});
  child.stdin.write('{"method":"initialized"}\n');
  nativeId = (await rpc("thread/start", {cwd: home, model: "gpt-6-sol", approvalPolicy: "never"})).thread.id;
  settings = settingsByThread.get(nativeId);
  await rpc("thread/settings/update", {threadId: nativeId, model: "gpt-6-sol", effort: "high", serviceTier: "priority",
    collaborationMode: {mode: "default", settings: {model: "gpt-6-sol", reasoning_effort: "high", developer_instructions: null}}});
  await rpc("thread/read", {threadId: nativeId, includeTurns: false});
  if (!settings) throw new Error("Native settings baseline was not observed");
  deliver = true;
  return {
    settings,
    update: params => rpc("thread/settings/update", {...params, threadId: nativeId}),
    read: async () => {
      const result = await rpc("thread/read", {threadId: nativeId, includeTurns: false});
      return {thread: {...result.thread, id: threadId}};
    },
  };
}
