import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DesktopNativeUsage, DesktopUsageRelay, projectDesktopUsage} from "../lib/desktop-native-usage.mjs";
import {LocalTelemetryService} from "../lib/local-telemetry-agent.mjs";
import {ManagedMcpBridge} from "../lib/managed-mcp-bridge.mjs";

const route = {run_id: "run", run_session_id: "session", state: "baseline", state_epoch: 3};
const settings = {model: "gpt-5.6-terra", modelProvider: "openai", effort: "medium"};
const counters = n => ({inputTokens: n - 10, cachedInputTokens: 5, outputTokens: 10,
  reasoningOutputTokens: 2, totalTokens: n});
function fixture() {
  const usage = new DesktopNativeUsage();
  usage.prepare("thread", route);
  usage.started({threadId: "thread", turn: {id: "turn"}}, settings);
  const params = {threadId: "thread", turnId: "turn", tokenUsage: {total: counters(1000), last: counters(100)}};
  return {usage, params};
}

test("native usage ignores replay, foreign turns and invalid counts; never bills historical totals", () => {
  const {usage, params} = fixture();
  assert.equal(usage.event({...params, threadId: "other"}), null);
  assert.equal(usage.event({...params, tokenUsage: {total: counters(1000), last: counters(-1)}}), null);
  const event = usage.event(params);
  assert.equal(event.token_usage_delta.total_tokens, 100);
  assert.equal(usage.event(params), null);
  assert.equal(usage.event({...params, tokenUsage: {total: counters(999), last: counters(100)}}), null);
  usage.prepare("thread", {...route, state: "validate", state_epoch: 4});
  const late = usage.event({...params, tokenUsage: {total: counters(1100), last: counters(100)}});
  assert.equal(late.binding.state, "baseline");
  assert.equal(late.effort, "medium");
  assert.equal(late.turn_id, "turn");
});

test("no-route, restoration and absent native settings do not fabricate execution evidence", () => {
  const {params} = fixture();
  for (const r of [null, {...route, restored_original: true}]) {
    const usage = new DesktopNativeUsage(); usage.prepare("thread", r);
    usage.started({threadId: "thread", turn: {id: "turn"}}, settings);
    assert.equal(usage.event(params), null);
  }
  const usage = new DesktopNativeUsage(); usage.prepare("thread", route);
  usage.started({threadId: "thread", turn: {id: "turn"}}, {});
  assert.equal(usage.event(params), null);
});

test("Desktop projection excludes raw content and validates correlation", () => {
  const {usage, params} = fixture(); const event = usage.event(params);
  const projected = projectDesktopUsage({...event, prompt: "SECRET", token: "SECRET",
    binding: {...event.binding, private: "SECRET"}});
  assert.ok(!JSON.stringify(projected).includes("SECRET"));
  assert.throws(() => projectDesktopUsage({...event, binding: {...event.binding, root_session_id: "foreign"}}));
  assert.throws(() => projectDesktopUsage({...event, token_usage_delta: {}}));
});

test("local relay survives receipt failure, restart, and a lost acknowledgement without double charge", async t => {
  const home = await mkdtemp(join(tmpdir(), "desktop-usage-relay-"));
  t.after(() => rm(home, {recursive: true, force: true}));
  const path = join(home, "relay.jsonl"), accepted = new Set();
  let attempt = 0;
  const deliver = async event => {
    if (++attempt === 1) throw new Error("bridge offline before receipt");
    accepted.add(event.event_id);
    if (attempt === 2) throw new Error("receipt persisted but acknowledgement lost");
  };
  const first = new DesktopUsageRelay({path, deliver, retryMs: 60_000});
  const {usage, params} = fixture(); const event = usage.event(params);
  first.append(event);
  while (first.flushing) await new Promise(r => setTimeout(r, 1));
  assert.equal(first.outbox.pendingCount(), 1); first.close();
  const reopened = new DesktopUsageRelay({path, deliver, retryMs: 5});
  t.after(() => reopened.close());
  const deadline = Date.now() + 2_000;
  while (reopened.outbox.pendingCount() && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.equal(reopened.outbox.pendingCount(), 0);
  assert.equal(attempt, 3); assert.equal(accepted.size, 1);
  reopened.append(event);
  assert.equal(attempt, 3);
});

test("authenticated Desktop event reaches durable and live reports with dedupe and outage recovery", async t => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-usage-"));
  t.after(() => rm(home, {recursive: true, force: true}));
  const requests = []; let online = false;
  const service = new LocalTelemetryService({dataDir: home, pocketbaseUrl: "https://site.test",
    gatewayUrl: "https://gateway.test", apiKey: "secret-key", fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); requests.push({url, body});
      if (!online) return new Response("offline", {status: 503});
      if (url.endsWith("/api/runtime-usage")) return new Response(null, {status: 204});
      return Response.json({accepted_event_ids: body.events.map(e => e.event_id)});
    }});
  const bridge = await new ManagedMcpBridge({gatewayUrl: "https://gateway.test/mcp", apiKey: "secret-key",
    clientId: "lane", token: "local-token", nativeUsage: service, projectUsage: projectDesktopUsage}).start();
  t.after(() => bridge.close());
  const {usage, params} = fixture(); const event = usage.event(params);
  const post = (body, headers = {}) => fetch(`${bridge.url}/native-usage`, {method: "POST",
    headers: {Authorization: "Bearer local-token", "X-Statewright-Client-Id": "lane", ...headers}, body: JSON.stringify(body)});
  assert.equal((await post(event, {Authorization: "Bearer foreign"})).status, 401);
  assert.equal((await post(event, {"X-Statewright-Client-Id": "other"})).status, 403);
  assert.equal((await post(event, {Origin: "https://foreign.test"})).status, 401);
  assert.equal((await post({...event, token_usage_delta: {}})).status, 400);
  assert.equal((await post({...event, prompt: "SECRET"})).status, 202);
  assert.equal((await post(event)).status, 202);
  // Finish the bounded failed upload; the event remains durable and retriable.
  for(let i=0;i<100 && (service.primaryFlushing || service.liveFlushing);i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(service.outbox.pendingCount(), 1);
  const stored = await readFile(service.outbox.path, "utf8");
  assert.ok(!stored.includes("SECRET")); assert.ok(!stored.includes("secret-key"));
  assert.ok(stored.includes('"turn_id":"turn"'));
  online = true; service.delivery.next_attempt_at = null; service.liveDelivery.next_attempt_at = null;
  await service.flush();
  assert.equal(service.outbox.pendingCount(), 0); assert.equal(service.liveUsageOutbox.pendingCount(), 0);
  const live = requests.filter(r => r.url.endsWith("/api/runtime-usage")).at(-1).body;
  assert.equal(live.run_id, "run"); assert.equal(live.run_session_id, "session");
  assert.equal(live.usage.state_epoch, 3); assert.equal(live.usage.model, settings.model);
  assert.equal(live.usage.effort, "medium"); assert.equal(live.usage.precision, "exact");
  assert.equal(live.usage.token_usage.total_tokens, 100);
  // Reopen the existing durable ledger: the same event must not double charge.
  const reopened = new LocalTelemetryService({dataDir: home, pocketbaseUrl: "https://site.test",
    gatewayUrl: "https://gateway.test", apiKey: "secret-key"});
  assert.equal(reopened.outbox.appendUsage(event, event.binding).duplicate, true);
});
