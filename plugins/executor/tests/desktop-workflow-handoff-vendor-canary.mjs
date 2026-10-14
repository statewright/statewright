import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, copyFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startCodexAppServerRuntime } from "../lib/codex-app-server-transport.mjs";

// Explicit opt-in: four short real model turns against the signed-in bundled
// native binary, with a disposable workflow/MCP fixture. No live gateway run,
// user thread, plugin install, Desktop process or persistent config is changed.
if (process.env.STATEWRIGHT_HANDOFF_CANARY !== "1") {
  console.log("SKIP: STATEWRIGHT_HANDOFF_CANARY=1 enables real native handoff inference.");
  process.exit(0);
}
const home = await mkdtemp(join(tmpdir(), "statewright-native-handoff-"));
// Optional fifth turn covers a starter phase that deliberately inherits the
// selected model, before the existing explicit model-routing/restoration test.
const inheritedPhase = process.env.STATEWRIGHT_HANDOFF_CANARY_INHERIT === "1";
const codexHome = join(home, ".codex");
const clientId = "swc_0123456789abcdef0123456789abcdef";
let runtime, socket, threadId, state = null, sequence = 0;
const frames = [], telemetry = [], errors = [];
const makeState = (name, epoch, model, effort, is_final = false) => ({
  state: name, state_epoch: epoch, run_id: "isolated-handoff-canary", run_session_id: "isolated-session",
  is_final, model, thinking_level: effort, env_overrides: {STATEWRIGHT_CODEX_SERVICE_TIER: "priority"},
  instructions: is_final ? "Reply CANARY_COMPLETE. Do not call more tools."
    : "Call statewright_transition once to advance this fixture. Do not use any other tools except statewright_get_state.",
  allowed_tools: ["statewright_get_state", "statewright_transition"], transitions: [{event: "NEXT"}],
});
const mcp = createServer(async (req, res) => {
  if (req.method !== "POST") {res.writeHead(405).end(); return;}
  let body = ""; for await (const chunk of req) body += chunk;
  const r = JSON.parse(body);
  if (r.id === undefined) {res.writeHead(202).end(); return;}
  let result;
  if (r.method === "initialize") result = {protocolVersion: "2024-11-05", capabilities: {tools: {}}, serverInfo: {name: "statewright", version: "fixture"}};
  else if (r.method === "tools/list") result = {tools: [
    {name: "statewright_load_workflow", description: "Load the isolated model-routing test workflow. Call exactly once when asked to start the canary.", inputSchema: {type: "object", properties: {}}},
    {name: "statewright_get_state", description: "Read the current isolated workflow phase and follow its instructions.", inputSchema: {type: "object", properties: {}}},
    {name: "statewright_transition", description: "Advance the isolated workflow by one phase. Call only once per turn.", inputSchema: {type: "object", properties: {event: {type: "string"}}}},
  ]};
  else if (r.method === "tools/call") {
    let value;
    if (r.params.name === "statewright_load_workflow" && state === null) {
      state = inheritedPhase ? makeState("diagnose", 0, null, "low")
        : makeState("intake", 1, "openai-codex/gpt-5.6-terra", "low");
      value = {loaded: true, state_snapshot: state};
    } else if (r.params.name === "statewright_transition" && state && !state.is_final) {
      const from = state.state;
      state = state.state === "diagnose" ? makeState("intake", 1, "openai-codex/gpt-5.6-terra", "low")
        : state.state === "intake" ? makeState("review", 2, "openai-codex/gpt-6-astra", "high")
        : makeState("complete", 3, null, null, true);
      value = {transitioned: true, from, to: state.state};
    } else value = state;
    result = {content: [{type: "text", text: JSON.stringify(value)}], ...(value ? {structuredContent: value} : {})};
  } else result = {};
  res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({jsonrpc: "2.0", id: r.id, result}));
});
async function waitFor(check, label, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = check(); if (value) return value;
    if (errors.length) throw new Error(errors.at(-1));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Native canary timeout: ${label}`);
}
const rpc = async (method, params = {}) => {
  const id = ++sequence; socket.send(JSON.stringify({id, method, params}));
  const result = await waitFor(() => frames.find(f => f.id === id), method);
  if (result.error) throw new Error(`${method}: ${result.error.message}`);
  return result.result;
};
try {
  mcp.listen(0, "127.0.0.1"); await once(mcp, "listening");
  await mkdir(join(codexHome, "sessions"), {recursive: true});
  await copyFile(join(process.env.STATEWRIGHT_CANARY_AUTH_HOME ?? join(homedir(), ".codex"), "auth.json"), join(codexHome, "auth.json"));
  await writeFile(join(codexHome, "config.toml"), `model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n[mcp_servers.statewright]\nurl = "http://127.0.0.1:${mcp.address().port}/mcp"\n`);
  const environment = {...process.env, HOME: home, CODEX_HOME: codexHome};
  for (const key of Object.keys(environment)) if (/^(STATEWRIGHT_|CODEX_SESSION|CODEX_THREAD)/.test(key) || /API_KEY|AUTH_TOKEN/.test(key)) delete environment[key];
  environment.STATEWRIGHT_SENTRY_DISABLED = "true";
  runtime = await startCodexAppServerRuntime({
    command: process.env.STATEWRIGHT_DESKTOP_CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    environment, home, cwd: home, clientId,
    workflowService: {ownsThread: async id => id === threadId, getState: async () => state},
    routeOwner: async id => ({client_id: clientId, root_session_id: id === threadId ? id : null}),
    onThreadStarted: async ({threadId: id}) => {threadId = id;},
    requiredMcpToolSuffix: "statewright_get_state", requiredMcpReadyTimeoutMs: 15_000,
    telemetry: async (event, fields) => {telemetry.push({event, ...fields});},
    reporter: {async report() {}}, stderr: {write(text) {
      if (/workflow_handoff|terminal_route_restore/.test(String(text))) errors.push(String(text));
    }},
  });
  socket = new WebSocket(runtime.proxyUrl);
  socket.on("message", raw => {const f = JSON.parse(String(raw)); frames.push(f);
    if (f.method === "item/completed" && f.params?.item?.type === "mcpToolCall" && f.params.item.status === "failed") {
      errors.push("Native MCP fixture call was denied or failed; no permission override was attempted");
    }
    if (f.method === "warning" && /model handoff stopped/.test(f.params?.message ?? "")) errors.push(f.params.message);});
  await once(socket, "open");
  await rpc("initialize", {clientInfo: {name: "statewright-native-handoff-canary", version: "1"}, capabilities: {experimentalApi: true}});
  socket.send(JSON.stringify({method: "initialized"}));
  await rpc("thread/start", {model: "gpt-6-sol", approvalPolicy: "never", sandbox: "read-only",
    developerInstructions: "This is an isolated routing acceptance test. Use only the statewright MCP tools. Call one transition per turn, then reply briefly. Never use shell, files, browser or other tools."});
  await rpc("turn/start", {threadId, model: "gpt-6-sol", effort: "high",
    input: [{type: "text", text: "Start the canary by calling statewright_load_workflow once. Then stop; the Arbiter will start the next phase."}]});
  await waitFor(() => telemetry.find(r => r.event === "app_server_route_confirmed" && r.confirmed && r.route?.restored_original), "terminal restoration");
  assert.equal(state.state, "complete");
  const routed = telemetry.filter(r => r.event === "app_server_route_injected" && r.turnId);
  assert.deepEqual(routed.map(r => r.effectiveModel), [...(inheritedPhase ? ["gpt-6-sol"] : []), "gpt-5.6-terra", "gpt-6-astra"]);
  const baseline = await rpc("turn/start", {threadId, input: [{type: "text", text: "The workflow is complete. Reply exactly ROUTING_BASELINE_OK. No tools."}]});
  await waitFor(() => frames.find(f => f.method === "turn/completed" && f.params.turn?.id === baseline.turn.id), "baseline reply");
  const files = await readdir(join(codexHome, "sessions"), {recursive: true});
  const rollout = files.find(f => f.endsWith(`${threadId}.jsonl`)); assert.ok(rollout);
  const records = (await readFile(join(codexHome, "sessions", rollout), "utf8")).trim().split("\n").map(JSON.parse);
  const turns = records.filter(r => r.type === "turn_context").map(r => ({turnId: r.payload.turn_id, model: r.payload.model, effort: r.payload.effort}));
  assert.deepEqual(turns.map(r => r.model), ["gpt-6-sol", ...(inheritedPhase ? ["gpt-6-sol"] : []), "gpt-5.6-terra", "gpt-6-astra", "gpt-6-sol"]);
  assert.deepEqual(turns.map(r => r.effort), ["high", ...(inheritedPhase ? ["low"] : []), "low", "high", "high"]);
  console.log(JSON.stringify({status: "NATIVE_WORKFLOW_HANDOFF_PASS", threadId, turns, fixture: true, liveGateway: false}));
} catch (error) {
  console.error(JSON.stringify({status: "NATIVE_WORKFLOW_HANDOFF_NOT_PASSED", message: error.message, fixture: true}));
  throw error;
} finally {
  socket?.terminate();
  await runtime?.close();
  mcp.closeAllConnections();
  await new Promise(resolve => mcp.close(resolve));
  await rm(home, {recursive: true, force: true});
}
