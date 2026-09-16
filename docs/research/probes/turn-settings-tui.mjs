// Native TUI diagnostic. Only model responses and an inert tool are scripted.
// Does not attach user sessions, load user auth, or contact an inference provider.
// Usage: node docs/research/probes/turn-settings-tui.mjs /path/to/codex-source
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {createInterface} from "node:readline";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {once} from "node:events";
import {randomUUID} from "node:crypto";
import {WebSocketServer} from "../../../plugins/executor/node_modules/ws/wrapper.mjs";

const binary = process.env.CODEX_PROBE_BINARY ?? "/opt/homebrew/bin/codex";
const home = await mkdtemp(join(tmpdir(), "statewright-step-tui-"));
const catalog = JSON.parse(await readFile(join(resolve(process.argv[2]), "codex-rs/models-manager/models.json"), "utf8"));
const template = catalog.models.find(model => model.slug === "gpt-5.4");
const models = ["probe-a", "probe-b"].map(slug => ({...structuredClone(template), slug, display_name: slug}));
await writeFile(join(home, "models.json"), JSON.stringify({models}), {mode: 0o600});
const requests = [], auxiliaryRequests = [], events = [], downstreamRequests = [], updates = [];
const secret = randomUUID();
let boundary, heldResponse, native, client, active;
const pending = new Map();
const send = message => native.stdin.write(`${JSON.stringify(message)}\n`);
const rpc = (method, params) => new Promise((resolveResponse, reject) => {
  const id = `probe-internal-${randomUUID()}`;
  const timer = setTimeout(() => {pending.delete(id); reject(new Error(`timeout ${method}`));}, 10000);
  pending.set(id, {resolve: resolveResponse, reject, timer});
  send({id, method, params});
});
const sse = (res, id, item) => {
  res.writeHead(200, {"Content-Type": "text/event-stream"});
  res.end([
    {type: "response.created", response: {id}},
    {type: "response.output_item.done", item},
    {type: "response.completed", response: {id, usage: {input_tokens: 0, output_tokens: 0, total_tokens: 0}}},
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
};
const finish = (res, n, text) => sse(res, `response-${n}`, {type: "message", id: `answer-${n}`, role: "assistant",
  content: [{type: "output_text", text}]});
const server = createServer(async (req, res) => {
  try {
    if (req.url === `/${secret}/evidence`) {
      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({requests, auxiliaryRequests, events, downstreamRequests, updates, boundary: Boolean(boundary), held: Boolean(heldResponse), active})); return;
    }
    if (req.method === "POST" && req.url === `/${secret}/release`) {
      if (!boundary) throw new Error("no boundary pending");
      const saved = boundary;
      const result = await rpc("turn/settings/update", {threadId: saved.params.threadId, turnId: saved.params.turnId, model: "probe-b", effort: "high"});
      updates.push(result);
      if (result.status !== "applied") throw new Error(`not applied: ${JSON.stringify(result)}`);
      send({id: saved.id, result: {contentItems: [{type: "inputText", text: "Boundary released after live settings update."}], success: true}});
      boundary = null;
      res.end(JSON.stringify(result)); return;
    }
    if (req.method === "POST" && req.url === `/${secret}/finish`) {
      if (!heldResponse) throw new Error("no model response held");
      finish(heldResponse, requests.length, "NATIVE_SWITCH_COMPLETE — model B/high used within the original turn.");
      heldResponse = null;
      res.end("finished"); return;
    }
    if (!req.url.endsWith("/responses")) {res.writeHead(404); res.end(); return;}
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (JSON.stringify(body.input).includes("Generate a concise, single-line task title")) {
      auxiliaryRequests.push({purpose: "native TUI title generation", model: body.model});
      finish(res, `title-${auxiliaryRequests.length}`, JSON.stringify({title: "Test live switching"})); return;
    }
    requests.push({model: body.model, effort: body.reasoning?.effort});
    const n = requests.length;
    if (n === 1) sse(res, "response-1", {type: "function_call", call_id: "boundary", name: "boundary_probe", arguments: "{}"});
    else if (n === 2 || n === 4) heldResponse = res;
    else finish(res, n, n === 3 ? "QUEUED_DRAFT_RECEIVED — next turn ran normally." : "FOLLOWUP_RECEIVED — client remains usable.");
  } catch (error) {res.writeHead(409); res.end(error.message);}
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const env = {...process.env, CODEX_HOME: home, LC_ALL: "C", LANG: "C"};
for (const key of Object.keys(env)) {
  if (key.startsWith("STATEWRIGHT_") || (key.startsWith("CODEX_") && key !== "CODEX_HOME")
      || key === "OPENAI_API_KEY" || key === "OPENAI_BASE_URL") delete env[key];
}
native = spawn(binary, ["app-server", "--stdio", "-c", 'model_provider="scripted"', "-c", 'model="probe-a"',
  "-c", `model_catalog_json=${JSON.stringify(join(home, "models.json"))}`,
  "-c", 'features.step_model_switching=true', "-c", 'features.code_mode=false', "-c", 'model_reasoning_effort="low"',
  "-c", `model_providers.scripted={name="Scripted research only",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
], {cwd: home, env, stdio: ["pipe", "pipe", "pipe"]});
const exited = once(native, "exit");
native.stderr.on("data", () => {});
const frontend = new WebSocketServer({port: 0, host: "127.0.0.1"});
await once(frontend, "listening");
frontend.on("connection", socket => {
  if (client) {socket.close(1008, "one isolated client only"); return;}
  client = socket;
  socket.on("message", raw => {
    const message = JSON.parse(String(raw));
    downstreamRequests.push({method: message.method, text: ["turn/start", "turn/steer"].includes(message.method) ? message.params.input?.map(x => x.text).join(" ") : undefined});
    if (message.method === "initialize") message.params.capabilities = {...message.params.capabilities, experimentalApi: true};
    if (message.method === "thread/start") Object.assign(message.params, {model: "probe-a", modelProvider: "scripted", cwd: home,
      dynamicTools: [{type: "function", name: "boundary_probe", description: "Inert research barrier", inputSchema: {type: "object", properties: {}}}]});
    send(message);
  });
});
const lines = createInterface({input: native.stdout});
lines.on("line", line => {
  const message = JSON.parse(line), entry = !message.method && pending.get(message.id);
  if (entry) {
    clearTimeout(entry.timer); pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); return;
  }
  if (message.method === "item/tool/call") {boundary = message; return;}
  if (message.method === "turn/started") active = {threadId: message.params.threadId, turnId: message.params.turn.id};
  if (message.method === "turn/completed") {
    events.push({method: message.method, status: message.params.turn.status, turnId: message.params.turn.id});
    active = null;
  }
  if (["warning", "error"].includes(message.method)) events.push({method: message.method, params: message.params});
  if (client?.readyState === 1) client.send(JSON.stringify(message));
});
console.log(JSON.stringify({home, url: `ws://127.0.0.1:${frontend.address().port}`, control: `http://127.0.0.1:${server.address().port}/${secret}`, inference: "scripted loopback only"}));
async function close() {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  for (const socket of frontend.clients) socket.terminate();
  frontend.close(); server.closeAllConnections(); server.close();
  native.kill("SIGTERM");
  const timer = setTimeout(() => native.kill("SIGKILL"), 2000);
  await exited; clearTimeout(timer); lines.close(); process.exit(0);
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
setTimeout(close, 600000).unref();
