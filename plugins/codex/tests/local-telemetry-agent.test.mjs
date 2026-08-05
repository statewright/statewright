import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BindingLedger,
  createLocalTelemetryServer,
  DurableOutbox,
  LocalTelemetryService,
  inspectCodexCustomToolRecords,
  normalizeOtlpLogs,
  telemetryIdentity,
} from "../scripts/lib/local-telemetry-agent.mjs";
import { StateBudgetLedger } from "../scripts/lib/token-budget.mjs";

function attribute(key, value) {
  const type = typeof value === "number" ? "intValue" : "stringValue";
  return { key, value: { [type]: String(value) } };
}

function otlpFixture({
  conversationId = "thread-root",
  sourceTime = "2026-07-27T12:00:00.000Z",
  timeUnixNano = "1785153600000000000",
  input = 70,
  cached = 20,
  cacheWrite = 3,
  output = 30,
  reasoning = 10,
  total = 100,
} = {}) {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          attribute("service.name", "codex-cli"),
          attribute("user.account_id", "must-not-persist"),
        ],
      },
      scopeLogs: [{
        scope: { name: "codex" },
        logRecords: [{
          timeUnixNano,
          body: { stringValue: "raw body must not persist" },
          attributes: [
            attribute("event.name", "codex.sse_event"),
            attribute("event.kind", "response.completed"),
            attribute("event.timestamp", sourceTime),
            attribute("conversation.id", conversationId),
            attribute("model", "gpt-5.6-terra"),
            attribute("model_reasoning_effort", "medium"),
            attribute("input_token_count", input),
            attribute("cached_token_count", cached),
            attribute("cache_write_token_count", cacheWrite),
            attribute("output_token_count", output),
            attribute("reasoning_token_count", reasoning),
            attribute("tool_token_count", total),
            attribute("prompt", "must-not-persist"),
          ],
        }],
      }],
    }],
  };
}

async function withTempDir(run) {
  const directory = mkdtempSync(join(tmpdir(), "statewright-telemetry-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("OTLP response.completed is normalized as an exact delta without raw fields", () => {
  const events = normalizeOtlpLogs(
    otlpFixture(),
    "2026-07-27T12:00:01.000Z",
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].token_usage_delta, {
    input_tokens: 70,
    cached_input_tokens: 20,
    cache_write_input_tokens: 3,
    output_tokens: 30,
    reasoning_output_tokens: 10,
    total_tokens: 100,
  });
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("must-not-persist"), false);
  assert.equal(serialized.includes("raw body"), false);
  assert.equal(events[0].precision, "exact");
});

test("Code Mode custom tool pairs normalize to a stable compact event", () => {
  const records = [
    { type: "response_item", timestamp: "2026-08-05T05:00:00.000Z", payload: {
      type: "custom_tool_call", call_id: "call-1", name: "exec", input: "tool input",
    } },
    { type: "response_item", timestamp: "2026-08-05T05:00:01.000Z", payload: {
      type: "custom_tool_call_output", call_id: "call-1", output: [{ type: "input_text", text: "tool output" }],
    } },
  ];
  const [event] = inspectCodexCustomToolRecords(records, "thread-root");
  assert.equal(event.invocation_id, "call-1");
  assert.equal(event.tool, "exec");
  assert.deepEqual(event.tool_input, { input: "tool input" });
  assert.equal(event.tool_output, "tool output");
  assert.equal(event.event_id, inspectCodexCustomToolRecords(records, "thread-root")[0].event_id);
});

