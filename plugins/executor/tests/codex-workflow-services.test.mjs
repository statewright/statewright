import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, mkdir, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {codexWorkflowServices, desktopWorkflowServices} from "../lib/desktop-workflow-services.mjs";
import {claimCodexRootSession, writeManagedControlIdentity} from "../lib/managed-client-identity.mjs";
import {DesktopNativeUsage} from "../lib/desktop-native-usage.mjs";

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), "codex-workflow-services-"));
  t.after(() => rm(home, {recursive: true, force: true}));
  const controlDir = join(home, "routes"), clientId = `swc_${"a".repeat(32)}`, threadId = "owned-thread";
  await mkdir(controlDir);
  await writeManagedControlIdentity(controlDir, {host: "codex", clientId});
  await claimCodexRootSession(controlDir, {sessionId: threadId, clientId});
  return {home, controlDir, clientId, threadId};
}

test("TUI and Desktop share workflow ownership, including owner loss during state read", async t => {
  const f = await setup(t);
  assert.equal(codexWorkflowServices, desktopWorkflowServices);
  let owned = true, reads = 0, drop = false;
  const snapshot = {state: "intake", model: "openai-codex/gpt-5.6-terra"};
  const services = codexWorkflowServices({...f, ownsThread: async () => owned,
    getState: async () => { reads++; if (drop) owned = false; return snapshot; },
    peekRouteRequest: async (threadId, turnId) => ({threadId, turnId})});
  t.after(() => services.closeNativeUsage());
  assert.equal(await services.workflowService.ownsThread("foreign"), false);
  await assert.rejects(services.workflowService.getState("foreign"), /not owned/);
  assert.equal(reads, 0);
  assert.equal(await services.workflowService.getState(f.threadId), snapshot);
  assert.deepEqual(await services.peekRouteRequest(f.threadId, "turn"), {threadId: f.threadId, turnId: "turn"});
  drop = true;
  await assert.rejects(services.workflowService.getState(f.threadId), /owner changed/);
  assert.deepEqual(await services.routeOwner(f.threadId), {client_id: f.clientId, root_session_id: null});
});

test("TUI records exact owned native usage locally without a second ingestion stream", async t => {
  const f = await setup(t);
  const services = codexWorkflowServices({...f,
    ownsThread: async id => id === f.threadId, getState: async () => null});
  t.after(() => services.closeNativeUsage());
  const usage = new DesktopNativeUsage();
  usage.prepare(f.threadId, {run_id: "run", run_session_id: "gateway-session", state: "intake", state_epoch: 1});
  usage.started({threadId: f.threadId, turn: {id: "turn"}}, {model: "gpt-5.6-terra", modelProvider: "openai", effort: "low"});
  const counts = {inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 110};
  const event = usage.event({threadId: f.threadId, turnId: "turn", tokenUsage: {total: counts, last: counts}});
  const path = join(f.home, ".statewright", "telemetry", "codex-routing.jsonl");
  await services.onNativeUsage({...event, conversation_id: "foreign"});
  await assert.rejects(readFile(path), {code: "ENOENT"});
  await services.onNativeUsage({...event, prompt: "PRIVATE-CONTENT"});
  const pending = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].model, "gpt-5.6-terra");
  assert.equal(pending[0].turn_id, "turn");
  assert.ok(!JSON.stringify(pending).includes("PRIVATE-CONTENT"));
  assert.equal(pending[0].event, "app_server_native_usage");
  await assert.rejects(readFile(join(f.controlDir, "..", "native-usage-relay.jsonl")), {code: "ENOENT"});
});
