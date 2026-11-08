import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { humanInputHook } from "../lib/queued-human-input.mjs";
import { humanInputHook as packagedHook } from "../../codex/scripts/lib/desktop-runtime/queued-human-input.mjs";

test("shared and packaged guidance preserve a pending native approval", () => {
  const text = humanInputHook().hookSpecificOutput.additionalContext;
  assert.deepEqual(packagedHook(), humanInputHook());
  assert.match(text, /Never cancel, interrupt, kill, or abandon a pending native approval/);
  assert.match(text, /elapsed time, missing output, or a quiet tool call/);
  assert.match(text, /Do not transition to BLOCKED merely because approval is pending/);
  assert.match(text, /Do not replay or duplicate the protected action/);
  assert.match(text, /explicit user cancellation, an authoritative denial\/expiry, or a confirmed transport failure/);
  assert.match(text, /reconcile the original request's outcome before any retry/);
});

test("the installed-form hook entrypoint emits the same approval wait guidance", () => {
  const result = spawnSync(process.execPath, ["plugins/codex/scripts/human-input-hook.mjs"], {
    env: {}, encoding: "utf8", timeout: 2000,
  });
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert(context.startsWith(humanInputHook().hookSpecificOutput.additionalContext));
  assert.match(context, /Await the existing native approval result/);
});

test("workflow continuation nudge cannot instruct abandoning a pending approval", async () => {
  const script = await readFile("plugins/codex/hook.sh", "utf8");
  assert.match(script, /Exception: pending native approval is a wait, not a workflow block/);
  assert.match(script, /Never cancel its waiting tool or transition BLOCKED solely because review is pending/);
});