test("Code Mode tool telemetry preserves raw output only for capture-enabled staging", async () => {
  await withTempDir(async (directory) => {
    const requests = [];
    const service = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.casa.enhasa.cloud",
      rawCaptureDestination: "https://statewright.casa.enhasa.cloud",
      apiKey: "local-secret",
      fetchImpl: async (url, request) => {
        requests.push({ url, request });
        return { ok: true, status: 202 };
      },
    });
    service.bind({
      conversation_id: "thread-root", run_id: "run-1", workflow: "workflow",
      state: "implement", state_epoch: 1, capture_output: true,
      effective_at: "2026-08-05T05:00:00.000Z",
    });
    const [event] = inspectCodexCustomToolRecords([
      { type: "response_item", timestamp: "2026-08-05T05:00:01.000Z", payload: {
        type: "custom_tool_call", call_id: "call-1", name: "exec", input: "tool input",
      } },
      { type: "response_item", timestamp: "2026-08-05T05:00:02.000Z", payload: {
        type: "custom_tool_call_output", call_id: "call-1", output: [{ type: "input_text", text: "tool output" }],
      } },
    ], "thread-root");
    assert.deepEqual(service.ingestCodexTool(event), { accepted: 1, raw_queued: 1, ignored: 0 });
    await service.flush();
    assert.deepEqual(requests.map(({ url }) => url), [
      "https://statewright.casa.enhasa.cloud/api/gateway/telemetry/events",
      "https://statewright.casa.enhasa.cloud/api/gateway/logs",
    ]);
    assert.equal(JSON.parse(requests[1].request.body).event_id, event.event_id);

    const production = new LocalTelemetryService({
      dataDir: join(directory, "production"),
      pocketbaseUrl: "https://statewright.ai",
      rawCaptureDestination: "https://statewright.ai",
      apiKey: "local-secret",
    });
    production.bind({
      conversation_id: "thread-root", run_id: "run-2", workflow: "workflow",
      state: "implement", state_epoch: 1, capture_output: true,
      effective_at: "2026-08-05T05:00:00.000Z",
    });
    assert.equal(production.ingestCodexTool(event).raw_queued, 0);
  });
});

test("persistent collector tails a bound Code Mode session exactly once", async () => {
  await withTempDir(async (directory) => {
    const sessions = join(directory, "sessions", "2026", "08", "05");
    mkdirSync(sessions, { recursive: true });
    const sessionPath = join(sessions, "rollout-test-thread-root.jsonl");
    writeFileSync(sessionPath, [
      JSON.stringify({ type: "response_item", timestamp: "2026-08-05T05:00:01.000Z", payload: {
        type: "custom_tool_call", call_id: "call-1", name: "exec", input: "tool input",
      } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-08-05T05:00:02.000Z", payload: {
        type: "custom_tool_call_output", call_id: "call-1", output: [{ type: "input_text", text: "tool output" }],
      } }),
      "",
    ].join("\n"));
    const requests = [];
    const service = new LocalTelemetryService({
      dataDir: directory,
      codexSessionsDir: join(directory, "sessions"),
      pocketbaseUrl: "https://statewright.casa.enhasa.cloud",
      rawCaptureDestination: "https://statewright.casa.enhasa.cloud",
      apiKey: "local-secret",
      fetchImpl: async (url, request) => {
        requests.push({ url, request });
        return { ok: true, status: 202 };
      },
    });
    service.bind({
      conversation_id: "thread-root", run_id: "run-1", workflow: "workflow",
      state: "implement", state_epoch: 1, capture_output: true,
      effective_at: "2026-08-05T05:00:00.000Z",
    });
    assert.equal((await service.maintain()).custom_tools, 1);
    assert.equal((await service.maintain()).custom_tools, 0);
    assert.equal(requests.length, 2);
  });
});

test("collector identity changes with credentials and endpoint configuration", () => {
  const original = telemetryIdentity({
    pocketbaseUrl: "https://statewright.invalid",
    apiKey: "key-one",
  });
  assert.equal(original.protocol_version, 1);
  assert.notEqual(
    original.config_identity,
    telemetryIdentity({
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "key-two",
    }).config_identity,
  );
  assert.notEqual(
    original.config_identity,
    telemetryIdentity({
      pocketbaseUrl: "https://staging.statewright.invalid",
      apiKey: "key-one",
    }).config_identity,
  );
});

