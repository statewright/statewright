import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactedApprovalRequest, requestClassifierApproval } from "../scripts/classifier-approval.mjs";

const input = {
  thread_id: "thread-one",
  run_id: "run-one",
  run_session_id: "session-one",
  state: "implement",
  state_epoch: 4,
  classifier_receipt: {
    intent_fingerprint: "intent_v1_family",
    invocation_fingerprint: "invocation_v1_exact",
    final_denial_basis: "semantic_threshold_not_met",
    required_authority: "complete_structural_evidence_or_separate_approval",
    reformulation_allowed: true,
    exact_invocation_retry_allowed: false,
    separate_approval_allowed: true,
    raw_command: "private sentinel",
    arguments: {secret: true},
  },
};

test("classifier approval helper forwards only bounded redacted identity", async t => {
  const runDir = await mkdtemp(join(tmpdir(), "statewright-classifier-"));
  t.after(() => rm(runDir, {recursive: true, force: true}));
  await writeFile(join(runDir, "runtime.json"), JSON.stringify({
    proxyUrl: "ws://127.0.0.1:3456", proxyToken: "local-secret",
  }));
  let observed;
  const result = await requestClassifierApproval(input, {
    environment: {LOCAL_MODELS_RUN_DIR: runDir},
    fetch: async (url, options) => {
      observed = {url: String(url), options, body: JSON.parse(options.body)};
      return new Response(JSON.stringify({schema: "statewright/classifier-approval/v2",
        action: "allow_once", thread_id: "thread-one", run_id: "run-one",
        run_session_id: "session-one", state: "implement", state_epoch: 4,
        intent_fingerprint: "intent_v1_family", invocation_fingerprint: "invocation_v1_exact",
        basis: "semantic_threshold_not_met",
        required_authority: "complete_structural_evidence_or_separate_approval",
        reformulation_allowed: true, exact_invocation_retry_allowed: false,
        separate_approval_allowed: true}), {status: 200});
    },
  });
  assert.equal(result.action, "allow_once");
  assert.equal(observed.url, "http://127.0.0.1:3456/classifier-approval");
  assert.equal(observed.options.headers.Authorization, "Bearer local-secret");
  assert.deepEqual(observed.body, redactedApprovalRequest(input));
  assert.doesNotMatch(JSON.stringify(observed.body), /private sentinel|secret|raw_command|arguments/);

  const routed = await requestClassifierApproval(input, {
    environment: {STATEWRIGHT_ROUTE_CONTROL_DIR: join(runDir, "routes"),
      STATEWRIGHT_CLASSIFIER_APPROVAL_RECEIPT: join(runDir, "manifest.json"),
      LOCAL_MODELS_RUN_DIR: join(runDir, "stale-foreign-run")},
    readFile: async path => {
      assert.equal(path, join(runDir, "manifest.json"),
        "the explicit Statewright owner must win without cross-mode fallback");
      return JSON.stringify({proxyUrl: "ws://127.0.0.1:3456", proxyToken: "local-secret"});
    },
    fetch: async () => new Response(JSON.stringify({
      schema: "statewright/classifier-approval/v2",
      action: "rework",
      attempts: 1,
      max_reworks: 2,
      thread_id: "thread-one",
      run_id: "run-one",
      run_session_id: "session-one",
      state: "implement",
      state_epoch: 4,
      intent_fingerprint: "intent_v1_family",
      invocation_fingerprint: "invocation_v1_exact",
      basis: "semantic_threshold_not_met",
      required_authority: "complete_structural_evidence_or_separate_approval",
      reformulation_allowed: true,
      exact_invocation_retry_allowed: false,
      separate_approval_allowed: true,
    }), {status: 200}),
  });
  assert.equal(routed.action, "rework");

  let companionReceipt;
  const companion = await requestClassifierApproval(input, {
    environment: {LOCAL_MODELS_RUN_DIR: runDir,
      STATEWRIGHT_ROUTE_CONTROL_DIR: join(runDir, "routes")},
    readFile: async path => {
      companionReceipt = path;
      return JSON.stringify({proxyUrl: "ws://127.0.0.1:3456", proxyToken: "local-secret"});
    },
    fetch: async () => new Response(JSON.stringify({
      schema: "statewright/classifier-approval/v2", action: "rework",
      thread_id: "thread-one", run_id: "run-one", run_session_id: "session-one",
      state: "implement", state_epoch: 4, intent_fingerprint: "intent_v1_family",
      invocation_fingerprint: "invocation_v1_exact", basis: "semantic_threshold_not_met",
      required_authority: "complete_structural_evidence_or_separate_approval",
      reformulation_allowed: true, exact_invocation_retry_allowed: false,
      separate_approval_allowed: true,
    }), {status: 200}),
  });
  assert.equal(companion.action, "rework");
  assert.equal(companionReceipt, join(runDir, "runtime.json"),
    "a companion route directory must not be misclassified as a standalone manifest");
});

