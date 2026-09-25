import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startCodexAppServerRuntime } from "../lib/codex-app-server-transport.mjs";

const command = process.env.CODEX_BIN;
if (!command) throw new Error("CODEX_BIN must name the vendor Codex binary, not a managed shim");
const home = await mkdtemp(join(tmpdir(), "statewright-vendor-goal-"));
const frames = [];
let runtime, socket, requestId = 0;
const deadline = (promise, ms = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Vendor goal canary timed out")), ms);
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const waitFrame = async predicate => {
  const stop = Date.now() + 15000;
  while (Date.now() < stop) {
    const frame = frames.find(predicate);
    if (frame) return frame;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Missing native goal protocol frame");
};
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
  runtime = await startCodexAppServerRuntime({ command, home, cwd: home, environment,
    clientId: "swc_isolated_vendor_goal", reporter: { async report() {} }, stderr: { write() {} } });
  socket = new WebSocket(runtime.proxyUrl);
  socket.on("message", raw => frames.push(JSON.parse(String(raw))));
  await deadline(new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }));
  await rpc("initialize", { clientInfo: { name: "statewright-goal-protocol-canary", version: "1" },
    capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  const started = await rpc("thread/start", { approvalPolicy: "never", sandbox: "read-only" });
  const threadId = started.thread.id;
  const objective = "Verify native Statewright goal creation and follow-on execution";
  const created = await rpc("thread/goal/set", { threadId, status: "active", objective });
  assert.equal(created.goal?.threadId, threadId);
  assert.equal(created.goal?.status, "active");
  assert.equal(created.goal?.objective, objective);
  assert.ok(created.goal?.createdAt, "goal creation must return native creation metadata");
  const readback = await rpc("thread/goal/get", { threadId });
  assert.deepEqual(readback.goal, created.goal, "goal readback must match native creation response");
  const startedTurn = await waitFrame(value => value.method === "turn/started");
  assert.ok(startedTurn.params.turn.id, "active goal creation must report its native follow-on turn");
  console.log(JSON.stringify({ schema: "statewright/vendor-goal-protocol-canary/v1", outcome: "pass", binary: command,
    checked: ["native-goal-create-response", "native-goal-durable-readback", "active-goal-emits-follow-on-turn"],
    goal_created_at: created.goal.createdAt, turn_id: startedTurn.params.turn.id }));
} finally {
  socket?.terminate();
  await runtime?.close();
  await rm(home, { recursive: true, force: true });
}
