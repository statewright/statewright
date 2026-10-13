import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeControl, decodeNativeControl, decodeNativeConnection, executionReadiness, progressNodes } from '../hooks/native-control.mjs';

const one = '11111111-1111-4111-8111-111111111111';
const two = '22222222-2222-4222-8222-222222222222';
const revision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const newer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const content = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const state = () => ({ workflow: 'bugfix', state: 'intake', is_final: false, transition_count: 0,
  transitions: [{ event: 'NEXT', target: 'inspect' }], allowed_tools: ['Read'] });
const receipt = overrides => ({ protocol_version: 1, conversation_id: one, revision, state: null, outcome: null,
  capabilities: { workflow_control: true, native_tool_enforcement: false, human_approval: false, model_routing: false }, ...overrides });
function host() {
  const h = { id: one, calls: [], result: receipt(), call: null };
  h.controller = createNativeControl({ conversation: async () => h.id, call: async args => {
    h.calls.push(args); return content(h.call ? await h.call(args) : h.result);
  } });
  return h;
}

test('connection snapshot is same-chat read-only and seeds control without another tool call', async () => {
  const h = host();
  const value = { protocol_version: 1, conversation_id: one, workflows: ['bugfix'], snapshot: receipt() };
  assert.deepEqual(decodeNativeConnection(content(value), one).workflows, ['bugfix']);
  await h.controller.acceptConnection(content(value));
  assert.equal((await h.controller.snapshot()).revision, revision);
  assert.equal(h.calls.length, 0);
  for (const patch of [{ conversation_id: two }, { approved: true }, { protocol_version: 2 },
    { workflows: ['bad\nname'] }, { snapshot: receipt({ conversation_id: two }) },
    { snapshot: receipt({ outcome: content({ approved: true }) }) }]) {
    assert.throws(() => decodeNativeConnection(content({ ...value, ...patch }), one));
  }
  h.id = two;
  await assert.rejects(h.controller.acceptConnection(content(value)));
  assert.equal(await h.controller.snapshot(), null);
});

