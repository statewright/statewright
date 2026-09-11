import assert from "node:assert/strict";
import test from "node:test";
import { providerModel, selectAvailableRoute, selectRouteForProvider } from "../lib/model-ladder.mjs";

const request = {
  session_id: "thread-1",
  model: "local_compatible/local-code-model",
  effort: "medium",
  model_ladder: [
    {
      model: "local_compatible/local-code-model",
      thinking_level: "low",
      health_url: "https://model.example.invalid/health",
    },
    { model: "openai-codex/gpt-5.6-luna", thinking_level: "low" },
  ],
};

test("provider-qualified models retain the native model id and normalize OpenAI aliases", () => {
  assert.deepEqual(providerModel("local_compatible/local-code-model"), {
    provider: "local_compatible",
    model: "local-code-model",
  });
  assert.deepEqual(providerModel("openai-codex/gpt-5.6-luna"), {
    provider: "openai",
    model: "gpt-5.6-luna",
  });
});

test("persistent transport selects the equivalent route for its active provider", () => {
  assert.equal(selectRouteForProvider(request, "local_compatible").model, "local_compatible/local-code-model");
  assert.equal(selectRouteForProvider(request, "openai").model, "openai-codex/gpt-5.6-luna");
  assert.throws(() => selectRouteForProvider(request, "another-provider"), /no route for active Codex thread provider/);
});

test("persistent transport refuses a required cross-provider route instead of silently using its fallback", () => {
  assert.throws(
    () => selectRouteForProvider({
      ...request,
      model_ladder: [
        { model: "local_compatible/local-code-model", health_url: "https://model.example.invalid/health", requires_provider_switch: true },
        { model: "openai-codex/gpt-5.6-luna" },
      ],
    }, "openai"),
    /requires a cross-provider switch.*refusing to silently substitute/i,
  );
});

test("restart transport falls through an unhealthy local route to its cloud equivalent", async () => {
  const seen = [];
  const selected = await selectAvailableRoute(request, {
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: false };
    },
  });
  assert.deepEqual(seen, ["https://model.example.invalid/health"]);
  assert.equal(selected.model, "openai-codex/gpt-5.6-luna");
  assert.equal(selected.effort, "low");
});

test("restart transport keeps the first healthy route", async () => {
  const selected = await selectAvailableRoute(request, {
    fetchImpl: async () => ({ ok: true }),
  });
  assert.equal(selected.model, "local_compatible/local-code-model");
  assert.equal(selected.effort, "low");
});

test("ladder entries cannot replace managed session identity", async () => {
  const selected = await selectAvailableRoute({
    ...request,
    root_session_id: "thread-1",
    client_id: "client-1",
    model_ladder: [{
      model: "local_compatible/local-code-model",
      thinking_level: "low",
      session_id: "other-thread",
      root_session_id: "other-root",
      client_id: "other-client",
    }],
  });
  assert.equal(selected.session_id, "thread-1");
  assert.equal(selected.root_session_id, "thread-1");
  assert.equal(selected.client_id, "client-1");
});
