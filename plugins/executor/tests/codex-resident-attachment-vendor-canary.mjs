// Native transport acceptance without inference, credentials or user history.
// The local provider deliberately rejects generation AFTER turn/start accepts.
import assert from "node:assert/strict";
import {once} from "node:events";
import {createServer} from "node:http";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {WebSocket} from "ws";
import {startCodexAppServerRuntime} from "../lib/codex-app-server-transport.mjs";
import {residentThreadAuthorizer} from "../lib/codex-resident-thread-owner.mjs";
import {codexWorkflowServices} from "../lib/desktop-workflow-services.mjs";
import {readCodexRootSession} from "../lib/managed-client-identity.mjs";

if (!process.env.STATEWRIGHT_ATTACH_CANARY_BIN) {
  console.log("SKIP: set STATEWRIGHT_ATTACH_CANARY_BIN to the native Codex binary (not the shim).");
  process.exit(0);
}
const home = await mkdtemp(join(tmpdir(), "statewright-native-attachment-"));
const codexHome = join(home, ".codex");
let runtime, client, sequence = 0, providerRequests = 0;
const frames = [], errors = [], reports = [];
const provider = createServer((req, res) => {
  providerRequests++; req.resume();
  res.writeHead(400, {"Content-Type": "application/json"});
  res.end(JSON.stringify({error: {message: "Intentional offline canary: no inference", type: "invalid_request_error"}}));
});
async function until(check, label) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {const result = check(); if (result) return result; await new Promise(r => setTimeout(r, 20));}
  throw Error(`Timed out: ${label}; diagnostics=${errors.slice(-3).join(" ")}`);
}
async function rpc(method, params = {}) {
  const id = ++sequence; client.send(JSON.stringify({id, method, params}));
  const response = await until(() => frames.find(f => f.id === id), method);
  if (response.error) throw Error(`${method}: ${response.error.message}`);
  return response.result;
}
async function start() {
  const clientId = `swc_${randomUUID().replaceAll("-", "")}`;
  const controlDir = join(home, clientId); await mkdir(controlDir);
  const services = codexWorkflowServices({home, controlDir, clientId,
    ownsThread: async id => (await readCodexRootSession(controlDir, clientId))?.sessionId === id,
    getState: async () => null});
  // Allowlist, not inherited parent bridge/writer/user configuration.
  const environment = {PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome,
    TMPDIR: process.env.TMPDIR ?? tmpdir(), STATEWRIGHT_SENTRY_DISABLED: "true", STATEWRIGHT_QWEN_ENABLED: "false"};
  runtime = await startCodexAppServerRuntime({command: process.env.STATEWRIGHT_ATTACH_CANARY_BIN,
    home, cwd: home, environment, clientId, workflowService: services.workflowService,
    authorizeThread: residentThreadAuthorizer({home, cwd: home, controlDir, clientId}),
    reporter: {async report() {}, async reportFailure(reason, context) {reports.push({reason, context});}},
    stderr: {write(text) {if (/error|failed/i.test(text)) errors.push(String(text).slice(0, 300));}}});
  client = new WebSocket(runtime.proxyUrl);
  client.on("message", raw => frames.push(JSON.parse(String(raw))));
  await once(client, "open");
  await rpc("initialize", {clientInfo: {name: "statewright_attachment_canary", version: "1"}, capabilities: {experimentalApi: true}});
  client.send(JSON.stringify({method: "initialized"}));
  await assert.rejects(rpc("turn/start", {threadId: "unbound-fixture", input: []}), /Resume the conversation again/);
  return async id => assert.equal((await readCodexRootSession(controlDir, clientId))?.sessionId, id);
}
async function sendTurn(threadId) {
  const before = providerRequests;
  const result = await rpc("turn/start", {threadId, input: [{type: "text", text: "Offline protocol fixture; no inference."}]});
  assert.ok(result.turn.id, "native first-send acknowledgement");
  const completed = await until(() => frames.find(f => f.method === "turn/completed" && f.params?.turn?.id === result.turn.id), "offline provider completion");
  assert.equal(completed.params.turn.status, "failed", "fixture intentionally refuses inference");
  assert(providerRequests > before, "request reached only the local fixture provider");
}
try {
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  await mkdir(join(codexHome, "sessions"), {recursive: true});
  await writeFile(join(codexHome, "config.toml"), `model = "offline-fixture"\nmodel_provider = "attachment_fixture"\n[model_providers.attachment_fixture]\nname = "Offline attachment fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  let assertRoot = await start();
  const original = (await rpc("thread/start", {approvalPolicy: "never", sandbox: "read-only"})).thread.id;
  await assertRoot(original); await sendTurn(original);
  const fork = (await rpc("thread/fork", {threadId: original})).thread.id;
  assert.notEqual(fork, original); await assertRoot(fork); await sendTurn(fork);
  await rpc("thread/unsubscribe", {threadId: fork});
  await rpc("thread/unsubscribe", {threadId: original});
  client.terminate(); await runtime.close(); runtime = null;
  assertRoot = await start();
  const resumed = (await rpc("thread/resume", {threadId: fork})).thread.id;
  assert.equal(resumed, fork); await assertRoot(resumed); await sendTurn(resumed);
  assert.equal(reports.length, 2);
  assert(reports.every(r => r.reason === "session_unbound" && r.context.operation === "app_server_proxy"));
  console.log(JSON.stringify({status: "NATIVE_START_FORK_RESUME_FIRST_SEND_PASS", providerRequests,
    inference: false, liveGateway: false, userHistory: false, firstSendAcknowledgements: 3,
    recoverableOwnershipFailures: reports.length}));
} finally {
  client?.terminate(); await runtime?.close(); provider.closeAllConnections();
  await new Promise(r => provider.close(r)); await rm(home, {recursive: true, force: true});
}
