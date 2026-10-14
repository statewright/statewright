import assert from "node:assert/strict";
import test from "node:test";
import {applyRouteToTurnStart, settingsConfirmRoute} from "../lib/codex-app-server-route-proxy.mjs";

const message = {method: "turn/start", params: {threadId: "own", input: [{type: "text", text: "continue"}]}};
const route = {session_id: "own", run_id: "run", state: "diagnose", model: null, effort: "medium"};
const native = {provider: "openai", model: "selected-model", effort: "high"};

test("inheritance requires an observed native identity, not a hardcoded fallback", () => {
  assert.throws(() => applyRouteToTurnStart(message, route, {}), {code: "STATEWRIGHT_ROUTE_SELECTION"});
  const result = applyRouteToTurnStart(message, route, {}, native);
  assert.equal(result.message.params.model, "selected-model");
  assert.equal(result.message.params.effort, "medium");
  assert.equal(result.receipt.requestedModel, null);
  assert.equal(result.receipt.modelSource, "native_selection");
  assert.equal(result.receipt.route.model, null);
  assert.equal(route.model, null);
});

test("native collaboration selection wins and unrelated settings remain untouched", () => {
  const original = {...message, params: {...message.params, model: "top-level", approvalPolicy: "on-request",
    collaborationMode: {mode: "default", settings: {model: "user-selected", reasoning_effort: "high", developer_instructions: "preserve"}}}};
  const result = applyRouteToTurnStart(original, route, {}, native);
  assert.equal(result.message.params.model, "user-selected");
  assert.equal(result.message.params.collaborationMode.settings.model, "user-selected");
  assert.equal(result.message.params.collaborationMode.settings.reasoning_effort, "medium");
  assert.equal(result.message.params.collaborationMode.settings.developer_instructions, "preserve");
  assert.equal(result.message.params.approvalPolicy, "on-request");
  assert.equal(original.params.collaborationMode.settings.reasoning_effort, "high");
});

test("already selected native providers are inherited without a manufactured provider switch", () => {
  const result = applyRouteToTurnStart(message, route, {}, {provider: "qwen_private", model: "local-model"});
  assert.equal(result.receipt.effectiveProvider, "qwen_private");
  assert.equal(result.message.params.model, "local-model");
  assert.deepEqual(result.receipt.providerConfig, {});
  assert.throws(() => applyRouteToTurnStart(message, {...route, model: "casa/local-model"}, {}),
    /companion/);
});

for (const effort of [null, undefined]) test(`inheriting model with ${effort} effort keeps the user's effort`, () => {
  const original = {...message, params: {...message.params, effort: "high"}};
  const result = applyRouteToTurnStart(original, {...route, effort}, {}, native);
  assert.equal(result.message.params.effort, "high");
  assert.equal(result.receipt.effortSpecified, false);
});

test("explicit service tier reset must be applied and confirmed, not mistaken for omission", () => {
  const result = applyRouteToTurnStart({...message, params: {...message.params, serviceTier: "priority"}},
    {...route, service_tier: null}, {}, native);
  assert.equal(result.message.params.serviceTier, null);
  const notification = tier => ({method: "thread/settings/updated", params: {threadId: "own",
    threadSettings: {model: "selected-model", modelProvider: "openai", effort: "medium", serviceTier: tier}}});
  assert.equal(settingsConfirmRoute(result.receipt, notification("priority")).confirmed, false);
  assert.equal(settingsConfirmRoute(result.receipt, notification(null)).confirmed, true);
});

test("malformed explicit model is rejected, not silently treated as inheritance", () => {
  assert.throws(() => applyRouteToTurnStart(message, {...route, model: " "}, {}, native),
    {code: "STATEWRIGHT_ROUTE_SELECTION"});
});