test("OTLP delta and app-server cumulative usage normalize to equal totals", () => {
  const [native] = normalizeOtlpLogs(otlpFixture());
  const ledger = new StateBudgetLedger();
  const state = { state: "implement" };
  ledger.enterState(state);
  const observed = ledger.observeTokenUsage("turn-1", {
    total: {
      inputTokens: 70,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 3,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 100,
    },
  }, state);
  assert.deepEqual(observed.delta, native.token_usage_delta);
});

test("bindings resolve by source time and root transitions propagate to known children", async () => {
  await withTempDir((directory) => {
    const ledger = new BindingLedger(join(directory, "bindings.jsonl"));
    ledger.append({
      conversation_id: "thread-root",
      run_id: "run-1",
      workflow: "workflow",
      state: "implement",
      state_epoch: 1,
      effective_at: "2026-07-27T11:59:00.000Z",
    });
    ledger.append({
      conversation_id: "thread-child",
      root_session_id: "thread-root",
      run_id: "run-1",
      workflow: "workflow",
      state: "implement",
      state_epoch: 1,
      effective_at: "2026-07-27T11:59:10.000Z",
    });
    ledger.append({
      conversation_id: "thread-root",
      run_id: "run-1",
      workflow: "workflow",
      state: "validate",
      state_epoch: 2,
      effective_at: "2026-07-27T12:00:30.000Z",
      propagate_children: true,
    });

    assert.equal(
      ledger.resolve("thread-root", "2026-07-27T12:00:00.000Z").state,
      "implement",
    );
    assert.equal(
      ledger.resolve("thread-child", "2026-07-27T12:01:00.000Z").state,
      "validate",
    );
  });
});

test("outbox deduplicates, survives restart, and acknowledges only after delivery", async () => {
  await withTempDir(async (directory) => {
    const outboxPath = join(directory, "outbox.jsonl");
    const outbox = new DurableOutbox(outboxPath);
    const [normalized] = normalizeOtlpLogs(otlpFixture());
    const binding = {
      conversation_id: "thread-root",
      root_session_id: null,
      run_id: "run-1",
      workflow: "workflow",
      state: "implement",
      state_epoch: 1,
    };
    assert.equal(outbox.appendUsage(normalized, binding).duplicate, false);
    assert.equal(outbox.appendUsage(normalized, binding).duplicate, true);
    assert.equal(outbox.pending().length, 1);

    const restarted = new DurableOutbox(outboxPath);
    assert.equal(restarted.pending().length, 1);
    restarted.acknowledge(normalized.event_id);
    restarted.compact();
    const compacted = new DurableOutbox(outboxPath);
    assert.equal(compacted.pending().length, 0);
    assert.equal(compacted.appendUsage(normalized, binding).duplicate, true);

    const next = normalizeOtlpLogs(otlpFixture({
      timeUnixNano: "1785153601000000000",
      sourceTime: "2026-07-27T12:00:01.000Z",
      total: 5,
      input: 4,
      cached: 0,
      cacheWrite: 0,
      output: 1,
      reasoning: 0,
    }))[0];
    const appended = compacted.appendUsage(next, binding);
    assert.equal(appended.event.state_budget.token_usage.total_tokens, 105);
  });
});

