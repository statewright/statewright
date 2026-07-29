import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeliveryController } from "../scripts/lib/delivery-controller.mjs";

function policyMeta() {
  return {
    workspace: {
      version: 1,
      mode: "git_worktree",
      required: true,
      cleanup: "after_promoted",
    },
    preview: {
      version: 1,
      mode: "taskfile",
      required: true,
      prepare_state: "preview",
      deploy_state: "preview",
      validate_state: "validate",
    },
    promotion: {
      version: 1,
      mode: "manual",
      required: true,
      promote_state: "promote",
      teardown_on_final: true,
    },
    failure_states: ["blocked"],
  };
}

test("delivery actions run once even when a state is observed repeatedly", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-controller-"));
  const evidence = join(root, "evidence");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(evidence));
  const counter = join(root, "counter.txt");
  const driver = join(root, "driver.mjs");
  await writeFile(
    driver,
    [
      'import { appendFile } from "node:fs/promises";',
      `await appendFile(${JSON.stringify(counter)}, process.argv[2] + "\\n");`,
      'console.log(JSON.stringify({ ok: true, action: process.argv[2] }));',
    ].join("\n"),
  );
  const session = {
    config: {
      hooks: {
        actionTimeoutMs: 10_000,
        environmentAllowlist: ["PATH"],
        taskfile: "Taskfile.yml",
        actions: Object.fromEntries(
          ["prepare", "deploy", "validate", "lock", "renew", "preflight-promote",
            "promote", "unlock", "teardown", "discard"]
            .map((action) => [action, `delivery:${action}`]),
        ),
      },
      promotion: { mode: "manual" },
    },
    manifest: {
      run_id: "test-controller",
      manifest_digest: "digest",
      evidence_path: evidence,
      hook_bundle_path: root,
    },
    manifestPath: join(root, "manifest.json"),
    primaryCwd: root,
    adapterPath: () => driver,
    checkpoint: async () => ({}),
    fingerprint: async () => "fingerprint",
    promote: async () => {
      throw new Error("promotion should not run");
    },
    preflightCleanup: async () => {},
    cleanup: async () => {},
  };
  const controller = await new DeliveryController(session).initialize();
  const state = { state: "preview", is_final: false, meta: policyMeta() };

  await controller.observeState(state);
  await controller.observeState(state);

  assert.deepEqual((await readFile(counter, "utf8")).trim().split("\n"), [
    "prepare",
    "deploy",
  ]);
  assert.equal(controller.actions["prepare:run"].status, "complete");
  assert.equal(controller.actions["deploy:fingerprint"].status, "complete");
});

test("driver receives only allowlisted operator environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-controller-env-"));
  const evidence = join(root, "evidence");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(evidence));
  const captured = join(root, "environment.json");
  const driver = join(root, "driver.mjs");
  await writeFile(
    driver,
    [
      'import { writeFile } from "node:fs/promises";',
      `await writeFile(${JSON.stringify(captured)}, JSON.stringify({`,
      "  path: process.env.PATH,",
      "  secret: process.env.STATEWRIGHT_OPERATOR_SECRET,",
      "  run: process.env.STATEWRIGHT_DELIVERY_RUN_ID,",
      "}));",
      'console.log(JSON.stringify({ ok: true }));',
    ].join("\n"),
  );
  const previous = process.env.STATEWRIGHT_OPERATOR_SECRET;
  process.env.STATEWRIGHT_OPERATOR_SECRET = "must-not-cross";
  const session = {
    config: {
      hooks: {
        actionTimeoutMs: 10_000,
        environmentAllowlist: ["PATH"],
        taskfile: "Taskfile.yml",
        actions: Object.fromEntries(
          ["prepare", "deploy", "validate", "lock", "renew", "preflight-promote",
            "promote", "unlock", "teardown", "discard"]
            .map((action) => [action, `delivery:${action}`]),
        ),
      },
      promotion: { mode: "manual" },
    },
    manifest: {
      run_id: "test-env",
      manifest_digest: "digest",
      evidence_path: evidence,
      hook_bundle_path: root,
    },
    manifestPath: join(root, "manifest.json"),
    primaryCwd: root,
    adapterPath: () => driver,
    checkpoint: async () => ({}),
    fingerprint: async () => "fingerprint",
    promote: async () => {},
    preflightCleanup: async () => {},
    cleanup: async () => {},
  };
  try {
    const controller = await new DeliveryController(session).initialize();
    await controller.observeState({
      state: "preview",
      is_final: false,
      meta: policyMeta(),
    });
    const environment = JSON.parse(await readFile(captured, "utf8"));
    assert.ok(environment.path);
    assert.equal(environment.secret, undefined);
    assert.equal(environment.run, "test-env");
  } finally {
    if (previous === undefined) delete process.env.STATEWRIGHT_OPERATOR_SECRET;
    else process.env.STATEWRIGHT_OPERATOR_SECRET = previous;
  }
});

