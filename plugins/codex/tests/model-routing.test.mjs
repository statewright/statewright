import assert from "node:assert/strict";
import test from "node:test";
import {
  isStateBoundaryItem,
  normalizeCatalog,
  parseMcpJsonResult,
  resolveFallbackRoute,
  resolveStateRoute,
} from "../scripts/lib/model-routing.mjs";

const catalog = normalizeCatalog([
  {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
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
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
    ],
    isDefault: false,
    hidden: false,
  },
]);

test("fallback family aliases resolve against the live catalog", () => {
  assert.deepEqual(resolveFallbackRoute(catalog, "luna", "low"), {
    model: "gpt-5.6-luna",
    effort: "low",
    requestedModel: "luna",
    requestedEffort: "low",
    source: "configured-fallback",
  });
});
test("provider-qualified state models and explicit effort resolve strictly", () => {
  const route = resolveStateRoute(
    {
      state: "discover",
      model: "openai-codex/gpt-5.6-sol",
      thinking_level: "max",
    },
    catalog,
    resolveFallbackRoute(catalog, "luna", "medium"),
  );
  assert.equal(route.model, "gpt-5.6-sol");
  assert.equal(route.effort, "max");
  assert.equal(route.source, "state");
});

test("unrouted states inherit the active route", () => {
  const current = resolveFallbackRoute(catalog, "luna", "medium");
  const route = resolveStateRoute({ state: "build", model: null }, catalog, current);
  assert.equal(route.model, "gpt-5.6-luna");
  assert.equal(route.effort, "medium");
  assert.equal(route.source, "inherited");
});

test("unknown state models fail closed", () => {
  assert.throws(
    () =>
      resolveStateRoute(
        { state: "build", model: "openai-codex/not-real", thinking_level: "low" },
        catalog,
        resolveFallbackRoute(catalog),
      ),
    /not in the live Codex model catalog/,
  );
});

test("unsupported explicit efforts fail closed", () => {
  assert.throws(
    () =>
      resolveStateRoute(
        { state: "build", model: "openai-codex/gpt-5.6-luna", thinking_level: "max" },
        catalog,
        resolveFallbackRoute(catalog),
      ),
    /only advertises: low, medium/,
  );
});

test("completed Statewright transition calls are hard boundaries", () => {
  assert.equal(
    isStateBoundaryItem(
      {
        type: "mcpToolCall",
        server: "statewright",
        tool: "mcp__statewright__statewright_transition",
        status: "completed",
        result: { content: [] },
      },
      "statewright",
    ),
    true,
  );
  assert.equal(
    isStateBoundaryItem(
      {
        type: "mcpToolCall",
        server: "statewright",
        tool: "statewright_transition",
        status: "failed",
      },
      "statewright",
    ),
    false,
  );
});

test("Statewright text results parse as JSON", () => {
  assert.deepEqual(
    parseMcpJsonResult({ content: [{ type: "text", text: '{"state":"build"}' }] }),
    { state: "build" },
  );
});