test("service uploads bound events once and keeps provider data sanitized", async () => {
  await withTempDir(async (directory) => {
    const requests = [];
    const service = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "local-secret",
      correlationWindowMs: 0,
      fetchImpl: async (url, request) => {
        requests.push({ url, request });
        return { ok: true, status: 202 };
      },
    });
    service.bind({
      conversation_id: "thread-root",
      run_id: "run-1",
      workflow: "workflow",
      state: "implement",
      state_epoch: 1,
      effective_at: "2026-07-27T11:59:00.000Z",
    });
    assert.deepEqual(service.ingestOtlp(otlpFixture()), {
      accepted: 1,
      buffered: 0,
      duplicate: 0,
      ignored: 0,
      protocol_errors: 0,
    });
    assert.deepEqual(service.ingestOtlp(otlpFixture()), {
      accepted: 0,
      buffered: 0,
      duplicate: 1,
      ignored: 0,
      protocol_errors: 0,
    });
    assert.deepEqual(await service.flush(), { delivered: 1, pending: 0 });
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].request.body);
    assert.equal(payload.events[0].binding_status, "bound");
    assert.equal(payload.events[0].state_budget.token_usage.total_tokens, 100);
    assert.equal(payload.events[0].token_usage_delta.total_tokens, 100);

    const durable = readFileSync(join(directory, "outbox.jsonl"), "utf8");
    assert.equal(durable.includes("must-not-persist"), false);
    assert.equal(durable.includes("raw body"), false);
    assert.equal(durable.includes("local-secret"), false);
  });
});

test("pre-binding usage is durable and reconciles when workflow identity arrives", async () => {
  await withTempDir((directory) => {
    const service = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "secret",
      correlationWindowMs: 0,
    });
    assert.deepEqual(service.ingestOtlp(otlpFixture()), {
      accepted: 1,
      buffered: 1,
      duplicate: 0,
      ignored: 0,
      protocol_errors: 0,
    });
    assert.equal(service.outbox.pending().length, 0);
    assert.equal(service.pendingBindings.pending().length, 1);

    const restarted = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "secret",
      correlationWindowMs: 0,
    });
    assert.equal(restarted.pendingBindings.pending().length, 1);
    const binding = restarted.bind({
      conversation_id: "thread-root",
      run_id: "run-1",
      run_session_id: "gateway-session-1",
      workflow: "workflow",
      state: "implement",
      state_epoch: 1,
      effective_at: "2026-07-27T11:59:00.000Z",
    });
    assert.equal(binding.reconciled, 1);
    assert.equal(restarted.pendingBindings.pending().length, 0);
    const [event] = restarted.outbox.pending();
    assert.equal(event.binding_status, "bound");
    assert.equal(event.run_id, "run-1");
    assert.equal(event.run_session_id, "gateway-session-1");
    assert.equal(event.state_budget.token_usage.total_tokens, 100);

    const afterReconcile = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "secret",
      correlationWindowMs: 0,
    });
    assert.equal(afterReconcile.pendingBindings.pending().length, 0);
    assert.deepEqual(afterReconcile.ingestOtlp(otlpFixture()), {
      accepted: 0,
      buffered: 0,
      duplicate: 1,
      ignored: 0,
      protocol_errors: 0,
    });
  });
});

test("binding CLI durably records a boundary while the receiver is unavailable", async () => {
  await withTempDir((directory) => {
    const script = fileURLToPath(
      new URL("../scripts/local-telemetry-agent.mjs", import.meta.url),
    );
    const binding = {
      conversation_id: "thread-root",
      run_id: "run-1",
      workflow: "workflow",
      state: "implement",
      state_epoch: 1,
      effective_at: "2026-07-27T11:59:00.000Z",
    };
    const output = execFileSync(process.execPath, [script, "--bind-stdin"], {
      env: { ...process.env, STATEWRIGHT_TELEMETRY_DIR: directory },
      input: JSON.stringify(binding),
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output), { accepted: 1 });
    assert.equal(
      new BindingLedger(join(directory, "bindings.jsonl"))
        .resolve("thread-root", "2026-07-27T12:00:00.000Z")
        .state,
      "implement",
    );
  });
});

test("live receiver refreshes a binding appended through the fallback CLI", async () => {
  await withTempDir((directory) => {
    const service = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "secret",
      correlationWindowMs: 0,
    });
    service.ingestOtlp(otlpFixture());
    const script = fileURLToPath(
      new URL("../scripts/local-telemetry-agent.mjs", import.meta.url),
    );
    execFileSync(process.execPath, [script, "--bind-stdin"], {
      env: { ...process.env, STATEWRIGHT_TELEMETRY_DIR: directory },
      input: JSON.stringify({
        conversation_id: "thread-root",
        run_id: "run-1",
        workflow: "workflow",
        state: "implement",
        state_epoch: 1,
        effective_at: "2026-07-27T11:59:00.000Z",
      }),
    });
    assert.equal(service.reconcilePendingBindings(), 1);
    assert.equal(service.outbox.pending()[0].state, "implement");
  });
});

