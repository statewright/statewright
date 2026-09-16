import test from "node:test";
import assert from "node:assert/strict";
import { approvalRequirementText, HumanApprovalController, pendingApprovalSnapshot } from "../lib/human-approval.mjs";

const ticket = { approval_id: "apr_test", run_id: "run1", threadId: "thread1", from_state: "review", to_state: "frontier" };
function fixture(status = "pending", approvalTicket = ticket) {
  const sent = [], resolutions = [], opened = [], recorded = [];
  let result = { ...approvalTicket, status, can_decide: true, approval_requirement: {mode: "single", required_approvals: 1,
    reviewers: [{user_id: "owner", display_name: "Ben Cochran", email: "ben@example.com", role: "workflow_creator"}] } };
  const controller = new HumanApprovalController({ send: x => sent.push(x), pollMs: 5,
    read: async () => result,
    record: async event => recorded.push(event),
    openReview: async url => opened.push(url),
    resolve: async (t, decision) => { resolutions.push(decision); result = { ...t, status: decision }; return result; } });
  const abort = new AbortController();
  return { controller, sent, resolutions, opened, recorded, abort, set: x => { result = x; }, wait: () => controller.wait(approvalTicket, { signal: abort.signal }) };
}

for (const [action, status] of [["accept", "approved"], ["decline", "rejected"]]) test(`native ${action} resolves only its ticket`, async () => {
  const f = fixture(); const waiting = f.wait();
  assert.equal(f.wait(), waiting);
  await Promise.resolve();
  const request = f.sent[0];
  assert.equal(request.method, "mcpServer/elicitation/request");
  assert.equal(request.params.serverName, "statewright");
  assert.match(request.params.message, /Approval required by: Ben Cochran <ben@example.com> \(workflow creator\)/);
  assert.equal(f.controller.handleReply({ id: "foreign", result: { action } }), false);
  f.controller.handleReply({ id: request.id, result: { action } });
  f.controller.handleReply({ id: request.id, result: { action } });
  assert.equal((await waiting).status, status);
  assert.deepEqual(f.resolutions, [status]);
  assert.equal(f.sent.at(-1).method, "serverRequest/resolved");
  assert(f.controller.handleReply({ id: request.id, result: { action } }));
  assert.equal(f.resolutions.length, 1);
});

test('authorized approval opens its evidence packet once and links it in the dialog', async () => {
  const f=fixture(); f.set({...ticket,status:'pending',can_decide:true,review_url:'https://statewright.test/approvals/gate',
    approval_requirement:{reviewers:[]}});
  const waiting=f.wait(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.opened,['https://statewright.test/approvals/gate']);
  assert.match(f.sent[0].params.message,/Review evidence: https:\/\/statewright\.test\/approvals\/gate/);
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(f.opened.length,1);
  f.abort.abort(new Error('done')); await assert.rejects(waiting,/done/);
});

test("approval requirement formatting supports a future threshold reviewer list", () => {
  assert.equal(approvalRequirementText({mode: "threshold", required_approvals: 2, reviewers: [
    {display_name: "Release Lead", email: "lead@example.com"},
    {email: "security@example.com"},
    {user_id: "user_3"},
  ]}), "Approval requires 2 of 3 reviewers:\n- Release Lead <lead@example.com>\n- security@example.com\n- user_3");
});

test("website resolution closes native dialog without another decision", async () => {
  const f = fixture(); const waiting = f.wait();
  f.set({ ...ticket, status: "approved" });
  assert.equal((await waiting).status, "approved");
  assert.deepEqual(f.resolutions, []);
});

test("website rejection wins over a late TUI acceptance", async () => {
  const f = fixture(); const waiting = f.wait();
  await Promise.resolve();
  f.set({ ...ticket, status: "rejected" });
  f.controller.handleReply({ id: f.sent[0].id, result: { action: "accept" } });
  assert.equal((await waiting).status, "rejected");
  assert.deepEqual(f.resolutions, []);
});

