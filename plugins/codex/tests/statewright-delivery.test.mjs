import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digestDeliveryHooks,
  parseArgs,
} from "../scripts/statewright-delivery.mjs";

test("delivery CLI parses digest independently from run operations", () => {
  assert.deepEqual(
    parseArgs(["digest", "--root", ".statewright/delivery-hooks"]),
    {
      action: "digest",
      root: ".statewright/delivery-hooks",
    },
  );
  assert.throws(() => parseArgs(["digest"]), /requires --root PATH/);
});

test("delivery CLI produces the stable hook-bundle digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-delivery-digest-"));
  const hooks = join(root, "hooks");
  await mkdir(hooks);
  await writeFile(join(hooks, "Taskfile.yml"), 'version: "3"\n');

  const first = await digestDeliveryHooks("hooks", root);
  const second = await digestDeliveryHooks(hooks);

  assert.equal(first.root, hooks);
  assert.equal(first.sha256, second.sha256);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
});