test("known sessions without a matching source-time interval stay explicitly unbound", async () => {
  await withTempDir((directory) => {
    const service = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "secret",
      correlationWindowMs: 0,
    });
    service.bind({
      conversation_id: "thread-root",
      run_id: "run-1",
      workflow: "workflow",
      state: "implement",
      state_epoch: 1,
      effective_at: "2026-07-27T12:01:00.000Z",
    });
    const result = service.ingestOtlp(otlpFixture());
    assert.equal(result.accepted, 1);
    assert.equal(result.buffered, 0);
    const [event] = service.outbox.pending();
    assert.equal(event.binding_status, "unbound");
    assert.equal(event.state_budget, null);
    assert.equal(event.run_id, "run-1");
  });
});

test("correlation window waits for a delayed boundary before state attribution", async () => {
  await withTempDir((directory) => {
    const service = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "secret",
      correlationWindowMs: 60_000,
    });
    service.bind({
      conversation_id: "thread-root",
      run_id: "run-1",
      workflow: "workflow",
      state: "characterize",
      state_epoch: 1,
      effective_at: "2026-07-27T11:00:00.000Z",
    });
    const receivedAt = new Date().toISOString();
    const result = service.ingestOtlp(otlpFixture(), receivedAt);
    assert.equal(result.buffered, 1);
    assert.equal(service.outbox.pending().length, 0);

    service.bind({
      conversation_id: "thread-root",
      run_id: "run-1",
      workflow: "workflow",
      state: "implement",
      state_epoch: 2,
      effective_at: "2026-07-27T11:59:30.000Z",
    });
    assert.equal(service.reconcilePendingBindings(Date.now() + 61_000), 1);
    const [event] = service.outbox.pending();
    assert.equal(event.state, "implement");
    assert.equal(event.state_budget.state_epoch, 2);
  });
});

test("schema drift and ignored records are observable in receiver health", async () => {
  await withTempDir((directory) => {
    const service = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "secret",
      correlationWindowMs: 0,
    });
    const malformed = otlpFixture({
      input: 0,
      cached: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: 0,
    });
    assert.equal(service.ingestOtlp(malformed).protocol_errors, 1);
    assert.equal(service.receiver.protocol_errors, 1);
    assert.match(service.receiver.last_protocol_error, /missing token usage/);

    const ignored = structuredClone(otlpFixture());
    ignored.resourceLogs[0].scopeLogs[0].logRecords[0].attributes[1] =
      attribute("event.kind", "response.started");
    assert.equal(service.ingestOtlp(ignored).ignored, 1);
    assert.equal(service.receiver.ignored, 1);
    assert.equal(typeof service.receiver.last_received_at, "string");
    assert.equal(service.ingestOtlp({}).protocol_errors, 1);
    assert.match(service.receiver.last_protocol_error, /no log records/);
  });
});

