import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WorkflowRouteOriginStore,
  sameWorkflowRouteBinding,
  workflowRouteBinding,
} from "../lib/workflow-route-origin.mjs";

const binding = {
  thread_id: "thread-1",
  run_id: "run-1",
  run_session_id: "run-session-1",
  client_id: "client-1",
  root_session_id: "thread-1",
};
const origin = {
  provider: "openai",
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  service_tier: "priority",
};

test("route binding retains the exact thread, run, run-session, client, and root identity", () => {
  assert.deepEqual(workflowRouteBinding({
    session_id: binding.thread_id,
    run_id: binding.run_id,
    run_session_id: binding.run_session_id,
    client_id: binding.client_id,
    root_session_id: binding.root_session_id,
  }), binding);
  assert.equal(sameWorkflowRouteBinding(binding, binding), true);
  assert.equal(sameWorkflowRouteBinding(binding, { ...binding, run_id: "foreign-run" }), false);
  assert.equal(sameWorkflowRouteBinding(binding, { ...binding, run_session_id: null }), false);
  assert.equal(sameWorkflowRouteBinding(binding, { ...binding, client_id: "foreign-client" }), false);
});

test("verified successor keeps the pre-routing origin across missed teardown and reconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-origin-successor-"));
  const routed = {model: "openai-codex/gpt-5.6-terra", effort: "medium", service_tier: "priority"};
  const successor = {...binding, run_id: "run-2"};
  try {
    const first = new WorkflowRouteOriginStore({root, clientId: binding.client_id});
    await first.capture(binding, origin);
    await first.confirmRoute(binding, routed);
    const store = new WorkflowRouteOriginStore({root, clientId: binding.client_id});
    assert.equal((await store.capture(successor, routed)).status, "binding_conflict");
    const result = await store.captureSuccessor(successor, routed, {previousBinding: binding, isCurrent: async () => true});
    assert.equal(result.status, "captured");
    assert.deepEqual(result.record.origin, origin);
    assert.deepEqual(result.record.predecessor.binding, binding);
    assert.equal((await store.confirmRestore(binding)).status, "binding_mismatch");
    const reconnected = new WorkflowRouteOriginStore({root, clientId: binding.client_id});
    assert.equal((await reconnected.capture(successor, routed)).status, "existing");
    const restore = await reconnected.prepareRestore(successor, routed);
    assert.equal(restore.status, "ready");
    assert.equal(restore.route.model, origin.model);
    assert.equal(restore.route.effort, origin.effort);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("successor capture preserves acknowledged manual choices and unobserved changes", async () => {
  const routed = {model: "openai-codex/gpt-5.6-terra", effort: "medium", service_tier: "priority"};
  for (const manual of [true, false]) {
    const store = new WorkflowRouteOriginStore();
    await store.capture(binding, {...origin, service_tier: "default"});
    await store.confirmRoute(binding, routed);
    if (manual) await store.relinquish(binding.thread_id, ["model", "effort"], routed);
    const observed = manual ? routed : {...routed, model: "openai-codex/gpt-6-astra", effort: "high"};
    const result = await store.captureSuccessor({...binding, run_id: "new-run"}, observed,
      {previousBinding: binding, isCurrent: async () => true});
    assert.equal(result.status, "captured");
    assert.equal(result.record.origin.model, observed.model);
    assert.equal(result.record.origin.effort, observed.effort);
    assert.equal(result.record.origin.service_tier, manual ? "default" : observed.service_tier);
  }
});

test("successor capture rejects foreign bindings, stale authority, missing settings and concurrent changes", async () => {
  const routed = {model: "openai-codex/gpt-5.6-terra", effort: "medium", service_tier: "priority"};
  for (const scenario of ["foreign-client", "foreign-session", "foreign-root", "foreign-thread", "same-run", "missing-authority", "stale", "unavailable", "unknown-effort", "concurrent-manual"]) {
    const store = new WorkflowRouteOriginStore();
    await store.capture(binding, origin);
    await store.confirmRoute(binding, routed);
    const next = {...binding, run_id: "new-run"};
    if (scenario === "same-run") next.run_id = binding.run_id;
    for (const [name, key] of [["foreign-client", "client_id"], ["foreign-session", "run_session_id"], ["foreign-root", "root_session_id"], ["foreign-thread", "thread_id"]]) if (scenario === name) next[key] = "foreign";
    const observed = {...routed};
    if (scenario === "unknown-effort") delete observed.effort;
    const result = await store.captureSuccessor(next, observed, {previousBinding: binding,
      ...(scenario === "missing-authority" ? {} : {isCurrent: async () => {
        if (scenario === "unavailable") throw new Error("unavailable");
        if (scenario === "concurrent-manual") await store.relinquish(binding.thread_id, ["effort"], {effort: "high"});
        return scenario !== "stale";
      }})});
    assert.notEqual(result.status, "captured", scenario);
    assert.deepEqual((await store.inspect(binding.thread_id)).binding, binding, scenario);
  }
});

test("credential renewal carries the baseline only after verified continuity and preserves manual axes", async () => {
  const store = new WorkflowRouteOriginStore();
  const baseline = {...origin, effort:null, service_tier:"default"};
  const routed = {model:"workflow-model",effort:"low",service_tier:"priority"};
  await store.capture(binding, baseline);
  await store.confirmRoute(binding, routed);
  const manual = {model:"manual-model",effort:"xhigh"};
  await store.relinquish(binding.thread_id, ["model","effort"], manual);
  const next = {...binding,run_id:"renewed-run",run_session_id:"renewed-session"};
  const observed = {...routed,...manual};
  assert.equal((await store.captureSuccessor(next, observed,
    {previousBinding:binding,isCurrent:async()=>true})).status, "session_renewal_unverified");
  const result = await store.captureSuccessor(next, observed, {
    previousBinding:binding,isCurrent:async()=>true,
    verifySessionRenewal:async(previous,current)=>{
      assert.deepEqual(previous,binding); assert.deepEqual(current,next); return true;
    },
  });
  assert.equal(result.status,"captured");
  assert.equal(result.record.session_renewed,true);
  assert.equal(result.record.origin.model,manual.model);
  assert.equal(result.record.origin.effort,manual.effort);
  assert.equal(result.record.origin.service_tier,"default");
  assert.deepEqual(result.record.predecessor.binding,binding);
});

test("verified session renewal still rejects stale state and concurrent provenance changes", async () => {
  for (const changed of ["state","manual","foreign-client","proof-error"]) {
    const store=new WorkflowRouteOriginStore();
    await store.capture(binding,origin);
    const routed={model:"workflow-model",effort:"low",service_tier:"priority"};
    await store.confirmRoute(binding,routed);
    const next={...binding,run_id:"renewed-run",run_session_id:"renewed-session",
      ...(changed==="foreign-client"?{client_id:"other"}:{})};
    const result=await store.captureSuccessor(next,routed,{previousBinding:binding,
      isCurrent:async()=>changed!=="state",verifySessionRenewal:async()=>{
        if(changed==="proof-error")throw new Error("unavailable");
        if(changed==="manual")await store.relinquish(binding.thread_id,["effort"],{effort:"high"});
        return true;
      }});
    assert.notEqual(result.status,"captured",changed);
    assert.deepEqual((await store.inspect(binding.thread_id)).binding,binding);
  }
});

test("session renewal retains exact default effort and restores it after the successor", async () => {
  const store=new WorkflowRouteOriginStore();
  const baseline={...origin,effort:null};
  const routed={model:"workflow-model",effort:"medium",service_tier:"priority"};
  await store.capture(binding,baseline);
  await store.confirmRoute(binding,routed);
  const next={...binding,run_id:"next",run_session_id:"new-key-session"};
  assert.equal((await store.captureSuccessor(next,routed,{previousBinding:binding,
    verifySessionRenewal:async()=>true,isCurrent:async()=>true})).status,"captured");
  const restored=await store.prepareRestore(next,routed);
  assert.equal(restored.status,"ready");
  assert.equal(Object.hasOwn(restored.route,"effort"),true);
  assert.equal(restored.route.effort,null);
});

test("captured origins survive store reconstruction and clear only after confirmed restoration", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-route-origin-"));
  try {
    const ownsBinding = async candidate => candidate.thread_id === binding.thread_id;
    const first = new WorkflowRouteOriginStore({ root, clientId: binding.client_id, ownsBinding });
    assert.equal((await first.capture(binding, origin)).status, "captured");
    await first.confirmRoute(binding, {
      model: "openai-codex/gpt-5.6-terra",
      effort: "medium",
      service_tier: "default",
    });

    const reconnected = new WorkflowRouteOriginStore({ root, clientId: binding.client_id, ownsBinding });
    const prepared = await reconnected.prepareRestore(binding, {
      model: "openai-codex/gpt-5.6-terra",
      effort: "medium",
      service_tier: "default",
    });
    assert.equal(prepared.status, "ready");
    assert.deepEqual(prepared.route, {
      model: origin.model,
      effort: origin.effort,
      service_tier: origin.service_tier,
    });
    assert.ok(await reconnected.inspect(binding.thread_id), "unconfirmed restoration must retain provenance");
    assert.equal((await reconnected.confirmRestore(binding)).status, "restored");
    assert.equal(await reconnected.inspect(binding.thread_id), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted restore remains retryable before or after native settings apply", async () => {
  for (const observed of [
    { model: "openai-codex/gpt-5.6-terra", effort: "medium", service_tier: "default" },
    origin,
  ]) {
    const store = new WorkflowRouteOriginStore({ clientId: binding.client_id });
    await store.capture(binding, origin);
    await store.confirmRoute(binding, {
      model: "openai-codex/gpt-5.6-terra", effort: "medium", service_tier: "default",
    });
    assert.equal((await store.prepareRestore(binding, {
      model: "openai-codex/gpt-5.6-terra", effort: "medium", service_tier: "default",
    })).status, "ready");
    const retried = await store.prepareRestore(binding, observed);
    assert.equal(retried.status, "ready");
    assert.deepEqual(retried.route, {
      model: origin.model, effort: origin.effort, service_tier: origin.service_tier,
    });
    assert.equal((await store.inspect(binding.thread_id)).status, "restore_pending");
    assert.equal((await store.confirmRestore(binding)).status, "restored");
  }
});

test("an owned partial restoration retains provenance and remains retryable", async () => {
  const store = new WorkflowRouteOriginStore({ clientId: binding.client_id, ownsBinding: async () => true });
  const nullableOrigin = {
    provider: "openai",
    model: "openai-codex/gpt-5.6-sol",
    effort: null,
    service_tier: "priority",
  };
  const routed = {
    model: "openai-codex/gpt-5.6-terra",
    effort: "medium",
    service_tier: "priority",
  };
  const partiallyApplied = {
    model: "openai-codex/gpt-5.6-sol",
    effort: "medium",
    service_tier: "priority",
  };
  await store.capture(binding, nullableOrigin);
  await store.confirmRoute(binding, routed);
  assert.equal((await store.prepareRestore(binding, routed)).status, "ready");

  const recovered = await store.prepareRestore(binding, partiallyApplied);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.partial_application, true);
  assert.deepEqual(recovered.route, {
    model: nullableOrigin.model,
    effort: null,
    service_tier: "priority",
  });
  const retained = await store.inspect(binding.thread_id);
  assert.equal(retained.status, "restore_pending");
  assert.equal(retained.restore_attempt.epoch, 1);
  assert.deepEqual(retained.restore_attempt.requested, recovered.route);
  assert.deepEqual(retained.restore_attempt.observed_before, routed);
  assert.deepEqual(retained.restore_attempt.last_observed, partiallyApplied);
});

test("a partial restoration survives reconstruction but an explicit manual change wins", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-route-origin-partial-"));
  try {
    const nullableOrigin = {
      provider: "openai",
      model: "openai-codex/gpt-5.6-sol",
      effort: null,
      service_tier: "priority",
    };
    const routed = {
      model: "openai-codex/gpt-5.6-terra",
      effort: "medium",
      service_tier: "priority",
    };
    const first = new WorkflowRouteOriginStore({ root, clientId: binding.client_id, ownsBinding: async () => true });
    await first.capture(binding, nullableOrigin);
    await first.confirmRoute(binding, routed);
    await first.prepareRestore(binding, routed);

    const reconnected = new WorkflowRouteOriginStore({ root, clientId: binding.client_id, ownsBinding: async () => true });
    const partial = await reconnected.prepareRestore(binding, {
      model: nullableOrigin.model,
      effort: "medium",
      service_tier: "priority",
    });
    assert.equal(partial.status, "ready");
    assert.equal(partial.partial_application, true);

    // This explicit native selection is byte-for-byte indistinguishable from
    // the model half of an owned partial restore. The acknowledged manual
    // settings path must therefore outrank tuple-shape recovery.
    await reconnected.relinquish(binding.thread_id, ["model"], { model: nullableOrigin.model });
    const manual = {
      model: nullableOrigin.model,
      effort: "medium",
      service_tier: "priority",
    };
    const preserved = await reconnected.prepareRestore(binding, manual);
    assert.equal(preserved.status, "relinquished");
    assert.deepEqual(preserved.route, manual);
    assert.equal(await reconnected.inspect(binding.thread_id), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reconstructed pending restoration remains retryable only with current authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-route-origin-pending-"));
  try {
    let owned = true;
    const ownsBinding = async () => owned;
    const first = new WorkflowRouteOriginStore({ root, clientId: binding.client_id, ownsBinding });
    const routed = { model: "openai-codex/gpt-5.6-terra", effort: "medium", service_tier: "default" };
    await first.capture(binding, origin);
    await first.confirmRoute(binding, routed);
    assert.equal((await first.prepareRestore(binding, routed)).status, "ready");

    const reconnected = new WorkflowRouteOriginStore({ root, clientId: binding.client_id, ownsBinding });
    assert.equal((await reconnected.prepareRestore(binding, routed)).status, "ready");
    owned = false;
    assert.equal((await reconnected.prepareRestore(binding, routed)).status, "unowned_binding");
    assert.equal((await reconnected.inspect(binding.thread_id)).status, "restore_pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown native settings retain provenance and explicit null remains known evidence", async () => {
  const store = new WorkflowRouteOriginStore({ clientId: binding.client_id });
  const nullableOrigin = { provider: "openai", model: origin.model, effort: null };
  await store.capture(binding, nullableOrigin);
  await store.confirmRoute(binding, { model: "openai-codex/gpt-5.6-terra", effort: "medium" });
  const unknown = await store.prepareRestore(binding, { model: "openai-codex/gpt-5.6-terra" });
  assert.deepEqual(unknown, { status: "current_settings_unknown", unknown: ["effort"] });
  assert.ok(await store.inspect(binding.thread_id), "unknown settings must not delete provenance");
  const ready = await store.prepareRestore(binding, { model: "openai-codex/gpt-5.6-terra", effort: "medium" });
  assert.equal(ready.status, "ready");
  assert.equal(Object.hasOwn(ready.route, "effort"), true);
  assert.equal(ready.route.effort, null);
  assert.equal(Object.hasOwn(ready.route, "service_tier"), false);
});

test("an interrupted restore still preserves a later manual route tuple", async () => {
  const store = new WorkflowRouteOriginStore({ clientId: binding.client_id });
  const routed = { model: "openai-codex/gpt-5.6-terra", effort: "medium", service_tier: "default" };
  await store.capture(binding, origin);
  await store.confirmRoute(binding, routed);
  await store.prepareRestore(binding, routed);
  const manual = { model: "openai-codex/gpt-6-astra", effort: "xhigh", service_tier: "flex" };
  const result = await store.prepareRestore(binding, manual);
  assert.equal(result.status, "relinquished");
  assert.deepEqual(result.route, manual);
  assert.equal(await store.inspect(binding.thread_id), null);
});

test("manual model-only, effort-only, and pair changes preserve the complete observed tuple", async () => {
  for (const current of [
    { model: "openai-codex/gpt-6-astra", effort: "medium", service_tier: "default" },
    { model: "openai-codex/gpt-5.6-terra", effort: "xhigh", service_tier: "default" },
    { model: "openai-codex/gpt-6-astra", effort: "xhigh", service_tier: "flex" },
  ]) {
    const store = new WorkflowRouteOriginStore({ clientId: binding.client_id });
    await store.capture(binding, origin);
    await store.confirmRoute(binding, {
      model: "openai-codex/gpt-5.6-terra", effort: "medium", service_tier: "default",
    });
    const prepared = await store.prepareRestore(binding, current);
    assert.equal(prepared.status, "relinquished");
    assert.equal(prepared.reason, "observed_route_diverged");
    assert.deepEqual(prepared.route, current);
    assert.equal(await store.inspect(binding.thread_id), null);
  }
});

test("a fully relinquished route is removed without overwriting the deliberate manual pair", async () => {
  const store = new WorkflowRouteOriginStore({ clientId: binding.client_id });
  await store.capture(binding, origin);
  await store.confirmRoute(binding, {
    model: "openai-codex/gpt-5.6-terra", effort: "medium", service_tier: "default",
  });
  await store.relinquish(binding.thread_id, ["model", "effort", "service_tier"]);
  const current = { model: "openai-codex/gpt-6-astra", effort: "xhigh", service_tier: "flex" };
  const prepared = await store.prepareRestore(binding, current);
  assert.equal(prepared.status, "relinquished");
  assert.deepEqual(prepared.route, current);
  assert.equal(await store.inspect(binding.thread_id), null);
});

test("stale, cross-run, cross-client, and missing provenance never produce a fallback route", async () => {
  const store = new WorkflowRouteOriginStore({ clientId: binding.client_id });
  assert.equal((await store.prepareRestore(binding, origin)).status, "missing_provenance");
  await store.capture(binding, origin);
  await store.confirmRoute(binding, origin);
  assert.equal((await store.prepareRestore({ ...binding, run_id: "stale-run" }, origin)).status, "binding_mismatch");
  assert.equal((await store.prepareRestore({ ...binding, client_id: "foreign-client" }, origin)).status, "binding_mismatch");
  assert.equal((await store.capture({ ...binding, run_id: "new-run" }, origin)).status, "binding_conflict");
  assert.ok(await store.inspect(binding.thread_id), "a mismatched restore must preserve the owning record");
});

test("a confirmed restore permits the next activation to capture a fresh origin", async () => {
  const store = new WorkflowRouteOriginStore({ clientId: binding.client_id });
  await store.capture(binding, origin);
  await store.confirmRoute(binding, origin);
  await store.prepareRestore(binding, origin);
  await store.confirmRestore(binding);
  const nextBinding = { ...binding, run_id: "run-2", run_session_id: "run-session-2" };
  const nextOrigin = { provider: "openai", model: "openai-codex/gpt-6-astra", effort: "xhigh", service_tier: "flex" };
  const captured = await store.capture(nextBinding, nextOrigin);
  assert.equal(captured.status, "captured");
  assert.deepEqual(captured.record.origin, nextOrigin);
});

test("failed initial routing cannot turn the Statewright destination into a new origin", async () => {
  const store = new WorkflowRouteOriginStore({ clientId: binding.client_id });
  await store.capture(binding, origin);
  assert.equal((await store.prepareRestore(binding, origin)).status, "route_unconfirmed");
  assert.equal((await store.capture(binding, {
    provider: "openai", model: "openai-codex/gpt-5.6-terra", effort: "medium", service_tier: "default",
  })).record.origin.model, origin.model);
});

test("malformed and cross-owner durable records are safe misses", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-route-origin-invalid-"));
  try {
    const seed = new WorkflowRouteOriginStore({ root, clientId: binding.client_id });
    await seed.capture(binding, origin);
    const [name] = await readdir(root);
    for (const invalid of [
      { version: 1, binding, origin, ownership: { model: true }, status: "active" },
      { version: 1, binding: { ...binding, client_id: "foreign-client" }, origin,
        ownership: { model: true, effort: true, service_tier: true }, manual: {}, routed: origin,
        status: "active", captured_at: "now", updated_at: "now" },
    ]) {
      await writeFile(join(root, name), JSON.stringify(invalid));
      const loaded = new WorkflowRouteOriginStore({ root, clientId: binding.client_id });
      assert.equal(await loaded.inspect(binding.thread_id), null);
      assert.equal((await loaded.prepareRestore(binding, origin)).status, "missing_provenance");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
