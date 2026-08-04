import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertHostAdapterContract,
  executorAgentEnvironment,
  resolvePluginsRoot,
} from "../statewright-exec.mjs";
import { ExecutorLease, validateExecutorLease } from "../lib/executor-lease.mjs";

test("executor environment binds all adapters to one transport identity", () => {
  const environment = executorAgentEnvironment({
    KUBECONFIG: "/sensitive/kubeconfig",
    GH_TOKEN: "secret",
    STATEWRIGHT_API_KEY: "sw_live_secret",
    PATH: "/bin",
  }, {
    workflow: "delivery",
    host: "pi",
    executorId: "executor-1",
    transportSessionId: "br_exec_1",
    workspaceSession: { manifestPath: "/run/manifest.json" },
    leasePath: "/run/lease.json",
    adapterBridge: { url: "http://127.0.0.1:1234", token: "bridge-token" },
    pluginsRoot: "/statewright/plugins",
  });

  assert.equal(environment.STATEWRIGHT_CLIENT_ID, "br_exec_1");
  assert.equal(environment.STATEWRIGHT_MCP_SESSION_ID, "br_exec_1");
  assert.equal(environment.STATEWRIGHT_BRANCH_SESSION_ID, "br_exec_1");
  assert.equal(environment.STATEWRIGHT_EXECUTOR_ID, "executor-1");
  assert.equal(environment.STATEWRIGHT_DELIVERY_ACTIVE, "1");
  assert.equal(environment.KUBECONFIG, "/dev/null");
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.STATEWRIGHT_API_KEY, undefined);
});

test("OpenCode host observation requires an explicit readiness owner", () => {
  assert.throws(
    () => assertHostAdapterContract({ host: "opencode" }),
    /adapter bridge readiness contract/,
  );
  assert.doesNotThrow(() => assertHostAdapterContract({
    host: "opencode",
    adapterBridge: { waitForReady() {} },
  }));
  assert.doesNotThrow(() => assertHostAdapterContract({ host: "claude" }));
});

test("OpenCode executor environment isolates user and project control surfaces", () => {
  const environment = executorAgentEnvironment({
    PATH: "/bin",
    XDG_CONFIG_HOME: "/user/config",
    OPENCODE_CONFIG: "/user/opencode.json",
    OPENCODE_CONFIG_DIR: "/user/opencode",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      plugin: ["oh-my-openagent@latest"],
      plugins: ["opencode-agent-memory@0.2.0"],
      mcp: { foreign: { type: "remote", url: "https://example.invalid" } },
      agent: { explore: { model: "ollama-casa/gpt-oss:20b" } },
      mode: { plan: { model: "openai/gpt-5.4-mini-fast" } },
      command: { foreign: { template: "do something else" } },
      instructions: ["/user/AGENTS.md"],
      model: "ollama-casa/gpt-oss:20b",
      share: "auto",
      provider: { openai: { options: { timeout: 1234 } } },
      permission: { read: "allow" },
    }),
  }, {
    workflow: "delivery",
    host: "opencode",
    executorId: "executor-1",
    transportSessionId: "br_exec_1",
    workspaceSession: null,
    leasePath: "/run/lease.json",
    adapterBridge: { url: "http://127.0.0.1:1234", token: "bridge-token" },
    pluginsRoot: "/statewright/plugins",
  });

  assert.equal(environment.OPENCODE_CONFIG, undefined);
  assert.equal(environment.OPENCODE_CONFIG_DIR, undefined);
  assert.equal(environment.OPENCODE_PURE, undefined);
  assert.equal(environment.OPENCODE_DISABLE_DEFAULT_PLUGINS, undefined);
  assert.equal(environment.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(environment.OPENCODE_DISABLE_CLAUDE_CODE, "1");
  assert.equal(environment.OPENCODE_DISABLE_EXTERNAL_SKILLS, "1");
  assert.equal(environment.OPENCODE_AUTO_SHARE, "false");
  assert.equal(
    environment.XDG_CONFIG_HOME,
    join(tmpdir(), "statewright-opencode-executor-1", "xdg-config"),
  );
  assert.equal(
    environment.OPENCODE_TEST_HOME,
    join(tmpdir(), "statewright-opencode-executor-1", "home"),
  );

  const config = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.share, "disabled");
  assert.equal(config.autoshare, false);
  assert.deepEqual(config.plugin, ["file:///statewright/plugins/opencode/src/index.ts"]);
  assert.deepEqual(Object.keys(config.mcp), ["statewright"]);
  assert.equal(config.agent, undefined);
  assert.equal(config.mode, undefined);
  assert.equal(config.command, undefined);
  assert.equal(config.instructions, undefined);
  assert.equal(config.model, undefined);
  assert.deepEqual(config.provider, { openai: { options: { timeout: 1234 } } });
  assert.deepEqual(config.permission, { read: "allow" });
});

test("executor validates an explicit plugins root before host launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "statewright-plugins-test-"));
  try {
    await mkdir(join(directory, "pi"));
    await mkdir(join(directory, "claude-code"));
    assert.equal(resolvePluginsRoot({ host: "pi", pluginsRoot: directory }), await realpath(directory));
    assert.equal(
      resolvePluginsRoot({ host: "claude", pluginsRoot: directory }),
      await realpath(directory),
    );
    assert.throws(() => resolvePluginsRoot({ host: "omx", pluginsRoot: directory }), /omx adapter/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
