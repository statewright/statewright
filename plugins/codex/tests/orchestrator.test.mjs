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
    this.currentTurnId = null;
    this.stateIndex = -1;
    this.states = [
      {
        state: "discover",
        is_final: false,
        model: "openai-codex/gpt-5.6-sol",
        thinking_level: "max",
      },
      {
        state: "build",
        is_final: false,
        model: "openai-codex/gpt-5.6-luna",
        thinking_level: "medium",
      },
      {
        state: "done",
        is_final: true,
        model: null,
        thinking_level: null,
      },
    ];
  }

  async start() {}
  notify() {}
  respond() {}
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
            name: "statewright",
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
        const tool = number === 1 ? "statewright_load_workflow" : "statewright_transition";
        this.stateIndex += 1;
        this.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId,
            item: {
              type: "mcpToolCall",
              server: "statewright",
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
    transportSessionId: "br_codex_test",
    stdout,
    stderr,
  });

  const result = await orchestrator.run();

  assert.equal(result.status, "complete");
  assert.equal(client.turns.length, 3);
  assert.deepEqual(
    client.turns.map(({ model, effort }) => ({ model, effort })),
    [
      { model: "gpt-5.6-luna", effort: "medium" },
      { model: "gpt-5.6-sol", effort: "max" },
      { model: "gpt-5.6-luna", effort: "medium" },
    ],
  );
  assert.equal(telemetry.filter((entry) => entry.event === "state_boundary").length, 3);
  assert.equal(
    telemetry.find((entry) => entry.event === "session_started")?.mcp_session_id,
    "br_codex_test",
  );
  assert.equal(JSON.stringify(telemetry).includes("Implement the approved plan."), false);
  assert.match(
    client.turns[0].input[0].text,
    /"name":"rugged-sdlc","session_id":"thread-1"/,
  );
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

  const prompt = orchestrator.bootstrapPrompt();
  assert.match(prompt, /"project_id":"magent-project"/);
  assert.doesNotMatch(prompt, /"session_id"/);
});
