import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalOutcome } from "../lib/approval-pipeline.mjs";
import { ClassifierApprovalController, classifierApprovalRequest } from "../lib/classifier-approval-controller.mjs";

const eligibleBases = [
  "semantic_threshold_not_met",
  "incomplete_structural_evidence",
  "semantic_vector_unavailable",
  "semantic_assessment_incomplete",
  "semantic_authorization_disabled",
];

function request(overrides = {}, receiptOverrides = {}) {
  return {
    schema: "statewright/classifier-approval-request/v2",
    thread_id: "thread-one",
    run_id: "run-one",
    run_session_id: "session-one",
    state: "implement",
    state_epoch: 4,
    classifier_receipt: {
      intent_fingerprint: "intent_v1_family",
      invocation_fingerprint: "invocation_v1_exact-one",
      final_denial_basis: "semantic_threshold_not_met",
      required_authority: "complete_structural_evidence_or_separate_approval",
      reformulation_allowed: true,
      exact_invocation_retry_allowed: false,
      separate_approval_allowed: true,
      ...receiptOverrides,
    },
    ...overrides,
  };
}

const currentState = async threadId => {
  assert.equal(threadId, "thread-one");
  return { run_id: "run-one", run_session_id: "session-one", state: "implement", state_epoch: 4 };
};
const response = async result => result.outcome === ApprovalOutcome.ASK
  ? result.completion : result.response;

test("only explicitly eligible uncertain classifier decisions enter approval", () => {
  for (const basis of eligibleBases) {
    assert.equal(classifierApprovalRequest(request({}, { final_denial_basis: basis }))?.basis, basis);
  }
  for (const receiptOverrides of [
    { final_denial_basis: "workflow_capability_write_denied" },
    { final_denial_basis: "classifier_policy_low_local" },
    { final_denial_basis: "effective_known_risk" },
    { required_authority: "BoundedLocalExecution" },
    { reformulation_allowed: false },
    { reformulation_allowed: undefined },
    { exact_invocation_retry_allowed: true },
    { exact_invocation_retry_allowed: undefined },
    { separate_approval_allowed: false },
    { separate_approval_allowed: undefined },
  ]) assert.equal(classifierApprovalRequest(request({}, receiptOverrides)), null);
});

test("malformed or unbounded identity fields fail closed", () => {
  for (const value of [
    null, [], request({ schema: "statewright/classifier-approval-request/v1" }),
    request({ thread_id: "" }), request({ run_id: "" }), request({ run_session_id: "" }),
    request({ state: "bad\nstate" }), request({ state_epoch: -1 }),
    request({}, { intent_fingerprint: "not-an-intent" }),
    request({}, { invocation_fingerprint: "not-an-invocation" }),
    request({}, { final_denial_basis: "" }),
  ]) assert.equal(classifierApprovalRequest(value), null);
});

test("one native reply releases only its exact pending invocation once", async () => {
  const sent = [];
  const controller = new ClassifierApprovalController({ send: value => sent.push(value),
    getState: currentState, maxReworks: 1 });
  assert.equal((await response(await controller.begin(request()))).action, "rework");
  const decision = await controller.begin(request({}, { invocation_fingerprint: "invocation_v1_exact-two" }));
  assert.equal(decision.outcome, ApprovalOutcome.ASK);
  const modal = sent.find(value => value.method === "mcpServer/elicitation/request");
  assert(modal);
  assert.equal(modal.params.mode, "form");
  assert.equal(modal.params.serverName, "statewright");
  assert.equal(controller.handleReply({ id: "statewright-classifier-approval-stale",
    result: { action: "accept" } }), true);
  let settled = false;
  void decision.completion.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(controller.handleReply({ id: modal.id, result: { action: "accept" } }), true);
  const allowed = await decision.completion;
  assert.equal(allowed.action, "allow_once");
  assert.equal(allowed.invocation_fingerprint, "invocation_v1_exact-two");
  assert.equal(controller.handleReply({ id: modal.id, result: { action: "accept" } }), true);
  assert.equal((await response(await controller.begin(request()))).action, "rework");
});

