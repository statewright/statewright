import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalMemory } from "../lib/approval-memory.mjs";
import { ClaudeClassifierApproval } from "../lib/claude-classifier-approval.mjs";
import { ClassifierReworkGate } from "../lib/classifier-rework-gate.mjs";
import { digestJson } from "../lib/native-mcp-approval-binding.mjs";

const input = { command: "curl https://example.invalid", cwd: "/workspace" };
const body = toolUseId => ({ session_id: "claude-session", tool_use_id: toolUseId,
  tool_name: "Bash", tool_input: input });
const scope = { runId: "run", state: "implement", hostSessionId: "executor" };
const policy = () => ({ policy_sha256: "a".repeat(64), grant_policy_v2_sha256: "b".repeat(64),
  allowed_durations: ["once", "2h"], approve_for: "2h" });
const approval = (overrides = {}) => ({ schema: "statewright/approval-memory-context/v1", ...policy(),
  invocation_sha256: digestJson(["Bash", input]), dependency_sha256: "c".repeat(64),
  reusable: true, ...overrides });
const gatewayResult = (memory = approval(), receiptOverrides = {}) => ({
  decision: "deny", reason: "Classifier uncertainty", state: "implement",
  classifier_context: { run_id: "run", run_session_id: "transport", state: "implement",
    state_epoch: 4, session_generation: "generation", approval_memory: memory },
  risk_assessment: { intent_fingerprint: "intent_v1_family", invocation_fingerprint: "invocation_v1_exact",
    final_denial_basis: "incomplete_structural_evidence",
    required_authority: "complete_structural_evidence_or_separate_approval",
    reformulation_allowed: true, exact_invocation_retry_allowed: false,
    separate_approval_allowed: true, ...receiptOverrides },
});
const owner = { async assertOwner() {}, assertGateway() {} };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "statewright-claude-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const events = [];
  const state = { run_id: "run", run_session_id: "transport", state: "implement", state_epoch: 4,
    session_generation: "generation", approval_memory_policy: policy() };
  const makeMemory = namespace => new ApprovalMemory({ root, namespace, now: () => now });
  const makeController = (memory = makeMemory("owner-one")) => new ClaudeClassifierApproval({
    memory, reworkGate: new ClassifierReworkGate({ maxReworks: 0 }),
    getState: async () => state, owner, sessionId: "executor", now: () => now,
    record: event => events.push(event),
  });
  return { makeMemory, makeController, state, events, setNow: value => { now = value; } };
}

test("Claude remembered grant requires matching dependency, policy and owner", async t => {
  const f = await fixture(t);
  const memory = f.makeMemory("owner-one");
  await memory.remember(approval(), "2h");
  const same = f.makeController(memory);
  assert.equal((await same.preTool(body("same"), gatewayResult(), scope)).result.decision, "defer");

  const dependency = approval({ dependency_sha256: "d".repeat(64) });
  assert.equal((await f.makeController(memory).preTool(body("dependency"), gatewayResult(dependency), scope)).result.decision, "ask");

  const changedPolicy = approval({ grant_policy_v2_sha256: "e".repeat(64) });
  f.state.approval_memory_policy = { ...policy(), grant_policy_v2_sha256: "e".repeat(64) };
  assert.equal((await f.makeController(memory).preTool(body("policy"), gatewayResult(changedPolicy), scope)).result.decision, "ask");

  f.state.approval_memory_policy = policy();
  assert.equal((await f.makeController(f.makeMemory("owner-two"))
    .preTool(body("owner"), gatewayResult(), scope)).result.decision, "ask");
});

test("Claude expired grant prompts again", async t => {
  const f = await fixture(t);
  const memory = f.makeMemory("owner-one");
  await memory.remember(approval(), "2h");
  f.setNow(1_000 + 2 * 3600_000);
  assert.equal((await f.makeController(memory).preTool(body("expired"), gatewayResult(), scope)).result.decision, "ask");
});

test("Claude once and incomplete provenance never persist reusable grants", async t => {
  const f = await fixture(t);
  const memory = f.makeMemory("owner-one");
  for (const [toolUseId, context] of [
    ["once", approval({ approve_for: "once" })],
    ["incomplete", approval({ reusable: false })],
  ]) {
    f.state.approval_memory_policy = { ...policy(), approve_for: context.approve_for };
    const controller = f.makeController(memory);
    const pre = await controller.preTool(body(toolUseId), gatewayResult(context), scope);
    assert.equal(pre.result.decision, "ask");
    assert.match(pre.result.reason, /Allow this exact invocation once/);
    await controller.postTool(body(toolUseId));
    await controller.recordChain;
    assert.deepEqual(await memory.list(), []);
  }
});

test("Claude mismatched PostToolUse and explicit risk deny cannot mint grants", async t => {
  const f = await fixture(t);
  const memory = f.makeMemory("owner-one");
  const controller = f.makeController(memory);
  assert.equal((await controller.preTool(body("one"), gatewayResult(), scope)).result.decision, "ask");
  await controller.postTool({ ...body("one"), tool_input: { ...input, command: "curl https://other.invalid" } });
  await controller.recordChain;
  assert.deepEqual(await memory.list(), []);
  assert(f.events.some(event => event.type === "classifier_human_approval_unresolved"
    && event.reason === "post_tool_invocation_mismatch"));
  assert(!f.events.some(event => event.type === "classifier_human_approval_granted"));

  const explicit = await f.makeController(memory).preTool(body("risk"), gatewayResult(approval(), {
    final_denial_basis: "effective_known_risk",
  }), scope);
  assert.equal(explicit.result.decision, "deny");
  assert.equal(explicit.result.classifier_approval, undefined);
  assert.deepEqual(await memory.list(), []);
});
