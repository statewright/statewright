import assert from "node:assert/strict";
import test from "node:test";
import { formatClassifierRework } from "../src/classifier-rework-gate.mjs";

test("renders bounded rework and approval escalation without command data", () => {
  assert.match(formatClassifierRework({
    schema: "statewright/classifier-rework/v1",
    attempts: 1,
    max_reworks: 2,
    action: "rework",
  }), /1\/2/);
  assert.match(formatClassifierRework({
    schema: "statewright/classifier-rework/v1",
    attempts: 3,
    max_reworks: 2,
    action: "approval_required",
  }), /native human approval/);
});

test("ignores malformed receipts", () => {
  assert.equal(formatClassifierRework({ action: "rework", attempts: 1, max_reworks: 2 }), null);
});