test("dismissal does not reject or approve the durable ticket", async () => {
  const f = fixture(); const waiting = f.wait();
  await Promise.resolve();
  f.controller.handleReply({ id: f.sent[0].id, result: { action: "cancel" } });
  await assert.rejects(waiting, /dismissed/);
  assert.deepEqual(f.resolutions, []);
});

test("disconnect cancels a wait without resolving", async () => {
  const f = fixture(); const waiting = f.wait(); f.abort.abort(new Error("disconnect"));
  await assert.rejects(waiting, /disconnect/); assert.deepEqual(f.resolutions, []);
});

test("foreign and unavailable responses cannot release a wait", async () => {
  const f = fixture(); const waiting = f.wait();
  f.set({ ...ticket, run_id: "foreign", status: "approved" });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.controller.tickets.size, 1);
  f.abort.abort(new Error("done")); await assert.rejects(waiting, /done/);
});

test("resolver errors leave approval pending", async () => {
  const f = fixture(); f.controller.resolve = async () => { throw new Error("offline"); };
  const waiting = f.wait(); await Promise.resolve(); f.controller.handleReply({ id: f.sent[0].id, result: { action: "accept" } });
  await assert.rejects(waiting, /parked/);
});

for (const capability of [false, undefined]) test(`unauthorized or missing capability ${capability} shows a non-authorizing warning`, async () => {
  const f = fixture(); f.set({...ticket, status:'pending', can_decide:capability,
    authorization:{can_decide:false,reason:'reviewer_mismatch'},
    approval_requirement: {mode: 'single', required_approvals: 1,
      reviewers: [{user_id: 'owner', display_name: 'Ben Cochran', email: 'ben@example.com', role: 'workflow_creator'}]}});
  const waiting = f.wait(); await Promise.resolve();
  const request = f.sent[0];
  assert.equal(request.method, 'warning');
  assert.match(request.params.message, /not an authorized reviewer/);
  assert.match(request.params.message, /Approval required by: Ben Cochran/);
  assert.equal(f.resolutions.length, 0);
  assert.equal(f.controller.tickets.size, 1);
  f.abort.abort(new Error('done')); await assert.rejects(waiting,/done/);
});

test('revoked capability cannot resolve an already displayed approval', async () => {
  const f = fixture(); const waiting = f.wait(); await Promise.resolve();
  const authorized = f.sent[0];
  f.set({...ticket,status:'pending',can_decide:false});
  await new Promise(resolve => setTimeout(resolve, 15));
  const notice = f.sent.findLast(value => value.method === 'warning');
  assert.match(notice.params.message, /current Statewright credentials/);
  f.controller.handleReply({id:authorized.id,result:{action:'accept'}});
  assert.equal(f.resolutions.length,0);
  assert.equal(f.controller.tickets.size,1);
  f.abort.abort(new Error('done')); await assert.rejects(waiting,/done/);
});

test('entitlement denial names the entitlement instead of blaming identity', async () => {
  const f=fixture(); f.set({...ticket,status:'pending',can_decide:false,
    authorization:{can_decide:false,reason:'pro_entitlement_required'},approval_requirement:{reviewers:[]}});
  const waiting=f.wait(); await Promise.resolve();
  assert.equal(f.sent[0].method,'warning');
  assert.match(f.sent[0].params.message,/active Pro entitlement/);
  f.abort.abort(new Error('done')); await assert.rejects(waiting,/done/);
});

test("optional gateway session identity is checked only when the receipt provides it", () => {
  const f = fixture();
  const bound = { ...ticket, run_session_id: "session1" };
  f.controller.verify(bound, { ...ticket, status: "pending" });
  f.controller.verify(bound, { ...bound, status: "approved" });
  f.controller.verify(ticket, { ...bound, status: "rejected" });
  for (const run_session_id of ["foreign", null, ""]) {
    assert.throws(() => f.controller.verify(bound, { ...bound, run_session_id, status: "approved" }), /foreign or malformed/);
  }
  for (const run_session_id of ["", null, 1]) {
    assert.throws(() => f.controller.wait({ ...ticket, run_session_id }, { signal: f.abort.signal }), /run_session_id/);
  }
});

