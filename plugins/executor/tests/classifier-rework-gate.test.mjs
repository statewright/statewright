import assert from "node:assert/strict";
import test from "node:test";
import { ClassifierReworkGate, classifierIntent } from "../lib/classifier-rework-gate.mjs";

const receipt = (fingerprint = "intent_v1_fixture", basis = "incomplete_structural_evidence") => ({
  intent_fingerprint: fingerprint,
  invocation_fingerprint: "invocation_v1_fixture",
  final_denial_basis: basis,
});

test("counts repeated redacted intent and escalates only after the rework budget", () => {
  let now = 1_000;
  const gate = new ClassifierReworkGate({ maxReworks: 2, ttlMs: 10_000, now: () => now });
  const scope = { runId: "run", state: "implement", hostSessionId: "thread" };

  assert.equal(gate.observeDenial({ receipt: receipt(), scope }).attempts, 1);
  assert.equal(gate.observeDenial({ receipt: receipt(), scope }).action, "rework");
  assert.deepEqual(gate.observeDenial({ receipt: receipt(), scope }), {
    schema: "statewright/classifier-rework/v1",
    intent_fingerprint: "intent_v1_fixture",
    invocation_fingerprint: "invocation_v1_fixture",
    basis: "incomplete_structural_evidence",
    attempts: 3,
    max_reworks: 2,
    action: "approval_required",
  });

  now += 10_000;
  assert.equal(gate.observeDenial({ receipt: receipt(), scope }).attempts, 1);
});

test("isolates workflow scope and resets only the matching successful intent", () => {
  const gate = new ClassifierReworkGate();
  const left = { runId: "left", state: "implement", hostSessionId: "thread" };
  const right = { runId: "right", state: "implement", hostSessionId: "thread" };
  gate.observeDenial({ receipt: receipt(), scope: left });
  gate.observeDenial({ receipt: receipt(), scope: right });
  assert.equal(gate.observeSuccess({ receipt: receipt(), scope: left }), true);
  assert.equal(gate.observeDenial({ receipt: receipt(), scope: left }).attempts, 1);
  assert.equal(gate.observeDenial({ receipt: receipt(), scope: right }).attempts, 2);
});

test("ignores malformed, known-risk, and payload-bearing pseudo identities", () => {
  const gate = new ClassifierReworkGate();
  assert.equal(gate.observeDenial({ receipt: null }), null);
  assert.equal(gate.observeDenial({ receipt: receipt("raw command", "semantic_threshold_not_met") }), null);
  assert.equal(gate.observeDenial({ receipt: receipt("intent_v1_known", "deterministic_nonlocal_risk") }), null);
  assert.equal(classifierIntent(receipt("intent_v1_policy", "classifier_policy_low_local")).reworkable, true);
});