test("never-bound records are queryable locally and retention bounded", async () => {
  await withTempDir((directory) => {
    const service = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "secret",
      correlationWindowMs: 0,
      unboundRetentionMs: 60_000,
      maxUnboundRecords: 1,
    });
    service.ingestOtlp(otlpFixture({ conversationId: "unknown-one" }));
    service.ingestOtlp(otlpFixture({
      conversationId: "unknown-two",
      timeUnixNano: "1785153601000000000",
      sourceTime: "2026-07-27T12:00:01.000Z",
    }));
    const unbound = service.pendingBindings.unbound();
    assert.equal(unbound.length, 1);
    assert.equal(unbound[0].conversation_id, "unknown-two");
    assert.equal(unbound[0].binding_status, "unbound");
    assert.equal(unbound[0].token_usage_delta.total_tokens, 100);
    const durable = readFileSync(join(directory, "pending-bindings.jsonl"), "utf8");
    assert.equal(durable.includes("unknown-one"), false);
    assert.equal(durable.includes("unknown-two"), true);

    const restarted = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "secret",
      correlationWindowMs: 0,
      unboundRetentionMs: 60_000,
      maxUnboundRecords: 1,
    });
    assert.equal(restarted.pendingBindings.unbound().length, 1);
    assert.equal(restarted.pendingBindings.unbound()[0].conversation_id, "unknown-two");
  });
});

test("expired unbound records are physically removed from the ledger", async () => {
  await withTempDir((directory) => {
    const service = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "secret",
      correlationWindowMs: 0,
      unboundRetentionMs: 1,
    });
    service.ingestOtlp(
      otlpFixture({ conversationId: "expired-thread" }),
      "2026-07-27T12:00:10.000Z",
    );
    assert.equal(service.pendingBindings.pending().length, 0);
    const durable = readFileSync(join(directory, "pending-bindings.jsonl"), "utf8");
    assert.equal(durable.includes("expired-thread"), false);
  });
});

test("transport failures retain events and degrade delivery without rejecting", async () => {
  await withTempDir(async (directory) => {
    let shouldFail = true;
    const service = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "secret",
      correlationWindowMs: 0,
      fetchImpl: async () => {
        if (shouldFail) throw new Error("network unavailable");
        return { ok: true, status: 202 };
      },
    });
    service.bind({
      conversation_id: "thread-root",
      run_id: "run-1",
      workflow: "workflow",
      state: "implement",
      state_epoch: 1,
      effective_at: "2026-07-27T11:59:00.000Z",
    });
    service.ingestOtlp(otlpFixture());

    assert.deepEqual(await service.flush(), { delivered: 0, pending: 1 });
    assert.equal(service.delivery.status, "degraded");
    assert.match(service.delivery.last_error, /network unavailable/);
    assert.deepEqual(await service.flush(), {
      delivered: 0,
      pending: 1,
      deferred: true,
    });

    shouldFail = false;
    service.delivery.next_attempt_at = null;
    assert.deepEqual(await service.flush(), { delivered: 1, pending: 0 });
    assert.equal(service.delivery.status, "healthy");
  });
});

test("loopback OTLP endpoint durably appends before acknowledging", async () => {
  await withTempDir(async (directory) => {
    const service = new LocalTelemetryService({
      dataDir: directory,
      pocketbaseUrl: "https://statewright.invalid",
      apiKey: "secret",
      correlationWindowMs: 0,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    const listener = createLocalTelemetryServer(service, {
      host: "127.0.0.1",
      port: 0,
      flushIntervalMs: 60_000,
    });
    const address = await listener.listen();
    try {
      const base = `http://127.0.0.1:${address.port}`;
      const bindingResponse = await fetch(`${base}/v1/state-bindings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: "thread-root",
          run_id: "run-1",
          workflow: "workflow",
          state: "implement",
          state_epoch: 1,
          effective_at: "2026-07-27T11:59:00.000Z",
        }),
      });
      assert.equal(bindingResponse.status, 202);
      const healthResponse = await fetch(`${base}/health`);
      const health = await healthResponse.json();
      assert.equal(health.listener_status, "healthy");
      assert.equal(health.protocol_version, 1);
      assert.equal(typeof health.config_identity, "string");
      const usageResponse = await fetch(`${base}/v1/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(otlpFixture()),
      });
      assert.equal(usageResponse.status, 200);
      const durable = readFileSync(join(directory, "outbox.jsonl"), "utf8");
      assert.equal(durable.includes('"kind":"event"'), true);
      assert.equal(durable.includes('"total_tokens":100'), true);
    } finally {
      await listener.close();
    }
  });
});
