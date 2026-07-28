import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { validateDeliveryConfig } from "../scripts/lib/delivery-config.mjs";

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
    preview: { driver: "scripts/preview.mjs" },
    promotion: { mode: "squash", commit_message: "feat: promote preview" },
  };
}

test("delivery config resolves trusted paths and one primary repository", () => {
  const config = validateDeliveryConfig(validConfig(), "/workspace/project/delivery.json");
  assert.equal(config.workspace.root, "/workspace/project/runs");
  assert.equal(config.workspace.repositories[0].sourcePath, "/workspace/project");
  assert.equal(config.preview.driver, "scripts/preview.mjs");
  assert.equal(config.preview.evidenceRoot, resolve("/workspace/project/runs", ".evidence"));
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
});

test("delivery config requires exactly one primary and bounded action timeout", () => {
  const missingPrimary = validConfig();
  missingPrimary.workspace.repositories[0].primary = false;
  assert.throws(
    () => validateDeliveryConfig(missingPrimary, "/workspace/project/delivery.json"),
    /exactly one primary/,
  );

  const timeout = validConfig();
  timeout.preview.action_timeout_ms = 10;
  assert.throws(
    () => validateDeliveryConfig(timeout, "/workspace/project/delivery.json"),
    /1000 to 7200000/,
  );
});
