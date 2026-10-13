import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionAdapter } from '../hooks/native-execution.mjs';
const encode = x => ({ outcome: { content: [{ type: 'text', text: JSON.stringify(x) }] } });
function fixture() {
  const calls = [], v = { native: { state: { state: 'work', is_final: false } }, requiresEnforcement: true };
  const a = createExecutionAdapter({ view: async () => v, request: async (_, operation, input) => {
    calls.push({ operation, input }); return encode(operation === 'pre_tool' ? { decision: 'allow' } : { active: true });
  }, fault: (_, message) => { v.controlError = message; } });
  return { a, calls, v };
}
test('ordinary tool checks use existing pre/post paths once and preserve native ask', async () => {
  const { a, calls } = fixture();
  const e = { tool: 'Read', tool_use_id: 'one', file_path: '/fixture' };
  const result = { result: 'native', ref: 4 };
  assert.equal(await a.call({}, e, async () => {
    assert.deepEqual(await a.check({}, { tool: 'Read', tool_use_id: 'one', input: { file_path: '/fixture' } }, async () => ({ decision: 'ask', rule: 'Read' })), { decision: 'ask', rule: 'Read' });
    await a.observe({}, { tool_name: 'Read', tool_use_id: 'one', tool_input: { file_path: '/fixture' }, tool_response: 'contents' }, false);
    return result;
  }), result);
  assert.deepEqual(calls.map(c => c.operation), ['pre_tool', 'post_tool']);
  assert.equal(calls[1].input.is_error, false);
});
test('queries and native denies do not create workflow observations', async () => {
  const { a, calls } = fixture();
  assert.deepEqual(await a.check({}, { tool: 'Read', input: {} }, async () => ({ decision: 'allow' })), { decision: 'allow' });
  const result = await a.call({}, { tool: 'Read', tool_use_id: 'one' }, async () => {
    assert.equal((await a.check({}, { tool: 'Read', tool_use_id: 'one', input: {} }, async () => ({ decision: 'deny' }))).decision, 'deny');
    return { deny: 'native' };
  });
  assert.equal(result.deny, 'native'); assert.equal(calls.length, 0);
});
test('failure is not successful evidence; changed executed input is never misattributed', async () => {
  const { a, calls, v } = fixture();
  await a.call({}, { tool: 'Read', tool_use_id: 'one' }, async () => {
    await a.check({}, { tool: 'Read', tool_use_id: 'one', input: { file_path: '/first' } }, async () => ({ decision: 'allow' }));
    await a.observe({}, { tool_name: 'Read', tool_use_id: 'one', tool_input: { file_path: '/changed' }, error: 'failed' }, true);
    return { result: 'failed', isError: true };
  });
  assert.equal(calls[1].input.tool_input.file_path, '/changed');
  assert.equal(calls[1].input.is_error, true);
  assert.match(v.controlError, /changed.*permission/i);
});
test('Off during a native call prevents a late post from changing its replacement', async () => {
  const { a, calls, v } = fixture();
  await a.call({}, { tool: 'Read', tool_use_id: 'one' }, async () => {
    await a.check({}, { tool: 'Read', tool_use_id: 'one', input: {} }, async () => ({ decision: 'allow' }));
    v.generation = 1; v.requiresEnforcement = false; v.native = { state: null };
    await a.observe({}, { tool_name: 'Read', tool_use_id: 'one', tool_input: {}, tool_response: 'done' }, false);
    return { result: 'done' };
  });
  assert.deepEqual(calls.map(c => c.operation), ['pre_tool']);
});
test('resuming a different conversation discards the old tool completion', async () => {
  const old = { requiresEnforcement: true }, calls = [];
  let current = old;
  const a = createExecutionAdapter({ view: async () => current,
    request: async (_, operation) => { calls.push(operation); return encode({ decision: 'allow' }); }, fault: () => {} });
  await a.call({}, { tool: 'Read', tool_use_id: 'one' }, async () => {
    await a.check({}, { tool: 'Read', tool_use_id: 'one', input: {} }, async () => ({ decision: 'allow' }));
    await a.observe({}, { tool_name: 'Read', tool_use_id: 'one', tool_input: {}, tool_response: 'old' }, false);
    current = { requiresEnforcement: true };
    return { result: 'old' };
  });
  assert.deepEqual(calls, ['pre_tool']);
});
test('a nested gateway post-tool error is visible, not successful effect recording', async () => {
  const v = { requiresEnforcement: true };
  const a = createExecutionAdapter({ view: async () => v,
    request: async (_, operation) => operation === 'pre_tool' ? encode({ decision: 'allow' }) : { outcome: { isError: true, content: [] } },
    fault: (_, message) => { v.controlError = message; } });
  await a.call({}, { tool: 'Read', tool_use_id: 'one' }, async () => {
    await a.check({}, { tool: 'Read', tool_use_id: 'one', input: {} }, async () => ({ decision: 'allow' }));
    await a.observe({}, { tool_name: 'Read', tool_use_id: 'one', tool_input: {}, tool_response: 'ok' }, false);
    return { result: 'native' };
  });
  assert.match(v.controlError, /Couldn’t record/);
});
