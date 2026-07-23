import assert from "node:assert/strict";
import test from "node:test";
import { scrubTelemetryFields } from "../scripts/lib/telemetry.mjs";

test("routing telemetry recursively removes prompt-bearing fields", () => {
  const record = scrubTelemetryFields({
    event: "turn_started",
    prompt: "private task",
    route: { model: "gpt-5.6-luna", effort: "medium" },
    tool: {
      arguments: { secret: "value" },
      content: [{ text: "private tool output" }],
    },
    token_usage: { inputTokens: 12, outputTokens: 3 },
  });

  assert.deepEqual(record, {
    event: "turn_started",
    route: { model: "gpt-5.6-luna", effort: "medium" },
    tool: {},
    token_usage: { inputTokens: 12, outputTokens: 3 },
  });
});
