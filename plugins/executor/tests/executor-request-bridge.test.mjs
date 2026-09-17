import test from "node:test";
import assert from "node:assert/strict";
import { AdapterBridge } from "../lib/adapter-bridge.mjs";
import { base, fixture } from "./fixtures/owned-request.mjs";

async function bridgeFixture(t, options) {
  let bridge;
  const f = await fixture({ after: callback => t.after(async () => { await bridge?.close(); await callback(); }) }, options);
  const effects = [];
  let afterEffect = async () => {};
  bridge = await new AdapterBridge({
    call: async (name, args) => {
      if (name === "statewright_get_state") return f.getState();
      effects.push({ name, args });
      await afterEffect();
      return { decision: "allow" };
    },
    request: async (method, params) => {
      effects.push({ method, params });
      await afterEffect();
      return { content: [{ type: "text", text: "synthetic effect" }] };
    },
  }, { host: "pi", sessionOwner: f.owner, requestController: f.controller }).start();
  const post = (path, body, token = bridge.token) => fetch(`${bridge.url}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const mcp = (params, reference) => post("/mcp", { jsonrpc: "2.0", id: "fixture", method: "tools/call", params,
    ...(reference ? { request_reference: reference } : {}) });
  return { ...f, bridge, post, mcp, effects, setAfterEffect: callback => { afterEffect = callback; } };
}

test("private request hooks require the local token and cannot carry approval decisions", async t => {
  const f = await bridgeFixture(t, { parked: true });
  assert.equal((await f.post("/hooks/request/begin", f.body(1), "foreign")).status, 401);
  assert.equal(f.owner.record.request_epoch, 0);
  const begun = await (await f.post("/hooks/request/begin", f.body(1))).json();
  assert.equal(begun.phase, "parked");
  assert.equal((await f.post("/hooks/request/status", { reference: begun.reference, decision: "approved" })).status, 400);
  assert.equal((await f.post("/hooks/request/resolve", { reference: begun.reference, decision: "approved" })).status, 400);
  assert.equal((await f.post("/api/runtime-approval", { decision: "approved" })).status, 404);
  const forged = await f.post("/hooks/request/begin", { ...f.body(2), request_epoch: 999, checkpoint: base });
  assert.equal(forged.status, 502);
  assert.equal(f.owner.record.request_epoch, 1);
  assert.equal(f.owner.record.request.phase, "parked");
  assert.deepEqual(f.effects, []);
});

test("effect authority comes from private outer metadata, never model tool arguments", async t => {
  const f = await bridgeFixture(t);
  const begun = await (await f.post("/hooks/request/begin", f.body(1))).json();
  const params = { name: "statewright_transition", arguments: { event: "FIXTURE", request_reference: begun.reference } };
  assert.ok((await (await f.mcp(params)).json()).error);
  assert.ok((await (await f.mcp(params, { ...begun.reference, request_epoch: 999 })).json()).error);
  assert.deepEqual(f.effects, []);
  const result = await (await f.mcp(params, begun.reference)).json();
  assert.ok(result.result);
  assert.equal(f.effects.length, 1);
  assert.ok((await (await f.mcp({ name: "statewright_load_workflow", arguments: { name: "foreign" } }, begun.reference)).json()).error);
  assert.equal(f.effects.length, 1);
});

test("pending requests deny MCP, pre-tool and post-tool effects without a model loop", async t => {
  const f = await bridgeFixture(t, { parked: true });
  const begun = await (await f.post("/hooks/request/begin", f.body(1))).json();
  assert.ok((await (await f.mcp({ name: "statewright_transition", arguments: { event: "FIXTURE" } }, begun.reference)).json()).error);
  for (const hook of ["pre-tool", "post-tool"]) {
    assert.equal((await f.post(`/hooks/${hook}`, { tool_name: "fixture", request_reference: begun.reference })).status, 502);
  }
  assert.deepEqual(f.effects, []);
  assert.ok(await f.mirror.loadCheckpoint());
});

test("replacement input denies delayed old post-tool callbacks", async t => {
  const f = await bridgeFixture(t);
  const old = await (await f.post("/hooks/request/begin", f.body(1))).json();
  const latest = await (await f.post("/hooks/request/begin", f.body(2))).json();
  assert.equal((await f.post("/hooks/post-tool", { tool_name: "fixture", request_reference: old.reference })).status, 502);
  assert.deepEqual(f.effects, []);
  assert.equal((await f.post("/hooks/post-tool", { tool_name: "fixture", request_reference: latest.reference })).status, 200);
  assert.equal(f.effects.length, 1);
});

test("bridge refuses a result if the owned run changed while an effect awaited", async t => {
  const f = await bridgeFixture(t);
  const begun = await (await f.post("/hooks/request/begin", f.body(1))).json();
  f.setAfterEffect(async () => f.setLive({ ...base, run_id: "foreign" }));
  assert.ok((await (await f.mcp({ name: "statewright_transition", arguments: { event: "FIXTURE" } }, begun.reference)).json()).error);
  assert.equal(f.effects.length, 1);
});

test("request hooks cannot be enabled without a Pi host and durable owner", () => {
  assert.throws(() => new AdapterBridge({}, { host: "pi", requestController: {} }), /owned Pi/);
  assert.throws(() => new AdapterBridge({}, { host: "claude", requestController: {}, sessionOwner: {} }), /owned Pi/);
});
