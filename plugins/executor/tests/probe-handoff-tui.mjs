// Manual native-rendering probe. Real Codex metadata server, scripted turns;
// never starts inference, executes a model tool, or attaches an existing thread.
import {spawn} from "node:child_process";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:net";
import {once} from "node:events";
import {WebSocket, WebSocketServer} from "ws";
import {HandoffPresentation, hardInterruptNotice} from "../lib/app-server-handoff.mjs";

const home = await mkdtemp(join(tmpdir(), "statewright-handoff-tui-"));
const portReservation = createServer();
portReservation.listen(0, "127.0.0.1");
await once(portReservation, "listening");
const port = portReservation.address().port;
await new Promise(resolve => portReservation.close(resolve));
const env = {...process.env, CODEX_HOME: home, LC_ALL: "C", LANG: "C"};
for (const name of Object.keys(env)) {
  if (name.startsWith("STATEWRIGHT_") || (name.startsWith("CODEX_") && name !== "CODEX_HOME")
      || name === "OPENAI_API_KEY" || name === "OPENAI_BASE_URL") delete env[name];
}
const native = spawn("/opt/homebrew/bin/codex", ["app-server", "--listen", `ws://127.0.0.1:${port}`],
  {cwd: home, env, stdio: ["ignore", "ignore", "pipe"]});
let stderr = "";
native.stderr.on("data", chunk => {stderr = (stderr + chunk).slice(-4000);});
const backend = new WebSocketServer({port: 0, host: "127.0.0.1"});
await once(backend, "listening");
backend.on("connection", client => {
  const upstream = new WebSocket(`ws://127.0.0.1:${port}`);
  const ready = once(upstream, "open");
  const presenter = new HandoffPresentation({
    onStatus: event => console.log(JSON.stringify({type: "status", ...event}))});
  let active = null;
  const send = value => {
    if (value.method === "item/started") value.params.startedAtMs = Date.now();
    if (value.method === "item/completed") value.params.completedAtMs = Date.now();
    presenter.observe(value);
    for (const event of presenter.present(value)) client.send(JSON.stringify(event));
  };
  const message = (threadId, turnId, text) => {
    const item = {id: `message_${turnId}`, type: "agentMessage", phase: "commentary", text};
    for (const method of ["item/started", "item/completed"]) send({method, params: {threadId, turnId, item}});
  };
  upstream.on("message", raw => client.send(String(raw)));
  upstream.on("error", error => console.error(error.message));
  client.on("message", async raw => {
    const req = JSON.parse(String(raw));
    console.log(JSON.stringify({type: "request", method: req.method}));
    if (req.method === "account/read") {
      client.send(JSON.stringify({id: req.id, result: {account: {type: "apiKey"}, requiresOpenaiAuth: false}}));
      return;
    }
    if (req.method === "turn/interrupt") {
      client.send(JSON.stringify({id: req.id, result: {}}));
      if (active) {
        for (const event of presenter.userActivity(active.threadId)) client.send(JSON.stringify(event));
        send({method: "turn/completed", params: {threadId: active.threadId,
          turn: {id: active.turnId, status: "interrupted", items: [], error: null}}});
        active = null;
      }
      return;
    }
    if (req.method !== "turn/start") {
      await ready;
      upstream.send(String(raw));
      return;
    }
    const threadId = req.params.threadId, turnId = `probe-${Date.now()}`;
    active = {threadId, turnId};
    client.send(JSON.stringify({id: req.id, result: {turn: {id: turnId, status: "inProgress", items: [], error: null}}}));
    send({method: "turn/started", params: {threadId, turn: {id: turnId, status: "inProgress", items: [], error: null}}});
    const prompt = req.params.input?.[0]?.text ?? "";
    if (prompt.includes("cancel")) {
      message(threadId, turnId, "CANCEL_PROBE_READY — press Escape; this is a real operator interruption.");
      console.log("CANCEL_PROBE_READY");
      return;
    }
    message(threadId, turnId, "NATIVE_HANDOFF_BEFORE — scripted rendering probe; no model inference.");
    send({method: "warning", params: {threadId, message: hardInterruptNotice(
      {provider: "openai", model: "gpt-5.6-sol"}, {provider: "openai", model: "gpt-6-astra"})}});
    send({method: "turn/completed", params: {threadId, turn: {id: turnId, status: "interrupted", items: [], error: null}}});
    presenter.prepare(threadId, "scripted-start", {runId: "isolated-probe", state: "intake", model: "gpt-6-astra", effort: "high"});
    presenter.beginSwitch(threadId, "gpt-5.6-sol", "gpt-6-astra");
    send({method: "warning", params: {threadId, message:
      "This session was recorded with model `gpt-5.6-sol` but is resuming with `gpt-6-astra`. Consider switching back to `gpt-5.6-sol` as it may affect Codex performance."}});
    presenter.finishSwitch(threadId, true);
    await new Promise(resolve => setTimeout(resolve, 500));
    if (!active) return;
    if (prompt.includes("failure")) {
      for (const event of presenter.cancel(threadId)) client.send(JSON.stringify(event));
      send({method: "error", params: {threadId, turnId, willRetry: false,
        error: {message: "Statewright: scripted handoff failed", codexErrorInfo: null, additionalDetails: null}}});
      active = null;
      return;
    }
    const next = `${turnId}-next`;
    for (const event of presenter.accept(threadId, "scripted-start", next)) client.send(JSON.stringify(event));
    send({method: "turn/started", params: {threadId, turn: {id: next, status: "inProgress", items: [], error: null}}});
    message(threadId, next, "NATIVE_HANDOFF_AFTER — continuation rendered; normal completion follows.");
    send({method: "turn/completed", params: {threadId, turn: {id: next, status: "completed", items: [], error: null}}});
    active = null;
    console.log("NORMAL_PROBE_FINISHED");
  });
  client.on("close", () => upstream.close());
});
let ready = false;
for (let i = 0; i < 100; i++) {
  if (native.exitCode !== null) throw new Error(`Native startup failed: ${stderr}`);
  const test = new WebSocket(`ws://127.0.0.1:${port}`);
  ready = await new Promise(resolve => {test.once("open", () => {test.close(); resolve(true);}); test.once("error", () => resolve(false));});
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 50));
}
if (!ready) throw new Error(`Native startup timed out: ${stderr}`);
console.log(JSON.stringify({home, url: `ws://127.0.0.1:${backend.address().port}`, inference: "disabled: turn/start intercepted"}));
async function close() {
  for (const client of backend.clients) client.terminate();
  backend.close();
  native.kill("SIGTERM");
  await once(native, "exit");
  process.exit(0);
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
