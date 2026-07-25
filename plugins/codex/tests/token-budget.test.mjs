import assert from "node:assert/strict";
import test from "node:test";
import { StateBudgetLedger, tokenUsageDelta, toolItemSummary } from "../scripts/lib/token-budget.mjs";

test("token usage is accumulated from snapshots without double counting", () => {
  assert.deepEqual(
    tokenUsageDelta({ totalTokens: 10, inputTokens: 8 }, { totalTokens: 15, inputTokens: 12, outputTokens: 3 }),
    {
      input_tokens: 4,
      cached_input_tokens: 0,
      output_tokens: 3,
      reasoning_output_tokens: 0,
      total_tokens: 5,
    },
  );
});

test("the ledger tracks token and tool-output budgets per state", () => {
  const ledger = new StateBudgetLedger();
  const state = { state: "analyze", context_budget_bytes: 100 };
  ledger.enterState(state);
  ledger.observeTokenUsage("turn-1", { totalTokens: 10, inputTokens: 8, outputTokens: 2 }, state);
  ledger.observeTokenUsage("turn-1", { totalTokens: 15, inputTokens: 12, outputTokens: 3 }, state);
  const observed = ledger.observeToolItem(
    { type: "mcpToolCall", tool: "recover_report", result: { content: [{ text: "x".repeat(100) }] } },
    state,
  );

  assert.equal(observed.tool.tool, "recover_report");
  assert.ok(observed.tool.result_bytes >= 100);
  assert.ok(observed.tool.estimated_input_tokens >= 25);
  assert.equal(observed.ledger.token_usage.total_tokens, 15);
  assert.equal(observed.ledger.session_token_usage.total_tokens, 15);
  assert.equal(observed.ledger.token_attribution.provider_total_tokens, 15);
  assert.equal(
    observed.ledger.token_attribution.non_tool_tokens,
    Math.max(0, 15 - observed.ledger.estimated_tool_output_tokens),
  );
  assert.ok(observed.ledger.context_budget_percent >= 100);
  assert.equal(ledger.thresholdCrossed(state, 90), true);
  assert.equal(ledger.thresholdCrossed(state, 90), false);
  assert.equal(ledger.thresholdCrossed(state, 100), true);
});

test("tool summaries contain metadata and byte counts but not payload text", () => {
  const summary = toolItemSummary({
    type: "commandExecution",
    name: "exec_command",
    result: { output: "private output" },
  });
  assert.deepEqual(summary, {
    type: "commandExecution",
    tool: "exec_command",
    result_bytes: Buffer.byteLength(JSON.stringify({ output: "private output" }), "utf8"),
    estimated_input_tokens: Math.ceil(Buffer.byteLength(JSON.stringify({ output: "private output" }), "utf8") / 4),
  });
});
