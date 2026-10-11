import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("managed hooks refresh route state through their authenticated bridge, never the direct gateway", async t => {
  const home = await mkdtemp(join(tmpdir(), "statewright-managed-hook-"));
  t.after(() => rm(home, {recursive: true, force: true}));
  const clientId = `swc_${"a".repeat(32)}`, threadId = "managed-hook-thread";
  const control = join(home, "routes");
  await mkdir(control);
  await writeFile(join(control, "identity.json"), JSON.stringify({version: 1, host: "codex", client_id: clientId}));
  await writeFile(join(control, "codex-root-session.json"), JSON.stringify({version: 1, client_id: clientId, session_id: threadId}));
  let state = {state: "intake", state_epoch: 1, run_id: "run", run_session_id: "session",
    model: "openai-codex/gpt-5.6-terra", thinking_level: "low", is_final: false,
    allowed_tools: ["Read"], transitions: [], transition_count: 0};
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const c of req) text += c;
    requests.push({url: req.url, authorization: req.headers.authorization, client: req.headers["x-statewright-client-id"]});
    const rpc = JSON.parse(text);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({jsonrpc: "2.0", id: rpc.id, result: {content: [{type: "text", text: JSON.stringify(state)}]}}));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(STATEWRIGHT_|CODEX_)/.test(key)) delete env[key];
  Object.assign(env, {HOME: home, STATEWRIGHT_CLIENT_ID: clientId, STATEWRIGHT_MANAGED_CLIENT_HOST: "codex",
    STATEWRIGHT_ROUTE_CONTROL_DIR: control, STATEWRIGHT_GATEWAY_URL: "http://127.0.0.1:1",
    STATEWRIGHT_API_KEY: "wrong-direct-key", STATEWRIGHT_MANAGED_MCP_URL: `http://127.0.0.1:${server.address().port}`,
    STATEWRIGHT_MANAGED_MCP_TOKEN: "bridge-only-token", STATEWRIGHT_NATIVE_TELEMETRY: "0"});
  const invoke = async (tool, response) => {
    const child = spawn("bash", [new URL("../hook.sh", import.meta.url).pathname, "post-tool"], {env});
    let output = ""; child.stdout.on("data", x => {output += x}); child.stderr.resume();
    child.stdin.end(JSON.stringify({thread_id: threadId, turn_id: "native-turn", tool_name: `mcp__statewright__${tool}`, tool_response: response}));
    const [code] = await once(child, "exit"); assert.equal(code, 0); return output;
  };
  const loaded = await invoke("statewright_load_workflow", {state_snapshot: state});
  assert.match(loaded, /Workflow loaded/, loaded);
  state = {...state, state: "review", state_epoch: 2, model: "openai-codex/gpt-6-astra", thinking_level: "high", transition_count: 1};
  const output = await invoke("statewright_transition", {transitioned: true, from: "intake", to: "review"});
  assert.match(output, /review/, JSON.stringify({output, requests}));
  const route = JSON.parse(await readFile(join(control, "current.route.json"), "utf8"));
  assert.equal(route.state, "review"); assert.equal(route.model, state.model);
  assert.ok(requests.length);
  assert.ok(requests.every(r => r.url === "/mcp" && r.authorization === "Bearer bridge-only-token" && r.client === clientId));
});
