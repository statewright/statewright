import assert from "node:assert/strict";
import test from "node:test";
import {
  statewrightToolSummary,
  summarizeStatewrightMcpResponse,
  summarizeStatewrightToolCompletion,
  summarizeStatewrightToolStart,
} from "../lib/statewright-tool-summary.mjs";

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
    transitioned: true, from: "validate", to: "record", transition_count: 7,
    usage: { transitions: 7, limit: 2500, remaining: 2493 },
  }).params.item), "validate → record · transitioned · 7/2500 transitions · 2493 remaining");
  assert.equal(statewrightToolSummary(completion("statewright_transition", {
    status: "pending_approval", from: "human_decision", to: "sync_tasks",
  }).params.item), "human_decision → sync_tasks · approval pending");
});

test("native MCP transition response becomes a concise line without losing machine-readable state", () => {
  const value = { transitioned: true, from: "baseline", to: "implement", transition_count: 2,
    usage: { transitions: 2, limit: 2500, remaining: 2498 } };
  const raw = { jsonrpc: "2.0", id: 17, result: { content: [{ type: "text", text: JSON.stringify(value) }] } };
  const summarized = summarizeStatewrightMcpResponse("statewright_transition", raw);
  assert.equal(summarized.result.content[0].text,
    "Statewright supervisor: baseline → implement · transitioned · 2/2500 transitions · 2498 remaining");
  assert.deepEqual(summarized.result.structuredContent, value);
  assert.equal(raw.result.structuredContent, undefined, "upstream response is untouched");
});

test("native MCP formatter leaves failures, malformed payloads, and other tools untouched", () => {
  const failed = { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "details" }] } };
  const malformed = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "not json" }] } };
  const state = { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "{\"state\":\"baseline\"}" }] } };
  assert.equal(summarizeStatewrightMcpResponse("statewright_transition", failed), failed);
  assert.equal(summarizeStatewrightMcpResponse("statewright_transition", malformed), malformed);
  assert.equal(summarizeStatewrightMcpResponse("statewright_get_state", state), state);
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

test("capitalized native MCP event names are summarized", () => {
  const raw = completion("statewright_transition", { transitioned: true, from: "intake", to: "localize" });
  raw.params.item.type = "McpToolCall";
  assert.equal(statewrightToolSummary(raw.params.item), "intake → localize · transitioned");
});

test("transition starts become a bounded supervisor status without invocation JSON", () => {
  const raw = { method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: {
    id: "transition-1", type: "mcpToolCall", server: "statewright", tool: "statewright_transition",
    arguments: { event: "IMPLEMENTED", data: { rationale: "private path / token must never reach the UI" } },
  } } };
  const summarized = summarizeStatewrightToolStart(raw);
  assert.notEqual(summarized, raw);
  assert.deepEqual(summarized.params.item, {
    id: "transition-1", type: "agentMessage", phase: "commentary",
    text: "Statewright supervisor: transition requested",
  });
  assert.match(JSON.stringify(raw), /private path/, "upstream notification is untouched");
  assert.doesNotMatch(JSON.stringify(summarized), /IMPLEMENTED|rationale|private path|token/);
});

test("foreign and user-facing Statewright search starts are never rewritten", () => {
  const foreign = { method: "item/started", params: { item: {
    id: "foreign", type: "mcpToolCall", server: "foreign", tool: "statewright_transition", arguments: { event: "KEEP" },
  } } };
  const search = { method: "item/started", params: { item: {
    id: "search", type: "mcpToolCall", server: "statewright", tool: "statewright_search_references", arguments: { query: "keep" },
  } } };
  assert.equal(summarizeStatewrightToolStart(foreign), foreign);
  assert.equal(summarizeStatewrightToolStart(search), search);
});
