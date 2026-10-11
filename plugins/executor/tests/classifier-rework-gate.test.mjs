import assert from "node:assert/strict";
import test from "node:test";
import { ClassifierReworkGate, classifierIntent } from "../lib/classifier-rework-gate.mjs";

const receipt = (invocation = "one", fingerprint = "intent_v1_fixture",
  basis = "incomplete_structural_evidence", overrides = {}) => ({
  intent_fingerprint: fingerprint,
  invocation_fingerprint: `invocation_v1_${invocation}`,
  final_denial_basis: basis,
  required_authority: "complete_structural_evidence_or_separate_approval",
  reformulation_allowed: true,
  exact_invocation_retry_allowed: false,
  separate_approval_allowed: true,
  ...overrides,
});

test("counts repeated redacted intent and escalates only after the rework budget", () => {
  let now = 1_000;
  const gate = new ClassifierReworkGate({ maxReworks: 2, ttlMs: 10_000, now: () => now });
  const scope = { runId: "run", state: "implement", hostSessionId: "thread" };

  assert.equal(gate.observeDenial({ receipt: receipt("one"), scope }).attempts, 1);
  assert.equal(gate.observeDenial({ receipt: receipt("two"), scope }).action, "rework");
  assert.deepEqual(gate.observeDenial({ receipt: receipt("three"), scope }), {
    schema: "statewright/classifier-rework/v1",
    intent_fingerprint: "intent_v1_fixture",
    invocation_fingerprint: "invocation_v1_three",
    basis: "incomplete_structural_evidence",
    attempts: 3,
    max_reworks: 2,
    action: "approval_required",
  });

  now += 10_000;
  assert.equal(gate.observeDenial({ receipt: receipt("four"), scope }).attempts, 1);
});

test("exact invocation replay is denied without consuming rework budget", () => {
  const gate = new ClassifierReworkGate({maxReworks: 2});
  const scope = {runId: "run", state: "implement", hostSessionId: "thread"};
  assert.equal(gate.observeDenial({receipt: receipt("one"), scope}).attempts, 1);
  assert.deepEqual(gate.observeDenial({receipt: receipt("one"), scope}), {
    schema: "statewright/classifier-rework/v1",
    intent_fingerprint: "intent_v1_fixture",
    invocation_fingerprint: "invocation_v1_one",
    basis: "incomplete_structural_evidence",
    attempts: 1,
    max_reworks: 2,
    action: "exact_invocation_denied",
  });
  assert.equal(gate.observeDenial({receipt: receipt("two"), scope}).attempts, 2);
});

test("isolates workflow scope and resets only the matching successful intent", () => {
  const gate = new ClassifierReworkGate();
  const left = { runId: "left", state: "implement", hostSessionId: "thread" };
  const right = { runId: "right", state: "implement", hostSessionId: "thread" };
  gate.observeDenial({ receipt: receipt("one"), scope: left });
  gate.observeDenial({ receipt: receipt("one"), scope: right });
  assert.equal(gate.observeSuccess({ receipt: receipt("one"), scope: left }), true);
  assert.equal(gate.observeDenial({ receipt: receipt("two"), scope: left }).attempts, 1);
  assert.equal(gate.observeDenial({ receipt: receipt("two"), scope: right }).attempts, 2);
});

test("ignores malformed, known-risk, capability, policy, and ineligible pseudo identities", () => {
  const gate = new ClassifierReworkGate();
  assert.equal(gate.observeDenial({ receipt: null }), null);
  assert.equal(gate.observeDenial({ receipt: receipt("one", "raw command") }), null);
  assert.equal(gate.observeDenial({ receipt: receipt("one", "intent_v1_known", "deterministic_nonlocal_risk") }), null);
  for (const candidate of [
    receipt("one", "intent_v1_policy", "classifier_policy_low_local"),
    receipt("one", "intent_v1_capability", "workflow_capability_write_denied"),
    receipt("one", "intent_v1_wrong-authority", undefined, {required_authority: "Write"}),
    receipt("one", "intent_v1_exact-retry", undefined, {exact_invocation_retry_allowed: true}),
    receipt("one", "intent_v1_no-approval", undefined, {separate_approval_allowed: false}),
  ]) assert.equal(classifierIntent(candidate).reworkable, false);
});
