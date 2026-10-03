import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactedApprovalRequest, requestClassifierApproval } from "../scripts/classifier-approval.mjs";

const input = {
  thread_id: "thread-one",
  run_id: "run-one",
  state: "implement",
  classifier_receipt: {
    intent_fingerprint: "intent_v1_family",
    invocation_fingerprint: "invocation_v1_exact",
    final_denial_basis: "semantic_threshold_not_met",
    required_authority: "assessed_moderate_local",
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
      return new Response(JSON.stringify({schema: "statewright/classifier-approval/v1",
        action: "allow_once", thread_id: "thread-one", run_id: "run-one", state: "implement",
        intent_fingerprint: "intent_v1_family", invocation_fingerprint: "invocation_v1_exact",
        basis: "semantic_threshold_not_met"}), {status: 200});
    },
  });
  assert.equal(result.action, "allow_once");
  assert.equal(observed.url, "http://127.0.0.1:3456/classifier-approval");
  assert.equal(observed.options.headers.Authorization, "Bearer local-secret");
  assert.deepEqual(observed.body, redactedApprovalRequest(input));
  assert.doesNotMatch(JSON.stringify(observed.body), /private sentinel|secret|raw_command|arguments/);

  const routed = await requestClassifierApproval(input, {
    environment: {STATEWRIGHT_ROUTE_CONTROL_DIR: join(runDir, "routes")},
    fetch: async () => new Response(JSON.stringify({
      schema: "statewright/classifier-approval/v1",
      action: "rework",
      attempts: 1,
      max_reworks: 2,
      thread_id: "thread-one",
      run_id: "run-one",
      state: "implement",
      intent_fingerprint: "intent_v1_family",
      invocation_fingerprint: "invocation_v1_exact",
      basis: "semantic_threshold_not_met",
    }), {status: 200}),
  });
  assert.equal(routed.action, "rework");
});

test("classifier approval helper fails closed on absent and mismatched response identities", async () => {
  assert.equal((await requestClassifierApproval({...input, classifier_receipt: {
    ...input.classifier_receipt, invocation_fingerprint: null,
  }})).action, "deny");
  for (const mismatch of [
    {thread_id: "thread-other"},
    {run_id: "run-other"},
    {state: "validate"},
    {intent_fingerprint: "intent_v1_other"},
    {invocation_fingerprint: "invocation_v1_other"},
    {basis: "classifier_policy_low_local"},
  ]) {
    await assert.rejects(() => requestClassifierApproval(input, {
      environment: {LOCAL_MODELS_RUN_DIR: "/runtime"},
      readFile: async () => JSON.stringify({proxyUrl: "ws://127.0.0.1:3456", proxyToken: "secret"}),
      fetch: async () => new Response(JSON.stringify({
        schema: "statewright/classifier-approval/v1", action: "allow_once",
        thread_id: "thread-one", run_id: "run-one", state: "implement",
        intent_fingerprint: "intent_v1_family", invocation_fingerprint: "invocation_v1_exact",
        basis: "semantic_threshold_not_met", ...mismatch,
      }), {status: 200}),
    }), /identity_mismatch/);
  }
});