test("a repaired commit fingerprint redeploys and validation cannot outrun deploy", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-controller-repair-"));
  const evidence = join(root, "evidence");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(evidence));
  const driver = join(root, "driver.mjs");
  await writeFile(driver, 'console.log(JSON.stringify({ ok: true }));\n');
  let fingerprint = "first";
  const session = {
    config: {
      hooks: {
        actionTimeoutMs: 10_000,
        environmentAllowlist: ["PATH"],
        taskfile: "Taskfile.yml",
        actions: Object.fromEntries(
          ["prepare", "deploy", "validate", "lock", "renew", "preflight-promote",
            "promote", "unlock", "teardown", "discard"]
            .map((action) => [action, `delivery:${action}`]),
        ),
      },
      promotion: { mode: "manual" },
    },
    manifest: {
      run_id: "test-repair",
      manifest_digest: "digest",
      evidence_path: evidence,
      hook_bundle_path: root,
    },
    manifestPath: join(root, "manifest.json"),
    primaryCwd: root,
    adapterPath: () => driver,
    checkpoint: async () => ({}),
    fingerprint: async () => fingerprint,
    promote: async () => {},
    preflightCleanup: async () => {},
    cleanup: async () => {},
  };
  const controller = await new DeliveryController(session).initialize();
  const meta = policyMeta();

  await assert.rejects(
    controller.observeState({ state: "validate", is_final: false, meta }),
    /without a matching deploy/,
  );
  await controller.observeState({ state: "preview", is_final: false, meta });
  await controller.observeState({ state: "validate", is_final: false, meta });
  fingerprint = "second";
  await controller.observeState({ state: "preview", is_final: false, meta });

  assert.equal(controller.actions["deploy:first"].status, "complete");
  assert.equal(controller.actions["validate:first"].status, "complete");
  assert.equal(controller.actions["deploy:second"].status, "complete");
});

test("promotion lock spans Git promotion and the deployment driver", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-controller-promote-"));
  const evidence = join(root, "evidence");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(evidence));
  const sequence = join(root, "sequence.txt");
  const driver = join(root, "driver.mjs");
  await writeFile(
    driver,
    [
      'import { appendFile } from "node:fs/promises";',
      `await appendFile(${JSON.stringify(sequence)}, process.argv[2] + "\\n");`,
      'console.log(JSON.stringify({ ok: true }));',
    ].join("\n"),
  );
  const session = {
    config: {
      hooks: {
        actionTimeoutMs: 10_000,
        environmentAllowlist: ["PATH"],
        taskfile: "Taskfile.yml",
        actions: Object.fromEntries(
          ["prepare", "deploy", "validate", "lock", "renew", "preflight-promote",
            "promote", "unlock", "teardown", "discard"]
            .map((action) => [action, `delivery:${action}`]),
        ),
      },
      promotion: { mode: "squash" },
    },
    manifest: {
      run_id: "test-promote",
      manifest_digest: "digest",
      evidence_path: evidence,
      hook_bundle_path: root,
    },
    manifestPath: join(root, "manifest.json"),
    primaryCwd: root,
    adapterPath: () => driver,
    checkpoint: async () => ({}),
    fingerprint: async () => "fingerprint",
    promote: async () => appendFile(sequence, "git-promote\n"),
    preflightCleanup: async () => {},
    cleanup: async () => {},
  };
  const meta = policyMeta();
  meta.promotion.mode = "squash";
  const controller = await new DeliveryController(session).initialize();
  controller.actions["validate:fingerprint"] = { status: "complete" };

  await controller.observeState({ state: "promote", is_final: false, meta });

  assert.deepEqual((await readFile(sequence, "utf8")).trim().split("\n"), [
    "lock",
    "preflight-promote",
    "git-promote",
    "promote",
    "unlock",
  ]);
  assert.equal(controller.actions["promote:fingerprint"].status, "complete");
});
