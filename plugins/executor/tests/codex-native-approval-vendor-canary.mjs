import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { approvalJournal } from "../lib/approval-journal.mjs";
import { startCodexAppServerRuntime } from "../lib/codex-app-server-transport.mjs";

const command = process.env.CODEX_BIN;
if (!command) throw new Error("CODEX_BIN must name the vendor Codex binary, not a managed shim");
const home = await mkdtemp(join(tmpdir(), "statewright-vendor-approval-"));
const clientId = "swc_isolated_vendor_approval";
const journal = approvalJournal(join(home, "approvals"), clientId);
const frames = [];
let state = null, runtime, socket, nativeTurnStarts = 0, decisions = 0;
const deadline = (promise, ms = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Vendor approval canary timed out")), ms);
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const waitFrame = async predicate => {
  const stop = Date.now() + 15000;
  while (Date.now() < stop) {
    const frame = frames.find(predicate);
    if (frame) return frame;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Missing native approval protocol frame");
};
let requestId = 0;
const rpc = async (method, params = {}) => {
  const id = ++requestId;
  socket.send(JSON.stringify({ id, method, params }));
  const frame = await waitFrame(value => value.id === id);
  if (frame.error) throw new Error(frame.error.message);
  return frame.result;
};
try {
  const codexHome = join(home, ".codex");
  await mkdir(codexHome);
  const environment = { ...process.env, HOME: home, CODEX_HOME: codexHome, STATEWRIGHT_SENTRY_DISABLED: "true" };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("STATEWRIGHT_") && key !== "STATEWRIGHT_SENTRY_DISABLED") delete environment[key];
    if (/API_KEY|AUTH_TOKEN/.test(key)) delete environment[key];
  }
  runtime = await startCodexAppServerRuntime({ command, home, cwd: home, environment, clientId,
    reporter: { async report() {} }, stderr: { write() {} },
    telemetry: async (event, value) => {
      if (event === "app_server_route_injected") nativeTurnStarts += 1;
    },
    approvalService: {
      park: (thread, snapshot) => journal.save(thread, snapshot),
      restore: thread => journal.load(thread),
      clear: (thread, id) => journal.clear(thread, id),
      getState: async () => state,
      read: async ticket => ({ ...ticket, status: "pending", can_decide: true,
        approval_requirement: { reviewers: [{ email: "reviewer@example.invalid", role: "workflow_creator" }] } }),
      resolve: async () => { decisions += 1; throw new Error("This canary must not decide an approval"); },
    } });
  socket = new WebSocket(runtime.proxyUrl);
  socket.on("message", raw => frames.push(JSON.parse(String(raw))));
  await deadline(new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }));
  await rpc("initialize", { clientInfo: { name: "statewright-approval-protocol-canary", version: "1" },
    capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  const started = await rpc("thread/start", { approvalPolicy: "never", sandbox: "read-only" });
  const threadId = started.thread.id;
  state = { run_id: "fixture-run", run_session_id: "fixture-session", state: "awaiting",
    pending_approval: { approval_id: "fixture-approval", from_state: "awaiting", to_state: "verified" } };
  const id = ++requestId;
  socket.send(JSON.stringify({ id, method: "turn/start", params: { threadId,
    input: [{ type: "text", text: "Do not run: this request must be parked before native inference." }] } }));
  const form = await waitFrame(value => value.method === "mcpServer/elicitation/request");
  assert.match(form.params.message, /reviewer@example.invalid/);
  assert.ok(await journal.load(threadId));
  socket.send(JSON.stringify({ id: form.id, result: { action: "cancel", content: null, _meta: null } }));
  const reply = await waitFrame(value => value.id === id);
  assert.match(reply.error.message, /dismissed/);
  assert.ok(await journal.load(threadId), "dismissal must retain the checkpoint");
  const after = await rpc("thread/read", { threadId, includeTurns: false });
  assert.equal(after.thread.status.type, "idle");
  assert.equal(frames.filter(value => value.method === "turn/started").length, 0,
    "a parked request must never start a native turn");
  assert.equal(decisions, 0);
  assert.equal(nativeTurnStarts, 0);
  console.log(JSON.stringify({ schema: "statewright/vendor-approval-protocol-canary/v1", outcome: "pass",
    binary: command, checked: ["real-native-goal-get", "native-form-frame", "creator-label", "cancel-keeps-journal", "turn-blocked-before-inference"],
    native_inference_turns: nativeTurnStarts, approval_decisions: decisions }));
} finally {
  socket?.terminate();
  await runtime?.close();
  await rm(home, { recursive: true, force: true });
}
