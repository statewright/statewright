// Real native app-server + production Statewright proxy. Model HTTP only is scripted.
// No existing sessions, user auth, production MCP or remote inference.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {createServer} from "node:http";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {once} from "node:events";
import {WebSocket, WebSocketServer} from "../../../plugins/executor/node_modules/ws/wrapper.mjs";
import {startCodexAppServerRouteProxy} from "../../../plugins/executor/lib/codex-app-server-route-proxy.mjs";

const home = await mkdtemp(join(tmpdir(), "statewright-hard-roundtrip-"));
const qwenToOpenAi = process.argv.includes("--qwen-to-openai");
const catalog = JSON.parse(await readFile(join(resolve(process.argv[2]), "codex-rs/models-manager/models.json"), "utf8"));
const models = catalog.models.filter(model => ["gpt-5.6-sol", "gpt-6-astra"].includes(model.slug));
models.push({...structuredClone(catalog.models.find(model => model.slug === "gpt-5.4")), slug: "qwen3.8-27b"});
const catalogPath = join(home, "catalog.json");
await writeFile(catalogPath, JSON.stringify({models}));
let held, native, peer, proxy, client, route, sequence = 0, blocked = false;
const requests = [], auxiliaryRequests = [], events = [], nativeCalls = [], control = new Map();
const streamEvents = (id, text) => {
  const response = {id, usage: {input_tokens: 0, output_tokens: 0, total_tokens: 0}};
  return [{type: "response.created", response}, {type: "response.output_item.done", item: {type: "message", id: `answer-${id}`, role: "assistant", content: [{type: "output_text", text}]}}, {type: "response.completed", response}];
};
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (req.url.startsWith("/qwen/") && body.model !== "qwen3.8-27b") {
    auxiliaryRequests.push({endpoint: req.url, model: body.model, purpose: "wrong-model destination compaction", rejected: true});
    res.writeHead(404, {"Content-Type": "application/json"});
    res.end(JSON.stringify({error: {type: "invalid_request_error", code: "model_not_found", message: `model '${body.model}' not found`, param: "model"}})); return;
  }
  if (req.url.endsWith("/responses/compact")) {
    auxiliaryRequests.push({endpoint: req.url, model: body.model, purpose: "explicit source-provider compaction"});
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({id: "compact-fixture", object: "response.compaction", output: [{type: "compaction", id: "compact-item", encrypted_content: "fixture-checkpoint"}], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}})); return;
  }
  requests.push({endpoint: req.url, model: body.model, effort: body.reasoning?.effort, type: body.type, generate: body.generate, tail: JSON.stringify(body.input?.slice(-1)).slice(0, 240)});
  held = {http: res};
});
const modelSockets = new WebSocketServer({noServer: true});
http.on("upgrade", (req, socket, head) => {
  if (req.url !== "/openai/v1/responses") {socket.destroy(); return;}
  modelSockets.handleUpgrade(req, socket, head, ws => {
    ws.on("message", raw => {
      const body = JSON.parse(String(raw));
      if (body.input?.some(item => item.type === "compaction_trigger")) {
        if (!["gpt-5.6-sol", "gpt-6-astra"].includes(body.model)) {
          auxiliaryRequests.push({endpoint: req.url, model: body.model, purpose: "wrong-model destination compaction", rejected: true});
          ws.send(JSON.stringify({type: "error", error: {type: "invalid_request_error", code: "model_not_found", message: `model '${body.model}' not found`}})); return;
        }
        auxiliaryRequests.push({endpoint: req.url, model: body.model, purpose: "native remote compaction"});
        const response = {id: `compact-${auxiliaryRequests.length}`, usage: {input_tokens: 0, output_tokens: 0, total_tokens: 0}};
        for (const event of [{type: "response.created", response}, {type: "response.output_item.done", item: {type: "compaction", id: "checkpoint", encrypted_content: "fixture-checkpoint"}}, {type: "response.completed", response}]) ws.send(JSON.stringify(event));
        return;
      }
      if (body.generate === false) {
        auxiliaryRequests.push({endpoint: req.url, model: body.model, purpose: "native WebSocket prewarm"});
        for (const event of streamEvents(`warmup-${auxiliaryRequests.length}`, "")) ws.send(JSON.stringify(event));
        return;
      }
      requests.push({endpoint: req.url, model: body.model, effort: body.reasoning?.effort, type: body.type, generate: body.generate, tail: JSON.stringify(body.input?.slice(-1)).slice(0, 240)});
      held = {ws};
    });
  });
});
http.listen(0, "127.0.0.1"); await once(http, "listening");
const base = `http://127.0.0.1:${http.address().port}`;
const env = {...process.env, CODEX_HOME: home, LC_ALL: "C", LANG: "C"};
for (const key of Object.keys(env)) if (key.startsWith("STATEWRIGHT_") || (key.startsWith("CODEX_") && key !== "CODEX_HOME") || key === "OPENAI_API_KEY" || key === "OPENAI_BASE_URL") delete env[key];
env.OPENAI_BASE_URL = `${base}/openai/v1`;
env.OPENAI_API_KEY = "isolated-probe-not-a-real-key";
// routeIdentity reads these only inside this isolated probe process.
process.env.STATEWRIGHT_QWEN_BASE_URL = `${base}/qwen/v1`;
process.env.STATEWRIGHT_QWEN_MODEL_CATALOG = catalogPath;
native = spawn("/opt/homebrew/bin/codex", ["app-server", "--stdio", "-c", 'model="gpt-5.6-sol"',
  "-c", `openai_base_url=${JSON.stringify(`${base}/openai/v1`)}`,
  "-c", `model_catalog_json=${JSON.stringify(catalogPath)}`, "-c", 'features.code_mode=false',
  "-c", `model_providers.qwen_private={name="Isolated Qwen fixture",base_url="${base}/qwen/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
], {cwd: home, env, stdio: ["pipe", "pipe", "pipe"]});
const exited = once(native, "exit");
let stderr = "";
native.stderr.on("data", chunk => {stderr = (stderr + chunk).slice(-4000);});
const send = value => native.stdin.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({input: native.stdout});
lines.on("line", raw => {
  const message = JSON.parse(raw), pending = !message.method && control.get(message.id);
  if (pending) {control.delete(message.id); message.error ? pending.reject(Error(message.error.message)) : pending.resolve(message.result);}
  else if (peer?.readyState === 1) peer.send(raw);
});
const bridge = new WebSocketServer({host: "127.0.0.1", port: 0}); await once(bridge, "listening");
bridge.on("connection", socket => {peer = socket; socket.on("message", raw => {
  const message = JSON.parse(String(raw)); nativeCalls.push({method: message.method, model: message.params?.model, provider: message.params?.modelProvider}); send(message);
});});
const until = async predicate => {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline || native.exitCode !== null) throw Error(`timeout; requests: ${JSON.stringify(requests)}; calls: ${JSON.stringify(nativeCalls)}; events: ${JSON.stringify(events.map(event => ({method: event.method, status: event.params?.turn?.status, message: event.params?.message})))}; native stderr: ${stderr}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
};
const pendingClient = new Map();
const rpc = (method, params, direct = false) => new Promise((resolveRpc, reject) => {
  const id = `probe-${++sequence}`;
  const timer = setTimeout(() => reject(Error(`timeout ${method}: ${stderr}`)), 15000);
  const entry = {resolve: value => {clearTimeout(timer); resolveRpc(value);}, reject: error => {clearTimeout(timer); reject(error);}};
  (direct ? control : pendingClient).set(id, entry);
  const message = {id, method, params};
  direct ? send(message) : client.send(JSON.stringify(message));
});
try {
  proxy = await startCodexAppServerRouteProxy({upstreamUrl: `ws://127.0.0.1:${bridge.address().port}`,
    peekPendingRoute: async () => route,
    takePendingRoute: async () => route ? {route, ack: async () => {route = null;}, release: async () => {}} : null});
  client = new WebSocket(proxy.url); await once(client, "open");
  client.on("message", raw => {
    const message = JSON.parse(String(raw));
    if (message.method) events.push(message);
    else {
      const entry = pendingClient.get(message.id);
      if (entry) {pendingClient.delete(message.id); message.error ? entry.reject(Error(message.error.message)) : entry.resolve(message.result);}
    }
  });
  await rpc("initialize", {clientInfo: {name: "statewright_hard_interrupt_probe", version: "1"}});
  client.send(JSON.stringify({method: "initialized", params: {}}));
  const {thread} = await rpc("thread/start", {cwd: home, model: qwenToOpenAi ? "qwen3.8-27b" : "gpt-5.6-sol", modelProvider: qwenToOpenAi ? "qwen_private" : "openai", approvalPolicy: "never",
    ...(qwenToOpenAi ? {config: {model_context_window: 171648}} : {})});
  const sameProvider = process.argv.includes("--same-provider");
  const targets = qwenToOpenAi ? ["openai-codex/gpt-5.6-sol"] : sameProvider ? ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol"] : ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol", "casa/qwen3.8-27b", "openai-codex/gpt-5.6-sol"];
  for (let n = 0; n <= targets.length; n++) {
    const {turn} = await rpc("turn/start", {threadId: thread.id, input: [{type: "text", text: `Isolated roundtrip ${n}`}], effort: "low"});
    await until(() => requests.length === n + 1 || auxiliaryRequests.some(request => request.rejected) || events.some(event => event.method === "turn/completed" && event.params.turn.id === turn.id));
    if (!sameProvider && auxiliaryRequests.some(request => request.rejected)) {
      // Outbound model/provider mismatch is already decisive. End only this
      // owned diagnostic turn instead of waiting through native retries.
      await rpc("turn/interrupt", {threadId: thread.id, turnId: turn.id}, true);
      await until(() => events.some(event => event.method === "turn/completed" && event.params.turn.id === turn.id));
      blocked = true;
      break;
    }
    if (n < targets.length) {
      route = {session_id: thread.id, turn_id: turn.id, run_id: "probe", state: `phase-${n + 1}`, model: targets[n], effort: "low"};
      // Emulate the existing Statewright interrupt owner, not operator Escape.
      await rpc("turn/interrupt", {threadId: thread.id, turnId: turn.id}, true);
    } else {
      const response = {id: `response-${n}`, usage: {input_tokens: 0, output_tokens: 0, total_tokens: 0}};
      const stream = [{type: "response.created", response}, {type: "response.output_item.done", item: {type: "message", id: "answer", role: "assistant", content: [{type: "output_text", text: "ROUNDTRIP_COMPLETE"}]}}, {type: "response.completed", response}];
      if (held.ws) for (const event of stream) held.ws.send(JSON.stringify(event));
      else {
        held.http.writeHead(200, {"Content-Type": "text/event-stream"});
        held.http.end(stream.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
      }
    }
    await until(() => events.some(event => event.method === "turn/completed" && event.params.turn.id === turn.id));
    const index = events.findIndex(event => event.method === "turn/completed" && event.params.turn.id === turn.id);
    assert.equal(events[index].params.turn.status, n < targets.length ? "interrupted" : "completed");
    if (n < targets.length) assert.match(events[index - 1]?.params?.message ?? "", /^\[statewright\] switching from .+=>.+, hard interrupt required$/);
  }
  assert.deepEqual(requests.map(request => request.model), qwenToOpenAi ? ["qwen3.8-27b"] : ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-sol"]);
  if (!sameProvider) assert(blocked, "this pinned native version must reproduce the provider compaction blocker");
  console.log(JSON.stringify({binary: "Codex 0.153.4", outcome: blocked ? qwenToOpenAi ? "blocked_qwen_to_openai_compaction" : "blocked_openai_to_qwen_compaction" : "sol_astra_roundtrip_passed", scope: "Real native app-server and production proxy; scripted HTTP/WebSocket model endpoints; not live inference or production Statewright workflow", requests, auxiliaryRequests,
    notices: events.filter(event => event.method === "warning" && event.params.message.startsWith("[statewright]")).map(event => event.params.message),
    terminals: events.filter(event => event.method === "turn/completed").map(event => event.params.turn.status), nativeCalls}));
} finally {
  client?.terminate(); await proxy?.close();
  for (const socket of bridge.clients) socket.terminate(); bridge.close();
  native.kill("SIGTERM"); const timer = setTimeout(() => native.kill("SIGKILL"), 2000); await exited; clearTimeout(timer);
  lines.close(); for (const socket of modelSockets.clients) socket.terminate(); modelSockets.close(); http.closeAllConnections(); http.close();
}
