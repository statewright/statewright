import assert from 'node:assert/strict';
import test from 'node:test';
import { resultSummary, registerResultUI } from '../hooks/result-ui.mjs';

test('only the completed card owns its result; interruption revokes ownership', async () => {
  const hooks = {};
  const $ = { session: { id: async () => 'session' }, ui: { invalidate() {}, resolve: () =>
    Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, props => ({ type, props })])) } };
  registerResultUI((_, matcher, fn) => { hooks[matcher.component] = fn; }, '#BA97ED');
  const e = { surface: 'terminal', props: { tool: 'mcp__statewright__statewright_get_state',
    tool_use_id: 'one', output: '{"status":"ok"}', input: {}, isErrored: false, isRunning: false, isInterrupted: false } };
  const native = () => 'native';
  assert.equal(await hooks.ToolResult($, e, native), 'native');
  await hooks.ToolUse($, e, native);
  assert.deepEqual((await hooks.ToolResult($, e, native)).props.children, []);
  assert.equal(await hooks.ToolResult($, { ...e, surface: 'desktop' }, native), 'native');
  for (const flag of ['isInterrupted', 'isRunning', 'isErrored']) {
    await hooks.ToolUse($, e, native);
    assert.equal(await hooks.ToolUse($, { ...e, props: { ...e.props, [flag]: true } }, native), 'native');
    assert.equal(await hooks.ToolResult($, e, native), 'native');
  }
});

test('summary selects only requested facts from the exact historical result', () => {
  const source = { state: { state: 'review', allowed_tools: ['Read', 'Grep'] },
    outcome: { content: [{ type: 'text', text: JSON.stringify({ status: 'blocked', decision: 'ask', reason: 'Approval required' }) }] },
    protocol_version: 1, revision: 'private-revision', capabilities: { model_routing: false }, customField: 42 };
  const bytes = JSON.stringify(source), s = resultSummary(bytes);
  assert.deepEqual(s.rows.map(r => [r.label, r.value]), [
    ['State', 'review'], ['Outcome', 'blocked'], ['Allowed tools', 'Read, Grep'],
    ['Disposition', 'ask'], ['Reasoning', 'Approval required'],
  ]);
  assert.equal(JSON.stringify(source), bytes);
  assert.equal(resultSummary('{"state":"other"}').rows[0].value, 'other');
  assert.equal(s.rows[0].value, 'review');
});
test('no workflow and empty allowed tools are explicit, missing outcome is not success', () => {
  assert.deepEqual(resultSummary({ state: null, outcome: null }).rows.map(r => [r.label, r.value]), [['State', 'No active workflow']]);
  assert.equal(resultSummary({ state: { state: 'end', allowed_tools: [] } }).rows[1].value, 'None');
  assert.deepEqual(resultSummary({ status: 'connection_required', message: 'Connect to continue', workflows: [] }).rows.map(r => [r.label, r.value]),
    [['Outcome', 'connection_required'], ['Reasoning', 'Connect to continue']]);
});
test('transition state is before => after from this successful receipt only', () => {
  const transition = { transitioned: true, from: 'intake', to: 'localize' };
  const receipt = { state: { state: 'localize', allowed_tools: ['Read'] },
    outcome: { content: [{ type: 'text', text: JSON.stringify(transition) }], isError: false } };
  const s = resultSummary(receipt);
  assert.equal(s.rows[0].value, 'intake => localize');
  assert.equal(s.rows[1].value, 'Transitioned');
  assert.equal(resultSummary(transition).rows[0].value, 'intake => localize');
  assert.equal(resultSummary({ state: { state: 'localize' }, outcome: null }).rows[0].value, 'localize');
  for (const outcome of [{ ...transition, transitioned: false }, { ...transition, isError: true },
    { ...transition, error: 'Denied' }, { ...transition, from: undefined }, { from: 'intake', to: 'localize' }])
    assert.equal(resultSummary({ ...receipt, outcome }).rows[0].value, 'localize');
  assert.equal(resultSummary({ ...receipt, state: { state: 'intake', pending_approval: { from_state: 'intake', to_state: 'localize' } } }).rows[0].value, 'intake');
  assert.equal(resultSummary({ ...receipt, state: { state: 'review' } }).rows[0].value, 'review');
  assert.equal(s.rows[0].value, 'intake => localize', 'later calls cannot rewrite historical presentation');
});
test('nested failures and pending approval cannot masquerade as success', () => {
  const s = resultSummary({ state: { state: 'review', pending_approval: { message: 'Approve the release' } },
    outcome: { isError: true, content: [{ type: 'text', text: 'Permission denied' }] } });
  assert.deepEqual(s.rows.map(r => [r.label, r.value]), [
    ['State', 'review'], ['Outcome', 'Error'], ['Disposition', 'Awaiting approval'], ['Reasoning', 'Permission denied · Approve the release'],
  ]);
  assert.ok(s.rows.find(r => r.label === 'Outcome').attention);
  assert.ok(resultSummary({ error: 'No access', status: 'ok' }).rows.some(r => r.value.includes('No access')));
});
test('bounded previews retain controls safety and full result carries omitted detail', () => {
  const s = resultSummary({ state: 'test', reason: 'x'.repeat(1000), allowed_tools: Array.from({ length: 50 }, (_, i) => `tool${i}`) });
  assert.ok(s.rows.length <= 5);
  assert.ok(s.rows.every(r => r.value.length <= 240));
  assert.match(s.rows.at(-1).value, /…$/);
  assert.doesNotMatch(resultSummary({ reason: '\x1b[31m\nunsafe\u202e' }).rows[0].value, /[\x1b\n\u202e]/);
});
test('unrecognized native/media/error outputs retain native renderer', () => {
  for (const value of ['bad JSON', 'true', 'null', '[]', 'x'.repeat(131073), { custom: 3 },
    { isError: true, content: [] }, { content: [{ type: 'image', data: 'not-json' }] },
    { content: [{ type: 'text', text: '{}' }, { type: 'text', text: 'important' }] },
    { state: 'review', outcome: { content: [{ type: 'image', data: 'not-json' }] } }])
    assert.equal(resultSummary(value), null);
  assert.equal(resultSummary({ content: [{ type: 'text', text: '{"state":"test"}' }] }).rows[0].value, 'test');
});
