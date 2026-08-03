import assert from "node:assert/strict";
import test from "node:test";
import { executorCoreDrift } from "../scripts/sync-executor-core.mjs";

test("Codex marketplace bundle contains the shared executor core", async () => {
  assert.deepEqual(await executorCoreDrift(), []);
});
