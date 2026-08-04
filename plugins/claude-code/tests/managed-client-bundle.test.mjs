import assert from "node:assert/strict";
import test from "node:test";
import { managedClientBundleDrift } from "../scripts/sync-managed-client.mjs";

test("Claude plugin bundles the managed-client runtime without drift", async () => {
  assert.deepEqual(await managedClientBundleDrift(), []);
});
