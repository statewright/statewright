import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../scripts/taskfile-delivery-adapter.mjs";

async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("Taskfile adapter executes the configured task and captures typed evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-taskfile-adapter-"));
  const taskfile = join(root, "Taskfile.yml");
  const manifest = join(root, "manifest.json");
  await writeFile(manifest, "{}\n");
  await writeFile(
    taskfile,
    [
      'version: "3"',
      "tasks:",
      "  delivery:prepare:",
      "    cmds:",
      "      - 'printf ''{\"ok\":true,\"action\":\"prepare\",\"prepared\":true}\\n'''",
      "",
    ].join("\n"),
  );

  const result = await withEnvironment({
    STATEWRIGHT_DELIVERY_ACTION: "prepare",
    STATEWRIGHT_DELIVERY_MANIFEST: manifest,
    STATEWRIGHT_DELIVERY_HOOK_ROOT: root,
    STATEWRIGHT_DELIVERY_TASKFILE: "Taskfile.yml",
    STATEWRIGHT_DELIVERY_TASK: "delivery:prepare",
  }, () => execute(["prepare", "--manifest", manifest]));

  assert.equal(result.ok, true);
  assert.equal(result.task, "delivery:prepare");
  assert.equal(result.hook_result.prepared, true);
  assert.match(result.stdout_sha256, /^[a-f0-9]{64}$/);
});

test("Taskfile adapter rejects a hook result for a different action", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-taskfile-mismatch-"));
  const taskfile = join(root, "Taskfile.yml");
  const manifest = join(root, "manifest.json");
  await writeFile(manifest, "{}\n");
  await writeFile(
    taskfile,
    [
      'version: "3"',
      "tasks:",
      "  delivery:prepare:",
      "    cmds:",
      "      - 'printf ''{\"ok\":true,\"action\":\"deploy\"}\\n'''",
      "",
    ].join("\n"),
  );

  await assert.rejects(
    withEnvironment({
      STATEWRIGHT_DELIVERY_ACTION: "prepare",
      STATEWRIGHT_DELIVERY_MANIFEST: manifest,
      STATEWRIGHT_DELIVERY_HOOK_ROOT: root,
      STATEWRIGHT_DELIVERY_TASKFILE: "Taskfile.yml",
      STATEWRIGHT_DELIVERY_TASK: "delivery:prepare",
    }, () => execute(["prepare", "--manifest", manifest])),
    /returned action 'deploy'/,
  );
});