test("foreign session receipt stays parked and records only through the callback", async () => {
  const bound = { ...ticket, run_session_id: "session1" };
  const f = fixture("pending", bound);
  f.set({ ...bound, run_session_id: "foreign", status: "approved" });
  const waiting = f.wait();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.controller.tickets.size, 1);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.resolutions, []);
  assert.deepEqual(f.recorded, [{ type: "approval_read_unavailable", threadId: ticket.threadId, approval_id: ticket.approval_id }]);
  f.abort.abort(new Error("done"));
  await assert.rejects(waiting, /done/);
});

test("foreign session during reply recheck cannot submit a decision", async () => {
  const bound = { ...ticket, run_session_id: "session1" };
  const f = fixture("pending", bound);
  const waiting = f.wait();
  await Promise.resolve();
  f.set({ ...bound, run_session_id: "foreign", status: "pending", can_decide: true });
  f.controller.handleReply({ id: f.sent[0].id, result: { action: "accept" } });
  await assert.rejects(waiting, /parked/);
  assert.deepEqual(f.resolutions, []);
});

test("foreign session decision receipt cannot acknowledge resolution", async () => {
  const bound = { ...ticket, run_session_id: "session1" };
  const f = fixture("pending", bound);
  f.controller.resolve = async () => ({ ...bound, run_session_id: "foreign", status: "approved" });
  const waiting = f.wait();
  await Promise.resolve();
  f.controller.handleReply({ id: f.sent[0].id, result: { action: "accept" } });
  await assert.rejects(waiting, /parked/);
});

test("conflicting duplicate replies and late replies submit exactly one decision", async () => {
  const f = fixture();
  const waiting = f.wait();
  await Promise.resolve();
  const id = f.sent[0].id;
  assert.equal(f.controller.handleReply({ id, result: { action: "accept" } }), true);
  assert.equal(f.controller.handleReply({ id, result: { action: "decline" } }), true);
  assert.equal((await waiting).status, "approved");
  assert.equal(f.controller.handleReply({ id, result: { action: "decline" } }), true);
  assert.deepEqual(f.resolutions, ["approved"]);
});

test("wait deduplication does not conflate gateway sessions", async () => {
  const f = fixture();
  f.controller.read = async t => ({ ...t, status: "pending", can_decide: true });
  const first = f.controller.wait({ ...ticket, run_session_id: "session1" }, { signal: f.abort.signal });
  const second = f.controller.wait({ ...ticket, run_session_id: "session2" }, { signal: f.abort.signal });
  assert.notEqual(first, second);
  assert.equal(f.controller.tickets.size, 2);
  f.abort.abort(new Error("done"));
  await Promise.all([assert.rejects(first, /done/), assert.rejects(second, /done/)]);
});

test("pending snapshots preserve gateway identity and ignore assistant or foreign tool output", () => {
  const state = { run_id: "run1", run_session_id: "session1", state: "review", pending_approval: { approval_id: "apr_test" } };
  const item = { type: "mcpToolCall", server: "statewright", tool: "statewright_get_state", result: { structuredContent: state } };
  assert.deepEqual(pendingApprovalSnapshot(item), state);
  assert.equal(pendingApprovalSnapshot({ ...item, type: "agentMessage" }), null);
  assert.equal(pendingApprovalSnapshot({ ...item, server: "foreign" }), null);
  assert.equal(pendingApprovalSnapshot({ ...item, tool: "foreign" }), null);
  const transition = { status: "pending_approval", approval_id: "apr_test", run_id: "run1", run_session_id: "session1", from: "review", to: "frontier", message: "Review" };
  assert.deepEqual(pendingApprovalSnapshot({ ...item, tool: "statewright_transition",
    result: { content: [{ type: "text", text: "invalid JSON" }, { type: "text", text: JSON.stringify(transition) }] } }),
  { ...state, pending_approval: { approval_id: "apr_test", from_state: "review", to_state: "frontier", message: "Review" } });
});
