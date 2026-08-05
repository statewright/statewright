import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { StatewrightCodexOrchestrator } from "../scripts/lib/orchestrator.mjs";

class BufferWriter {
  constructor() {
    this.value = "";
  }

  write(value) {
    this.value += String(value);
  }
}

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.turns = [];
    this.runtimeUsageReports = [];
    this.workflowLoads = [];
    this.currentTurnId = null;
    this.stateIndex = -1;
    this.states = [
      {
        state: "discover",
        run_id: "run-1",
        run_session_id: "gateway-session-1",
        is_final: false,
        model: "openai-codex/gpt-5.6-sol",
        thinking_level: "max",
      },
      {
        state: "build",
        run_id: "run-1",
        run_session_id: "gateway-session-1",
        is_final: false,
        model: "openai-codex/gpt-5.6-luna",
        thinking_level: "medium",
      },
      {
        state: "done",
        run_id: "run-1",
        run_session_id: "gateway-session-1",
        is_final: true,
        model: null,
        thinking_level: null,
      },
    ];
  }

  async start() {}
  notify() {}
  respond(id, result) {
    this.responses ??= [];
    this.responses.push({ id, result });
  }
  respondError() {}

  async request(method, params = {}) {
    if (method === "initialize") return {};
    if (method === "model/list") {
      return {
        data: [
          {
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            displayName: "Sol",
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
              { reasoningEffort: "max" },
            ],
            isDefault: true,
            hidden: false,
          },
          {
            id: "gpt-5.6-luna",
            model: "gpt-5.6-luna",
            displayName: "Luna",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
            ],
            isDefault: false,
            hidden: false,
          },
        ],
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
      assert.equal(params.model, "gpt-5.6-luna");
      return { thread: { id: "thread-1", sessionId: "session-1" } };
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: [
          {
            name: "plugin_statewright_statewright",
            tools: {
              statewright_get_state: {},
              statewright_load_workflow: {},
              statewright_transition: {},
            },
          },
          {
            name: "statewright_adapter",
            tools: {
              statewright_get_state: {},
              statewright_load_workflow: {},
              statewright_transition: {},
            },
          },
        ],
        nextCursor: null,
      };
    }
    if (method === "mcpServer/tool/call") {
      assert.equal(params.server, "statewright_adapter");
      if (params.tool === "statewright_load_workflow") {
        this.workflowLoads.push(params.arguments);
        this.stateIndex = 0;
        return { content: [{ type: "text", text: "loaded" }] };
      }
      if (params.tool === "statewright_report_runtime_usage") {
        this.runtimeUsageReports.push(params.arguments);
        return { content: [{ type: "text", text: "ok" }] };
      }
      if (params.tool === "statewright_get_usage") {
        return { content: [{ type: "text", text: "[]" }] };
      }
      assert.equal(params.tool, "statewright_get_state");
      return {
        content: [{ type: "text", text: JSON.stringify(this.states[this.stateIndex]) }],
      };
    }
    if (method === "turn/start") {
      const number = this.turns.length + 1;
      const turnId = `turn-${number}`;
      this.currentTurnId = turnId;
      this.turns.push(params);
      queueMicrotask(() => {
        this.emit("notification", {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId,
            tokenUsage: { totalTokens: number * 10, inputTokens: number * 8, outputTokens: number * 2 },
          },
        });
        const tool = "statewright_transition";
        this.stateIndex += 1;
        this.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId,
            item: {
              type: "mcpToolCall",
              server: "statewright_adapter",
              tool,
              status: "completed",
              result: { content: [] },
            },
          },
        });
      });
      return { turn: { id: turnId } };
    }
    if (method === "turn/interrupt") {
      const turnId = params.turnId;
      queueMicrotask(() =>
        this.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: turnId, status: "interrupted", items: [] },
          },
        }),
      );
      return {};
    }
    throw new Error(`Unexpected fake request: ${method}`);
  }
}