test("classifier approval helper rejects ineligible or incomplete gateway receipts", async () => {
  for (const classifierReceipt of [
    {...input.classifier_receipt, invocation_fingerprint: null},
    {...input.classifier_receipt, final_denial_basis: "workflow_capability_write_denied"},
    {...input.classifier_receipt, final_denial_basis: "classifier_policy_low_local"},
    {...input.classifier_receipt, required_authority: "BoundedLocalExecution"},
    {...input.classifier_receipt, reformulation_allowed: false},
    {...input.classifier_receipt, exact_invocation_retry_allowed: true},
    {...input.classifier_receipt, separate_approval_allowed: false},
  ]) {
    assert.deepEqual(await requestClassifierApproval({...input, classifier_receipt: classifierReceipt}), {
      schema: "statewright/classifier-approval/v2",
      action: "deny",
      reason: "invalid_redacted_classifier_receipt",
    });
  }
  for (const incomplete of [
    {...input, run_session_id: ""},
    {...input, state_epoch: null},
  ]) {
    assert.deepEqual(await requestClassifierApproval(incomplete), {
      schema: "statewright/classifier-approval/v2",
      action: "deny",
      reason: "invalid_redacted_classifier_receipt",
    });
  }
});

test("classifier approval helper fails closed on mismatched response identities", async () => {
  for (const mismatch of [
    {schema: "statewright/classifier-approval/v1"},
    {thread_id: "thread-other"},
    {run_id: "run-other"},
    {run_session_id: "session-other"},
    {state: "validate"},
    {state_epoch: 5},
    {intent_fingerprint: "intent_v1_other"},
    {invocation_fingerprint: "invocation_v1_other"},
    {basis: "classifier_policy_low_local"},
    {required_authority: "BoundedLocalExecution"},
    {reformulation_allowed: false},
    {exact_invocation_retry_allowed: true},
    {separate_approval_allowed: false},
  ]) {
    await assert.rejects(() => requestClassifierApproval(input, {
      environment: {LOCAL_MODELS_RUN_DIR: "/runtime"},
      readFile: async () => JSON.stringify({proxyUrl: "ws://127.0.0.1:3456", proxyToken: "secret"}),
      fetch: async () => new Response(JSON.stringify({
        schema: "statewright/classifier-approval/v2", action: "allow_once",
        thread_id: "thread-one", run_id: "run-one", run_session_id: "session-one",
        state: "implement", state_epoch: 4,
        intent_fingerprint: "intent_v1_family", invocation_fingerprint: "invocation_v1_exact",
        basis: "semantic_threshold_not_met",
        required_authority: "complete_structural_evidence_or_separate_approval",
        reformulation_allowed: true, exact_invocation_retry_allowed: false,
        separate_approval_allowed: true, ...mismatch,
      }), {status: 200}),
    }), /identity_mismatch/);
  }
});

test("classifier approval helper rejects unsupported actions and non-loopback runtimes", async () => {
  await assert.rejects(() => requestClassifierApproval(input, {
    environment: {LOCAL_MODELS_RUN_DIR: "/runtime"},
    readFile: async () => JSON.stringify({proxyUrl: "ws://127.0.0.1:3456", proxyToken: "secret"}),
    fetch: async () => new Response(JSON.stringify({
      schema: "statewright/classifier-approval/v2", action: "approve_forever",
    }), {status: 200}),
  }), /invalid_action/);
  await assert.rejects(() => requestClassifierApproval(input, {
    environment: {LOCAL_MODELS_RUN_DIR: "/runtime"},
    readFile: async () => JSON.stringify({proxyUrl: "wss://example.invalid", proxyToken: "secret"}),
  }), /not_loopback/);
});
