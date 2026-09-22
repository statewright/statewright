import assert from "node:assert/strict";
import test from "node:test";
import { statewrightToolSummary, summarizeStatewrightToolCompletion } from "../lib/statewright-tool-summary.mjs";

const completion = (tool, value, extra = {}) => ({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1",
  item: { id: "tool-1", type: "mcpToolCall", server: "statewright", tool, status: "completed",
    result: { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] }, ...extra } } });

test("get_state presentation is one bounded supervisor line without raw workflow JSON", () => {
  const raw = completion("statewright_get_state", { run_id: "run-secret", state: "baseline",
    model: "openai-codex/gpt-5.6-sol", thinking_level: "high",
    transitions: [{ event: "READY", target: "implement" }], allowed_tools: ["Read", "Bash"],
    instructions: "A deliberately verbose instruction that must not be copied downstream." });
  const summarized = summarizeStatewrightToolCompletion(raw);
  assert.notEqual(summarized, raw);
  assert.equal(summarized.params.item.result.content[0].text,
    "Statewright supervisor: baseline · gpt-5.6-sol / high · 1 transition");
  assert.equal(summarized.params.item.result.structuredContent, undefined);
  assert.deepEqual(raw.params.item.result.structuredContent.allowed_tools, ["Read", "Bash"], "upstream item is untouched");
});

test("transition and approval summaries state the actual movement", () => {
  assert.equal(statewrightToolSummary(completion("statewright_transition", {
    transitioned: true, from: "validate", to: "record",
  }).params.item), "validate → record · transitioned");
  assert.equal(statewrightToolSummary(completion("statewright_transition", {
    status: "pending_approval", from: "human_decision", to: "sync_tasks",
  }).params.item), "human_decision → sync_tasks · approval pending");
});

test("inactive and failed state calls remain concise while search results remain visible", () => {
  const inactive = completion("statewright_get_state", null);
  inactive.params.item.result = { isError: true, content: [{ type: "text", text: "No active workflow. Load a workflow before requesting state." }] };
  assert.equal(statewrightToolSummary(inactive.params.item), "no active workflow");
  const search = completion("statewright_search_docs", { results: [{ title: "Keep me" }] });
  assert.equal(summarizeStatewrightToolCompletion(search), search);
});

test("foreign MCP results are never rewritten", () => {
  const raw = completion("statewright_get_state", { state: "baseline" });
  raw.params.item.server = "foreign";
  assert.equal(summarizeStatewrightToolCompletion(raw), raw);
});