test("native errors, sender failures, abort, and close all deny", async () => {
  for (const [reply, reason] of [
    [{ error: { code: -1, message: "unavailable" } }, "native_approval_error"],
    [{ result: { action: "unexpected" } }, "human_cancelled"],
  ]) {
    const sent = [];
    const controller = new ClassifierApprovalController({ send: value => sent.push(value),
      getState: currentState, maxReworks: 1 });
    await controller.begin(request());
    const decision = await controller.begin(request({}, { invocation_fingerprint: "invocation_v1_exact-two" }));
    const modal = sent.find(value => value.method === "mcpServer/elicitation/request");
    controller.handleReply({ id: modal.id, ...reply });
    assert.equal((await decision.completion).reason, reason);
  }

  const failed = new ClassifierApprovalController({ send: () => { throw new Error("closed"); },
    getState: currentState, maxReworks: 1 });
  await failed.begin(request());
  assert.equal((await response(await failed.begin(request({}, {
    invocation_fingerprint: "invocation_v1_exact-two",
  })))).reason, "native_approval_unavailable");

  const sent = [];
  const closed = new ClassifierApprovalController({ send: value => sent.push(value),
    getState: currentState, maxReworks: 1 });
  await closed.begin(request());
  const pending = await closed.begin(request({}, { invocation_fingerprint: "invocation_v1_exact-two" }));
  closed.close("provider_connection_closed");
  assert.equal((await pending.completion).reason, "provider_connection_closed");

  const aborted = new ClassifierApprovalController({ send: value => sent.push(value),
    getState: currentState, maxReworks: 1 });
  await aborted.begin(request());
  const abort = new AbortController();
  const aborting = await aborted.begin(request({}, { invocation_fingerprint: "invocation_v1_exact-two" }),
    { signal: abort.signal });
  abort.abort();
  assert.equal((await aborting.completion).reason, "approval_request_aborted");
});

test("native acceptance revalidates the authoritative run and state", async () => {
  for (const [getState, reason] of [
    [null, "approval_state_unavailable"],
    [async () => { throw new Error("offline"); }, "approval_state_unavailable"],
    [async () => null, "approval_state_changed"],
    [async () => ({ run_id: "run-two", state: "implement" }), "approval_state_changed"],
    [async () => ({ run_id: "run-one", run_session_id: "session-two", state: "implement", state_epoch: 4 }), "approval_state_changed"],
    [async () => ({ run_id: "run-one", run_session_id: "session-one", state: "validate", state_epoch: 4 }), "approval_state_changed"],
    [async () => ({ run_id: "run-one", run_session_id: "session-one", state: "implement", state_epoch: 5 }), "approval_state_changed"],
    [async () => ({ run_id: "run-one", run_session_id: "session-one", state: "implement", state_epoch: 4,
      pending_approval: { approval_id: "apr" } }), "approval_state_changed"],
  ]) {
    const sent = [];
    const controller = new ClassifierApprovalController({ send: value => sent.push(value),
      getState, maxReworks: 1 });
    await controller.begin(request());
    const decision = await controller.begin(request({}, { invocation_fingerprint: "invocation_v1_exact-two" }));
    const modal = sent.find(value => value.method === "mcpServer/elicitation/request");
    controller.handleReply({ id: modal.id, result: { action: "accept" } });
    const result = await decision.completion;
    assert.equal(result.action, "deny");
    assert.equal(result.reason, reason);
  }
});

test("a pending request blocks concurrent invocations and denial expires", async () => {
  let now = 1_000;
  const sent = [];
  const controller = new ClassifierApprovalController({ send: value => sent.push(value),
    getState: currentState, maxReworks: 1, ttlMs: 1_000, now: () => now });
  await controller.begin(request());
  const pending = await controller.begin(request({}, { invocation_fingerprint: "invocation_v1_exact-two" }));
  const modal = sent.find(value => value.method === "mcpServer/elicitation/request");
  assert.equal((await response(await controller.begin(request({}, {
    invocation_fingerprint: "invocation_v1_exact-three",
  })))).reason, "approval_already_pending");
  controller.handleReply({ id: modal.id, result: { action: "decline" } });
  assert.equal((await pending.completion).reason, "human_declined");
  assert.equal((await response(await controller.begin(request({}, {
    invocation_fingerprint: "invocation_v1_exact-three",
  })))).reason, "approval_previously_denied");
  now += 1_000;
  assert.equal((await response(await controller.begin(request({}, {
    invocation_fingerprint: "invocation_v1_exact-three",
  })))).action, "rework");
});
