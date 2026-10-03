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
