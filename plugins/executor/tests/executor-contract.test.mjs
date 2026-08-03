import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executorAgentEnvironment } from "../statewright-exec.mjs";
import { ExecutorLease, validateExecutorLease } from "../lib/executor-lease.mjs";

test("executor environment binds all adapters to one transport identity", () => {
  const environment = executorAgentEnvironment({
    KUBECONFIG: "/sensitive/kubeconfig",
    GH_TOKEN: "secret",
    PATH: "/bin",
  }, {
    workflow: "delivery",
    host: "pi",
    executorId: "executor-1",
    transportSessionId: "br_exec_1",
    workspaceSession: { manifestPath: "/run/manifest.json" },
    leasePath: "/run/lease.json",
    adapterBridge: { url: "http://127.0.0.1:1234", token: "bridge-token" },
  });

  assert.equal(environment.STATEWRIGHT_CLIENT_ID, "br_exec_1");
  assert.equal(environment.STATEWRIGHT_MCP_SESSION_ID, "br_exec_1");
  assert.equal(environment.STATEWRIGHT_BRANCH_SESSION_ID, "br_exec_1");
  assert.equal(environment.STATEWRIGHT_EXECUTOR_ID, "executor-1");
  assert.equal(environment.STATEWRIGHT_DELIVERY_ACTIVE, "1");
  assert.equal(environment.KUBECONFIG, "/dev/null");
  assert.equal(environment.GH_TOKEN, undefined);
});

test("delivery owner is a fresh matching lease, not an environment marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "statewright-lease-test-"));
  const path = join(directory, "lease.json");
  const lease = await new ExecutorLease(path, {
    executor_id: "executor-1",
    manifest_path: "/run/manifest.json",
  }).start();
  try {
    const environment = {
      STATEWRIGHT_DELIVERY_ACTIVE: "1",
      STATEWRIGHT_EXECUTOR_ID: "executor-1",
      STATEWRIGHT_EXECUTOR_LEASE: path,
      STATEWRIGHT_DELIVERY_MANIFEST: "/run/manifest.json",
    };
    assert.equal((await validateExecutorLease(environment)).valid, true);
    assert.equal((await validateExecutorLease({
      ...environment,
      STATEWRIGHT_EXECUTOR_ID: "executor-2",
    })).valid, false);
    assert.equal(JSON.parse(await readFile(path, "utf8")).executor_id, "executor-1");
  } finally {
    lease.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
