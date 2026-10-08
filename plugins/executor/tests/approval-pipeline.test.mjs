import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalOutcome, ApprovalPipeline, approvalAllow, approvalAsk,
  approvalDeny, approvalError, approvalNotHandled } from "../lib/approval-pipeline.mjs";

const handler = (name, priority, handle) => ({ name, priority, handle });

test("approval handlers run in explicit priority order and only not-handled passes", async () => {
  const calls = [];
  const result = await new ApprovalPipeline([
    handler("later", 200, () => { calls.push("later"); return approvalAllow({ action: "allow" }); }),
    handler("first", 100, () => { calls.push("first"); return approvalNotHandled(); }),
  ]).service({ kind: "test" });
  assert.deepEqual(calls, ["first", "later"]);
  assert.equal(result.outcome, ApprovalOutcome.ALLOW);
  assert.equal(result.handler, "later");
});

for (const [label, terminal] of [
  ["deny", () => approvalDeny({ action: "deny" })],
  ["ask", () => approvalAsk(Promise.resolve("asked"))],
  ["allow", () => approvalAllow({ action: "allow" })],
  ["error", () => approvalError("unavailable")],
]) test(`approval ${label} short-circuits later handlers`, async () => {
  let later = false;
  const result = await new ApprovalPipeline([
    handler("terminal", 10, terminal),
    handler("later", 20, () => { later = true; return approvalAllow({ action: "allow" }); }),
  ]).service({});
  assert.equal(result.outcome, label);
  assert.equal(later, false);
});

test("unsupported requests remain not-handled while unavailable handlers fail closed", async () => {
  const unsupported = await new ApprovalPipeline([
    handler("one", 10, approvalNotHandled), handler("two", 20, approvalNotHandled),
  ]).service({});
  assert.equal(unsupported.outcome, ApprovalOutcome.NOT_HANDLED);

  const unavailable = await new ApprovalPipeline([
    handler("required", 10, () => { throw new Error("offline"); }),
    handler("must-not-run", 20, () => approvalAllow({ action: "allow" })),
  ]).service({});
  assert.equal(unavailable.outcome, ApprovalOutcome.ERROR);
  assert.equal(unavailable.reason, "approval_handler_unavailable:required");
});

test("duplicate priorities and malformed handler results are rejected safely", async () => {
  assert.throws(() => new ApprovalPipeline([
    handler("one", 10, approvalNotHandled), handler("two", 10, approvalNotHandled),
  ]), /Duplicate approval priority/);
  for (const malformed of [
    { outcome: "maybe" },
    { outcome: ApprovalOutcome.DENY },
    { outcome: ApprovalOutcome.ALLOW, response: null },
    { outcome: ApprovalOutcome.ASK, completion: "not-a-promise" },
    { outcome: ApprovalOutcome.ERROR, reason: "" },
  ]) {
    const result = await new ApprovalPipeline([handler("bad", 10, () => malformed)]).service({});
    assert.equal(result.outcome, ApprovalOutcome.ERROR);
    assert.equal(result.reason, "approval_handler_invalid_result:bad");
  }
});