test('native control validates ownership, version, revision, capabilities and nested state', () => {
  assert.equal(decodeNativeControl(content(receipt({ state: state() })), one).state.state, 'intake');
  for (const replacement of [
    { conversation_id: two }, { protocol_version: 2 }, { revision: 'unknown' },
    { workflow_aliases: null }, { workflow_aliases: { engineering: 'other' } },
    { state: {} }, { state: { ...state(), state: 'bad\x1b[31m' } },
    { state: { ...state(), transitions: [{ event: 'NEXT', target: null }] } },
    { state: { ...state(), transitions: [{ event: 'NEXT', target: 'inspect' }, { event: 'NEXT', target: 'other' }] } },
    { state: { ...state(), pending_approval: { approval_id: 'ticket' } } },
    { capabilities: { workflow_control: true } }, { outcome: { isError: 'false', content: [] } },
  ]) assert.throws(() => decodeNativeControl(content(receipt(replacement)), one));
  for (const value of [{ isError: true, ...content(receipt()) }, { content: [] },
    { content: [{ type: 'text', text: 'x'.repeat(262145) }] }, { content: [{ type: 'text', text: '{' }] }])
    assert.throws(() => decodeNativeControl(value, one));
});
test('workflow-control support never implies execution enforcement or model routing', () => {
  const s = receipt();
  assert.equal(executionReadiness(s, true).available, false);
  s.capabilities.native_tool_enforcement = true;
  assert.equal(executionReadiness(s, true).available, false);
  s.capabilities.human_approval = true;
  assert.equal(executionReadiness(s, false).available, false);
  assert.equal(executionReadiness(s, true).available, true);
  assert.equal(s.capabilities.model_routing, false);
  assert.equal(executionReadiness(null, true).available, false);
});
test('a held approval without optional message stays readable and held', () => {
  const s = { ...state(), pending_approval: { approval_id: 'ticket', event: 'NEXT',
    from_state: 'intake', to_state: 'inspect', message: null } };
  const decoded = decodeNativeControl(content(receipt({ state: s })), one);
  assert.equal(decoded.state.pending_approval.message, null);
  assert.equal(progressNodes(decoded).pending, true);
  assert.equal(executionReadiness(decoded, true).available, false);
});
test('host supplies conversation; mutations require the exact displayed revision', async () => {
  const h = host();
  await assert.rejects(h.controller.request({ operation: 'load_workflow', input: { name: 'bugfix' }, expectedRevision: revision }));
  const initial = await h.controller.request({ operation: 'get_state', input: {} });
  assert.equal(initial.revision, revision);
  assert.deepEqual(h.calls[0].context, { version: 1, conversation_id: one });
  await assert.rejects(h.controller.request({ operation: 'deactivate', input: {}, expectedRevision: newer }));
  assert.equal(h.calls.length, 1);
  h.result = receipt({ state: state(), revision: newer, outcome: { content: [{ type: 'text', text: 'loaded' }] } });
  const loaded = await h.controller.request({ operation: 'load_workflow', input: { name: 'bugfix' }, expectedRevision: revision });
  assert.equal(loaded.state.state, 'intake');
  assert.equal(h.calls[1].expected_revision, revision);
  assert.ok(Object.isFrozen(loaded));
  assert.ok(Object.isFrozen(loaded.capabilities));
});
test('unknown fields, approval decisions and alternate-session inputs never dispatch', async () => {
  const h = host(); await h.controller.request({ operation: 'get_state', input: {} });
  for (const action of [
    { operation: 'approve', input: {} },
    { operation: 'get_state', input: {}, context: { conversation_id: two } },
    { operation: 'load_workflow', input: { name: 'bugfix', resume: true } },
    { operation: 'load_workflow', input: { name: 'bugfix', run_id: 'foreign' } },
    { operation: 'transition', input: { event: 'NEXT', approved: true } },
    { operation: 'transition', input: { event: 'NEXT', data: [] } },
    { operation: 'deactivate', input: { session_id: two } },
  ]) await assert.rejects(h.controller.request({ ...action, expectedRevision: revision }));
  assert.equal(h.calls.length, 1);
});
test('failed nested tool result is retained as a failure, with new state and revision', async () => {
  const h = host(); await h.controller.request({ operation: 'get_state', input: {} });
  h.result = receipt({ revision: newer, state: state(), outcome: { isError: true,
    content: [{ type: 'text', text: 'Transition held for approval' }] } });
  const result = await h.controller.request({ operation: 'transition', input: { event: 'NEXT' }, expectedRevision: revision });
  assert.equal(result.outcome.isError, true);
  assert.equal(result.revision, newer);
  assert.equal((await h.controller.snapshot()).revision, newer);
  await assert.rejects(h.controller.request({ operation: 'transition', input: { event: 'NEXT' }, expectedRevision: revision }));
  assert.equal(h.calls.length, 2);
});
test('uncertain network outcome invalidates the mutation revision; no automatic retry', async () => {
  const h = host(); await h.controller.request({ operation: 'get_state', input: {} });
  h.call = async () => { throw new Error('Disconnected after dispatch'); };
  await assert.rejects(h.controller.request({ operation: 'load_workflow', input: { name: 'bugfix' }, expectedRevision: revision }));
  assert.equal(await h.controller.snapshot(), null);
  await assert.rejects(h.controller.request({ operation: 'load_workflow', input: { name: 'bugfix' }, expectedRevision: revision }));
  assert.equal(h.calls.length, 2);
});
test('a changed conversation discards a late result and cannot reuse the prior revision', async () => {
  const h = host(); let release;
  h.call = () => new Promise(resolve => { release = resolve; });
  const read = h.controller.request({ operation: 'get_state', input: {} });
  await new Promise(setImmediate);
  h.id = two; release(receipt()); await assert.rejects(read);
  assert.equal(await h.controller.snapshot(), null);
  await assert.rejects(h.controller.request({ operation: 'deactivate', input: {}, expectedRevision: revision }));
});
test('simultaneous calls are not queued or silently repeated', async () => {
  const h = host(); let release;
  h.call = () => new Promise(resolve => { release = resolve; });
  const read = h.controller.request({ operation: 'get_state', input: {} });
  await new Promise(setImmediate);
  await assert.rejects(h.controller.request({ operation: 'get_state', input: {} }));
  release(receipt()); await read;
  assert.equal(h.calls.length, 1);
});
test('malformed mutation receipts invalidate state; a successful outer MCP envelope is insufficient', async () => {
  for (const result of [receipt({ state: state(), outcome: null }), receipt({ revision, state: state(), outcome: { content: [] } })]) {
    const h = host(); await h.controller.request({ operation: 'get_state', input: {} });
    h.result = result;
    await assert.rejects(h.controller.request({ operation: 'load_workflow', input: { name: 'bugfix' }, expectedRevision: revision }));
    assert.equal(await h.controller.snapshot(), null);
  }
});
test('progress shows known current and possible next states, never invented history or permissions', () => {
  assert.equal(progressNodes(receipt()), null);
  const nodes = progressNodes(receipt({ state: { ...state(), transitions: [
    { event: 'NEXT', target: 'inspect' }, { event: 'BLOCKED', target: 'blocked' }, { event: 'SKIP', target: 'done' },
  ] } }));
  assert.deepEqual(nodes, { current: 'intake', next: ['inspect', 'blocked', 'done'], more: 0, final: false, pending: false });
});
