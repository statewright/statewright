import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { approvalJournal } from "../lib/approval-journal.mjs";
import { startCodexAppServerRuntime } from "../lib/codex-app-server-transport.mjs";

if (process.platform !== "win32") throw new Error("The Windows managed App Server canary must run on a Windows runner.");
const command = process.env.CODEX_BIN;
if (!command) throw new Error("CODEX_BIN must be the resolved Windows Codex launcher.");

const home = await mkdtemp(join(tmpdir(), "statewright-windows-app-server-"));
const clientId = "swc_windows_app_server_canary";
const journal = approvalJournal(join(home, "approvals"), clientId);
const frames = [];
let runtime, socket, state = null, nativeTurnStarts = 0, decisions = 0, requestId = 0;

const deadline = (promise, ms = 20_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Windows managed App Server canary timed out")), ms);
  Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
async function waitFrame(predicate) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const frame = frames.find(predicate);
    if (frame) return frame;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("Missing Windows native approval protocol frame");
}
async function rpc(method, params = {}) {
  const id = ++requestId;
  socket.send(JSON.stringify({ id, method, params }));
  const frame = await waitFrame((value) => value.id === id);
  if (frame.error) throw new Error(frame.error.message);
  return frame.result;
}

try {
  const codexHome = join(home, ".codex");
  await mkdir(codexHome);
  const environment = { ...process.env, HOME: home, USERPROFILE: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2), CODEX_HOME: codexHome, STATEWRIGHT_SENTRY_DISABLED: "true" };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("STATEWRIGHT_") && key !== "STATEWRIGHT_SENTRY_DISABLED") delete environment[key];
    if (/API_KEY|AUTH_TOKEN/.test(key)) delete environment[key];
  }
  runtime = await startCodexAppServerRuntime({
    command, home, cwd: home, environment, clientId,
    reporter: { async report() {} }, stderr: { write() {} },
    telemetry: async (event) => { if (event === "app_server_route_injected") nativeTurnStarts += 1; },
    approvalService: {
      park: (thread, snapshot) => journal.save(thread, snapshot),
      restore: (thread) => journal.load(thread),
      clear: (thread, id) => journal.clear(thread, id),
      getState: async () => state,
      read: async (ticket) => ({ ...ticket, status: "pending", can_decide: true, approval_requirement: { reviewers: [{ email: "reviewer@example.invalid", role: "workflow_creator" }] } }),
      resolve: async () => { decisions += 1; throw new Error("This canary must not decide an approval"); },
    },
  });
  socket = new WebSocket(runtime.proxyUrl);
  socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  await deadline(new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }));
  await rpc("initialize", { clientInfo: { name: "statewright-windows-approval-protocol-canary", version: "1" }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  const started = await rpc("thread/start", { approvalPolicy: "never", sandbox: "read-only" });
  const threadId = started.thread.id;
  const notification = await waitFrame((value) => typeof value.method === "string" && value.id === undefined);
  assert.ok(notification.method, "the native App Server must emit a server notification after initialization");
  state = { run_id: "windows-fixture-run", run_session_id: "windows-fixture-session", state: "awaiting", pending_approval: { approval_id: "windows-fixture-approval", from_state: "awaiting", to_state: "verified" } };
  const id = ++requestId;
  socket.send(JSON.stringify({ id, method: "turn/start", params: { threadId, input: [{ type: "text", text: "Do not run: this request must be parked before native inference." }] } }));
  const form = await waitFrame((value) => value.method === "mcpServer/elicitation/request");
  assert.match(form.params.message, /reviewer@example.invalid/);
  assert.ok(await journal.load(threadId), "the pending approval must be journaled");
  socket.send(JSON.stringify({ id: form.id, result: { action: "cancel", content: null, _meta: null } }));
  const reply = await waitFrame((value) => value.id === id);
  assert.match(reply.error.message, /dismissed/);
  assert.ok(await journal.load(threadId), "dismissal must retain the journaled checkpoint");
  const after = await rpc("thread/read", { threadId, includeTurns: false });
  assert.equal(after.thread.status.type, "idle");
  assert.equal(frames.filter((value) => value.method === "turn/started").length, 0, "a parked request must never start a native turn");
  assert.equal(decisions, 0);
  assert.equal(nativeTurnStarts, 0);
  console.log(JSON.stringify({ schema: "statewright/windows-managed-app-server-canary/v1", outcome: "pass", binary: command, checked: ["real-native-initialize", "server-notifications", "native-form-frame", "journal-retained-on-cancel", "turn-blocked-before-inference"], native_inference_turns: nativeTurnStarts, approval_decisions: decisions }));
} finally {
  socket?.terminate();
  await runtime?.close();
  await rm(home, { recursive: true, force: true });
}
