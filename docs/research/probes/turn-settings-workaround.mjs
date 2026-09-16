// Research-only diagnostic: stock Codex + loopback scripted Responses provider.
// No real inference, shell tool, production MCP, existing session, or user auth.
// Usage: node docs/research/probes/turn-settings-workaround.mjs /path/to/codex-source
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {createInterface} from "node:readline";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {once} from "node:events";

const source = resolve(process.argv[2]);
const catalog = JSON.parse(await readFile(join(source, "codex-rs/models-manager/models.json"), "utf8"));
const template = catalog.models.find(model => model.slug === "gpt-5.4");
assert(template, "pinned source must contain the test template");
const created = id => ({type: "response.created", response: {id}});
const completed = id => ({type: "response.completed", response: {id,
  usage: {input_tokens: 0, output_tokens: 0, total_tokens: 0}}});
const answer = id => ({type: "response.output_item.done", item: {type: "message", id,
  role: "assistant", content: [{type: "output_text", text: "Scripted diagnostic complete."}]}});

async function scenario(mode) {
  const home = await mkdtemp(join(tmpdir(), "statewright-step-settings-"));
  const realPair = mode === "sol-to-astra" || mode === "astra-to-sol";
  const effortOnly = mode === "sol-effort-only";
  const initialModel = mode === "sol-to-astra" || effortOnly ? "gpt-5.6-sol" : mode === "astra-to-sol" ? "gpt-6-astra" : "probe-a";
  const targetModel = effortOnly ? initialModel : mode === "sol-to-astra" ? "gpt-6-astra" : mode === "astra-to-sol" ? "gpt-5.6-sol" : "probe-b";
  const models = realPair || effortOnly ? [...new Set([initialModel, targetModel])].map(slug => {
    const model = catalog.models.find(entry => entry.slug === slug);
    assert(model, `missing actual catalog entry ${slug}`);
    return structuredClone(model);
  }) : ["probe-a", "probe-b"].map(slug => ({...structuredClone(template), slug}));
  if (mode === "unsafe-destination") models[1].node_repl_disabled = !models[0].node_repl_disabled;
  const catalogPath = join(home, "models.json");
  await writeFile(catalogPath, JSON.stringify({models}), {mode: 0o600});
  const requests = [], notifications = [];
  const http = createServer(async (req, res) => {
    if (!req.url.endsWith("/responses")) {res.writeHead(404); res.end(); return;}
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    requests.push({model: parsed.model, effort: parsed.reasoning?.effort});
    const id = `scripted-${requests.length}`;
    const item = requests.length === 1
      ? {type: "response.output_item.done", item: {type: "function_call", call_id: "boundary", name: "boundary_probe", arguments: "{}"}}
      : answer(`answer-${requests.length}`);
    res.writeHead(200, {"Content-Type": "text/event-stream"});
    res.end([created(id), item, completed(id)].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const env = {...process.env, CODEX_HOME: home, LC_ALL: "C", LANG: "C"};
  for (const key of Object.keys(env)) {
    if (key.startsWith("STATEWRIGHT_") || (key.startsWith("CODEX_") && key !== "CODEX_HOME")
        || key === "OPENAI_API_KEY" || key === "OPENAI_BASE_URL") delete env[key];
  }
  const child = spawn(process.env.CODEX_PROBE_BINARY ?? "/opt/homebrew/bin/codex", ["app-server", "--stdio",
    "-c", 'model_provider="scripted"', "-c", `model=${JSON.stringify(initialModel)}`,
    "-c", `model_catalog_json=${JSON.stringify(catalogPath)}`,
    "-c", 'model_reasoning_effort="low"', "-c", 'features.code_mode=false',
    "-c", `features.step_model_switching=${mode !== "flag-off"}`,
    "-c", `model_providers.scripted={name="Scripted research only",base_url="http://127.0.0.1:${http.address().port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
  ], {cwd: home, env, stdio: ["pipe", "pipe", "pipe"]});
  const exited = once(child, "exit");
  let stderr = "", sequence = 0, boundaryRequest;
  child.stderr.on("data", chunk => {stderr = (stderr + chunk).slice(-5000);});
  const pending = new Map();
  const send = msg => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const rpc = (method, params) => new Promise((resolveResponse, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {pending.delete(id); reject(new Error(`timeout ${method}: ${stderr}`));}, 12000);
    pending.set(id, {resolve: resolveResponse, reject, timer});
    send({id, method, params});
  });
  const lines = createInterface({input: child.stdout});
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.method) {
      notifications.push(message);
      if (message.method === "item/tool/call") boundaryRequest = message;
      return;
    }
    const entry = pending.get(message.id);
    if (entry) {
      clearTimeout(entry.timer); pending.delete(message.id);
      message.error ? entry.reject(Object.assign(new Error(message.error.message), {rpcError: message.error})) : entry.resolve(message.result);
    }
  });
  const until = async predicate => {
    const deadline = Date.now() + 12000;
    while (!predicate()) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`diagnostic timed out: ${stderr}; events: ${notifications.map(x => x.method)}`);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
    }
  };
  try {
    await rpc("initialize", {clientInfo: {name: "statewright_research_probe", version: "1"}, capabilities: {experimentalApi: true}});
    send({method: "initialized", params: {}});
    const {thread} = await rpc("thread/start", {model: initialModel, modelProvider: "scripted", cwd: home, approvalPolicy: "never",
      dynamicTools: [{type: "function", name: "boundary_probe", description: "Return inert research marker", inputSchema: {type: "object", properties: {}}}]});
    const {turn} = await rpc("turn/start", {threadId: thread.id, input: [{type: "text", text: "Run the scripted boundary diagnostic."}]});
    await until(() => boundaryRequest);
    assert.equal(boundaryRequest.params.threadId, thread.id);
    assert.equal(boundaryRequest.params.turnId, turn.id);
    const patch = {threadId: thread.id, turnId: turn.id, model: targetModel, effort: "high"};
    if (effortOnly) delete patch.model;
    const guards = {};
    if (mode === "current") {
      guards.staleTurn = await rpc("turn/settings/update", {...patch, turnId: "not-the-active-turn"});
      assert.deepEqual(guards.staleTurn, {status: "targetUnavailable"});
      try {await rpc("turn/settings/update", {...patch, modelProvider: "another-provider"}); assert.fail("provider field must be rejected");}
      catch (error) {assert(error.rpcError); assert.match(error.message, /unknown field/); guards.providerField = error.rpcError;}
    }
    let update;
    if (mode === "thread-only") {
      delete patch.turnId;
      update = await rpc("thread/settings/update", patch);
      await until(() => notifications.some(x => x.method === "thread/settings/updated" && x.params.threadSettings?.model === "probe-b"));
    } else {
      try {update = await rpc("turn/settings/update", patch);}
      catch (error) {if (!["flag-off", "unsafe-destination"].includes(mode) && !realPair) throw error; update = {error: error.rpcError};}
    }
    assert.equal(requests.length, 1, "the tool-result barrier prevents next inference before acknowledgement");
    send({id: boundaryRequest.id, result: {contentItems: [{type: "inputText", text: "Boundary released."}], success: true}});
    await until(() => notifications.some(x => x.method === "turn/completed" && x.params.turn.id === turn.id));
    const second = await rpc("turn/start", {threadId: thread.id, input: [{type: "text", text: "Second diagnostic turn."}]});
    await until(() => notifications.some(x => x.method === "turn/completed" && x.params.turn.id === second.turn.id));
    const expected = mode === "current" ? [initialModel, targetModel, initialModel] : mode === "thread-only" ? [initialModel, initialModel, targetModel] : [initialModel, initialModel, initialModel];
    assert.deepEqual(requests.map(x => x.model), expected);
    const terminals = notifications.filter(x => x.method === "turn/completed").map(x => x.params.turn.status);
    assert.deepEqual(terminals, ["completed", "completed"]);
    if (mode === "current") assert.deepEqual(update, {status: "applied"});
    if (effortOnly) {
      assert.deepEqual(update, {status: "applied"});
      assert.deepEqual(requests.map(request => request.effort), ["low", "high", "low"]);
    }
    if (mode === "flag-off") assert.match(update.error.message, /step_model_switching/);
    if (mode === "unsafe-destination") assert.match(update.error.message, /node REPL availability/);
    if (realPair) assert.match(update.error.message, /node REPL review requirement/);
    assert.equal(notifications.filter(x => x.method === "turn/started").length, 2);
    return {mode, update, guards, requests, terminals, interruptionCount: terminals.filter(x => x === "interrupted").length, inference: "scripted loopback only"};
  } finally {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited; clearTimeout(killTimer);
    lines.close(); http.closeAllConnections();
    await new Promise(resolveClose => http.close(resolveClose));
  }
}

for (const mode of ["current", "thread-only", "flag-off", "unsafe-destination", "sol-to-astra", "astra-to-sol", "sol-effort-only"]) console.log(JSON.stringify(await scenario(mode)));
