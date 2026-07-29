import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findDeliveryConfig,
  resolveDeliveryBootstrap,
  validateDeliveryConfig,
} from "../scripts/lib/delivery-config.mjs";

function validConfig() {
  return {
    version: 1,
    workspace: {
      mode: "git_worktree",
      root: "./runs",
      repositories: [
        {
          name: "app",
          path: ".",
          base_ref: "main",
          target_branch: "main",
          primary: true,
        },
      ],
    },
    preview: {
      driver_root: "scripts",
      driver: "preview.mjs",
      bundle_sha256: "a".repeat(64),
      environment_allowlist: ["PATH", "KUBECONFIG", "STATEWRIGHT_API_KEY"],
    },
    promotion: { mode: "squash", commit_message: "feat: promote preview" },
  };
}

test("delivery config resolves trusted paths and one primary repository", () => {
  const config = validateDeliveryConfig(validConfig(), "/workspace/project/delivery.json");
  assert.equal(config.workspace.root, "/workspace/project/runs");
  assert.equal(config.workspace.repositories[0].sourcePath, "/workspace/project");
  assert.equal(config.preview.driver, "preview.mjs");
  assert.equal(config.preview.driverRoot, "/workspace/project/scripts");
  assert.deepEqual(config.preview.environmentAllowlist, [
    "PATH",
    "KUBECONFIG",
    "STATEWRIGHT_API_KEY",
  ]);
  assert.equal(config.preview.evidenceRoot, resolve("/workspace/project/runs", ".evidence"));
});

test("delivery config applies mechanical defaults without guessing trust inputs", () => {
  const raw = validConfig();
  delete raw.workspace.mode;
  delete raw.workspace.root;
  delete raw.workspace.repositories[0].base_ref;
  delete raw.workspace.repositories[0].primary;
  delete raw.preview.driver;
  delete raw.preview.driver_root;
  delete raw.preview.environment_allowlist;
  delete raw.promotion;

  const config = validateDeliveryConfig(raw, "/workspace/project/.statewright/delivery.json");
  assert.equal(config.enabled, true);
  assert.equal(config.workspace.mode, "git_worktree");
  assert.match(config.workspace.root, /[.]statewright[/\\]delivery-runs$/);
  assert.equal(config.workspace.repositories[0].baseRef, "main");
  assert.equal(config.workspace.repositories[0].primary, true);
  assert.equal(config.preview.driver, "preview-delivery.mjs");
  assert.equal(config.preview.driverRoot, "/workspace/project/.statewright/delivery-driver");
  assert.deepEqual(config.preview.environmentAllowlist, [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ]);
  assert.equal(config.promotion.mode, "manual");
});

test("enabled false is a complete dormant delivery configuration", () => {
  const config = validateDeliveryConfig(
    { enabled: false },
    "/workspace/project/.statewright/delivery.json",
  );
  assert.equal(config.enabled, false);
  assert.equal(config.workspace, undefined);
});

test("enabled rejects every present non-boolean value", () => {
  for (const enabled of [null, "false", 0, 1]) {
    assert.throws(
      () => validateDeliveryConfig(
        { enabled },
        "/workspace/project/.statewright/delivery.json",
      ),
      /enabled must be true or false/,
    );
  }
});

test("delivery config rejects duplicate repositories and unsafe drivers", () => {
  const duplicate = validConfig();
  duplicate.workspace.repositories.push({
    ...duplicate.workspace.repositories[0],
    primary: false,
  });
  assert.throws(
    () => validateDeliveryConfig(duplicate, "/workspace/project/delivery.json"),
    /duplicate repository name/,
  );

  const unsafe = validConfig();
  unsafe.preview.driver = "../preview.mjs";
  assert.throws(
    () => validateDeliveryConfig(unsafe, "/workspace/project/delivery.json"),
    /must not contain '\.\.'/,
  );

  const unpinned = validConfig();
  unpinned.preview.bundle_sha256 = "not-a-digest";
  assert.throws(
    () => validateDeliveryConfig(unpinned, "/workspace/project/delivery.json"),
    /lowercase SHA-256/,
  );
});

test("delivery config rejects multiple primaries and an unbounded action timeout", () => {
  const multiplePrimaries = validConfig();
  multiplePrimaries.workspace.repositories.push({
    name: "second",
    path: "../second",
    base_ref: "main",
    target_branch: "main",
    primary: true,
  });
  assert.throws(
    () => validateDeliveryConfig(multiplePrimaries, "/workspace/project/delivery.json"),
    /at most one primary/,
  );

  const timeout = validConfig();
  timeout.preview.action_timeout_ms = 10;
  assert.throws(
    () => validateDeliveryConfig(timeout, "/workspace/project/delivery.json"),
    /1000 to 7200000/,
  );
});

test("adapter finds the nearest project config and remains dormant without one", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-delivery-config-"));
  try {
    const project = join(root, "project");
    const nested = join(project, "src", "nested");
    const configDir = join(project, ".statewright");
    await mkdir(nested, { recursive: true });
    await mkdir(configDir);
    const configPath = join(configDir, "delivery.json");
    await writeFile(configPath, JSON.stringify({ enabled: false }));

    assert.equal(await findDeliveryConfig(nested), configPath);
    const discovered = await resolveDeliveryBootstrap({ cwd: nested });
    assert.equal(discovered.enabled, false);
    assert.equal(discovered.source, "project");
    assert.equal(discovered.expectedConfigPath, configPath);

    const absent = await resolveDeliveryBootstrap({ cwd: join(root, "other") });
    assert.equal(absent.enabled, false);
    assert.equal(absent.source, "dormant");
    assert.match(absent.expectedConfigPath, /[.]statewright[/\\]delivery[.]json$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