test("the adapter cuts turns at state transitions and applies each state route", async () => {
  const client = new FakeClient();
  const telemetry = [];
  const nativeBindings = [];
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const orchestrator = new StatewrightCodexOrchestrator({
    client,
    workflow: "rugged-sdlc",
    prompt: "Implement the approved plan.",
    cwd: "/tmp/project",
    fallbackModel: "luna",
    fallbackEffort: "medium",
    telemetry: async (event, fields) => telemetry.push({ event, ...fields }),
    nativeOtelBinder: async (binding) => {
      nativeBindings.push(binding);
      return { status: "receiver" };
    },
    runtimeUsageControlToken: "test-control-token",
    transportSessionId: "br_codex_test",
    stdout,
    stderr,
  });

  const result = await orchestrator.run();

  assert.equal(result.status, "complete");
  assert.deepEqual(client.workflowLoads, [
    { name: "rugged-sdlc", session_id: "thread-1" },
  ]);
  assert.equal(client.turns.length, 2);
  assert.deepEqual(
    client.turns.map(({ model, effort }) => ({ model, effort })),
    [
      { model: "gpt-5.6-sol", effort: "max" },
      { model: "gpt-5.6-luna", effort: "medium" },
    ],
  );
  assert.equal(telemetry.filter((entry) => entry.event === "state_boundary").length, 3);
  assert.equal(telemetry.filter((entry) => entry.event === "state_budget_started").length, 2);
  assert.deepEqual(nativeBindings, [
    {
      conversation_id: "thread-1",
      root_session_id: "thread-1",
      run_id: "run-1",
      run_session_id: "gateway-session-1",
      workflow: "rugged-sdlc",
      state: "discover",
      state_epoch: 1,
      effective_at: nativeBindings[0].effective_at,
      capture_output: false,
    },
    {
      conversation_id: "thread-1",
      root_session_id: "thread-1",
      run_id: "run-1",
      run_session_id: "gateway-session-1",
      workflow: "rugged-sdlc",
      state: "build",
      state_epoch: 2,
      effective_at: nativeBindings[1].effective_at,
      capture_output: false,
    },
  ]);
  assert.ok(nativeBindings.every((binding) => !Number.isNaN(Date.parse(binding.effective_at))));
  assert.equal(
    telemetry.filter((entry) => entry.event === "native_otel_state_binding" && entry.status === "receiver").length,
    2,
  );
  const usage = telemetry.filter((entry) => entry.event === "token_usage");
  assert.equal(usage.length, 2);
  assert.equal(usage.at(-1).state_budget.session_token_usage.total_tokens, 30);
  assert.equal(client.runtimeUsageReports.length, 2);
  assert.equal(client.runtimeUsageReports[0].kind, "usage");
  assert.equal(client.runtimeUsageReports[0].report.precision, "exact");
  assert.equal(
    telemetry.find((entry) => entry.event === "session_started")?.mcp_session_id,
    "br_codex_test",
  );
  assert.equal(JSON.stringify(telemetry).includes("Implement the approved plan."), false);
  assert.match(client.turns[0].input[0].text, /Statewright has already activated this workflow/);
  assert.match(client.turns[0].input[0].text, /Implement the approved plan\./);
  assert.match(stderr.value, /state=discover model=gpt-5.6-sol effort=max/);
  assert.match(stderr.value, /workflow complete in 'done'/);
});

test("an explicit project scope replaces the legacy thread session argument", () => {
  const orchestrator = new StatewrightCodexOrchestrator({
    client: new FakeClient(),
    workflow: "[magent] desktop-android-pulse v1",
    prompt: "Continue.",
    cwd: "/tmp/project",
    projectId: "magent-project",
  });
  orchestrator.thread = { id: "thread-1" };

  const args = orchestrator.workflowArguments();
  assert.deepEqual(args, {
    name: "[magent] desktop-android-pulse v1",
    project_id: "magent-project",
  });
});
test("the never approval policy accepts MCP elicitation for bounded runs", async () => {
  const client = new FakeClient();
  const orchestrator = new StatewrightCodexOrchestrator({
    client,
    workflow: "smoke-readonly",
    prompt: "Read only.",
    cwd: "/tmp/project",
    approvalPolicy: "never",
  });

  await orchestrator.handleServerRequest({
    id: "elicitation-1",
    method: "mcpServer/elicitation/request",
  });

  assert.deepEqual(client.responses, [
    { id: "elicitation-1", result: { action: "accept" } },
  ]);
});

test("interactive approval policies decline MCP elicitation", async () => {
  const client = new FakeClient();
  const orchestrator = new StatewrightCodexOrchestrator({
    client,
    workflow: "smoke-readonly",
    prompt: "Read only.",
    cwd: "/tmp/project",
    approvalPolicy: "on-request",
  });

  await orchestrator.handleServerRequest({
    id: "elicitation-2",
    method: "mcpServer/elicitation/request",
  });

  assert.deepEqual(client.responses, [
    { id: "elicitation-2", result: { action: "decline" } },
  ]);
});

test("a required delivery workflow stops before task work without a delivery session", async () => {
  const client = new FakeClient();
  client.states[0].meta = {
    workspace: { required: true },
  };
  const orchestrator = new StatewrightCodexOrchestrator({
    client,
    workflow: "requires-preview",
    prompt: "Do not start this task.",
    cwd: "/tmp/project",
    fallbackModel: "luna",
    fallbackEffort: "medium",
    deliveryBootstrap: {
      enabled: false,
      expectedConfigPath: "/tmp/project/.statewright/delivery.json",
      docsPath: "plugins/codex/docs/isolated-delivery.md",
    },
    telemetry: async () => {},
    stdout: new BufferWriter(),
    stderr: new BufferWriter(),
  });

  await assert.rejects(
    orchestrator.run(),
    /requires isolated delivery.*[.]statewright[/]delivery[.]json.*isolated-delivery[.]md/,
  );
  assert.equal(client.turns.length, 0);
});
