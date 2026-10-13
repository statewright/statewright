import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionAdapter } from '../hooks/native-execution.mjs';
const encode = x => ({ outcome: { content: [{ type: 'text', text: JSON.stringify(x) }] } });
function fixture(overrides = {}) {
  const calls = [], v = { native: { state: { state: 'work', is_final: false } }, requiresEnforcement: true };
  const dependencies = { view: async () => v,
    after: (ms, callback) => { const timer = setTimeout(callback, ms); return { cancel: () => clearTimeout(timer) }; },
    request: async (_, operation, input) => {
    calls.push({ operation, input }); return encode(operation === 'pre_tool' ? { decision: 'allow' } : { active: true });
  }, fault: (_, message) => { v.controlError = message; }, ...overrides };
  const adapter = () => createExecutionAdapter(dependencies);
  return { a: adapter(), adapter, calls, v };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(setImmediate);
function read(a, id, { before, signal, native = { decision: 'allow' } } = {}) {
  const input = { file_path: `/${id}` };
  const next = async () => {
    const verdict = await a.check({}, { tool: 'Read', tool_use_id: id, input }, async () => native);
    if (verdict.decision === 'deny') return { deny: verdict.reason || 'native' };
    await before?.();
    await a.observe({}, { tool_name: 'Read', tool_use_id: id, tool_input: input, tool_response: id }, false);
    return { result: id };
  };
  next.signal = signal;
  return a.call({}, { tool: 'Read', tool_use_id: id, ...input }, next);
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

test('parallel native Reads queue across adapter instances until each post completes', async () => {
  const post = deferred(), release = deferred(), operations = [];
  const { adapter, v } = fixture({ request: async (_, operation, input) => {
    operations.push(`${operation}:${input.tool_input.file_path}`);
    if (operation === 'post_tool' && input.tool_input.file_path === '/one') { post.resolve(); await release.promise; }
    return encode(operation === 'pre_tool' ? { decision: 'allow' } : { active: true });
  } });
  const one = read(adapter(), 'one'); await post.promise;
  const two = read(adapter(), 'two'), three = read(adapter(), 'three');
  await tick();
  assert.deepEqual(operations, ['pre_tool:/one', 'post_tool:/one']);
  release.resolve();
  assert.deepEqual(await Promise.all([one, two, three]), [{ result: 'one' }, { result: 'two' }, { result: 'three' }]);
  assert.deepEqual(operations, ['pre_tool:/one', 'post_tool:/one', 'pre_tool:/two', 'post_tool:/two', 'pre_tool:/three', 'post_tool:/three']);
  assert.equal(v.runningTool, null);
});

test('queued native denial keeps its permission verdict and the next Read can proceed', async () => {
  const { adapter, calls } = fixture(), release = deferred();
  const one = read(adapter(), 'one', { before: () => release.promise }); await tick();
  const denied = read(adapter(), 'denied', { native: { decision: 'deny', reason: 'organization policy' } });
  const three = read(adapter(), 'three'); await tick(); release.resolve();
  assert.deepEqual(await Promise.all([one, denied, three]), [{ result: 'one' }, { deny: 'organization policy' }, { result: 'three' }]);
  assert.deepEqual(calls.map(c => c.input.tool_input.file_path), ['/one', '/one', '/three', '/three']);
});

for (const change of ['generation', 'off', 'conversation']) test(`queued Read fails closed after ${change} changes`, async () => {
  const first = { requiresEnforcement: true, generation: 0 };
  let current = first;
  const { adapter, calls } = fixture({ view: async () => current }), release = deferred();
  const one = read(adapter(), 'one', { before: () => release.promise }); await tick();
  const two = read(adapter(), 'two'); await tick();
  if (change === 'conversation') current = { requiresEnforcement: false, generation: 0 };
  else if (change === 'off') { first.generation++; first.requiresEnforcement = false; }
  else first.generation++;
  release.resolve(); await one;
  assert.match((await two).deny, /changed|superseded/i);
  assert.deepEqual(calls.map(c => c.operation), ['pre_tool']);
  assert.equal(first.runningTool, null);
});

test('aborting a queued Read removes it without releasing or executing the active Read', async () => {
  const { adapter, calls, v } = fixture(), release = deferred(), controller = new AbortController();
  const one = read(adapter(), 'one', { before: () => release.promise }); await tick();
  const cancelled = read(adapter(), 'cancelled', { signal: controller.signal }); await tick();
  controller.abort();
  assert.match((await cancelled).deny, /cancel/i);
  assert.equal(v.runningTool.id, 'one');
  const three = read(adapter(), 'three'); await tick(); release.resolve();
  assert.deepEqual(await Promise.all([one, three]), [{ result: 'one' }, { result: 'three' }]);
  assert.deepEqual(calls.map(c => c.input.tool_input.file_path), ['/one', '/one', '/three', '/three']);
});

test('an already cancelled Read does not start native execution', async () => {
  const { a, calls } = fixture(), controller = new AbortController(); controller.abort();
  assert.match((await read(a, 'cancelled', { signal: controller.signal })).deny, /cancel/i);
  assert.deepEqual(calls, []);
});

test('Read queue admits at most 32 waiters and rejects duplicate invocation identities', async () => {
  const { adapter, v } = fixture(), release = deferred();
  const one = read(adapter(), 'one', { before: () => release.promise }); await tick();
  const waiting = Array.from({ length: 32 }, (_, i) => read(adapter(), `queued-${i}`)); await tick();
  assert.match((await read(adapter(), 'queued-0')).deny, /identity|already/i);
  assert.match((await read(adapter(), 'overflow')).deny, /queue.*full|limit/i);
  assert.equal(v.runningTool.id, 'one'); release.resolve();
  assert.ok((await Promise.all([one, ...waiting])).every(r => r.result));
  assert.equal(v.runningTool, null);
});

test('a queued Read times out without releasing an unfinished native call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { adapter, v } = fixture(), release = deferred();
  const one = read(adapter(), 'one', { before: () => release.promise }); await tick();
  const waiting = read(adapter(), 'waiting'); await tick();
  t.mock.timers.tick(60_001);
  assert.match((await waiting).deny, /timed out/i);
  assert.equal(v.runningTool.id, 'one'); release.resolve(); await one;
  assert.equal(v.runningTool, null);
});

test('a thrown native call releases its slot for the next queued Read', async () => {
  const { adapter, v } = fixture(), release = deferred(), failure = new Error('native failure');
  const first = adapter().call({}, { tool: 'Read', tool_use_id: 'one' }, async () => { await release.promise; throw failure; });
  const rejected = assert.rejects(first, error => error === failure); await tick();
  const two = read(adapter(), 'two'); await tick(); release.resolve();
  await rejected; assert.deepEqual(await two, { result: 'two' }); assert.equal(v.runningTool, null);
});

test('post cleanup failure releases the slot and denies pending Reads without losing the native result', async () => {
  const release = deferred(), post = deferred(), operations = [];
  const { adapter, v } = fixture({ request: async (_, operation) => {
    operations.push(operation);
    if (operation === 'post_tool') { post.resolve(); await release.promise; throw new Error('post failed'); }
    return encode({ decision: 'allow' });
  } });
  const one = read(adapter(), 'one'); await post.promise;
  const two = read(adapter(), 'two'); await tick(); release.resolve();
  assert.deepEqual(await one, { result: 'one' });
  assert.match((await two).deny, /record|refresh/i);
  assert.deepEqual(operations, ['pre_tool', 'post_tool']); assert.equal(v.runningTool, null);
});

test('Reads do not queue behind a mutating tool, and mutations do not enter the Read queue', async () => {
  const { adapter } = fixture(), release = deferred();
  let entered = false;
  const mutation = adapter().call({}, { tool: 'Write', tool_use_id: 'write' }, () => release.promise); await tick();
  assert.match((await read(adapter(), 'read')).deny, /one tool at a time/);
  release.resolve({ result: 'write' }); await mutation;
  const reading = deferred(), one = read(adapter(), 'one', { before: () => reading.promise }); await tick();
  assert.match((await adapter().call({}, { tool: 'Write', tool_use_id: 'write-two' }, async () => { entered = true; })).deny, /one tool at a time/);
  assert.equal(entered, false); reading.resolve(); await one;
});

test('a queued Read obtains a fresh workflow policy decision when it starts', async () => {
  const release = deferred(), operations = [];
  const { adapter } = fixture({ request: async (_, operation, input) => {
    operations.push(`${operation}:${input.tool_input.file_path}`);
    return encode(operation === 'pre_tool' ? { decision: input.tool_input.file_path === '/two' ? 'deny' : 'allow', reason: 'Read limit reached' } : {});
  } });
  const one = read(adapter(), 'one', { before: () => release.promise }); await tick();
  const two = read(adapter(), 'two'); await tick(); release.resolve(); await one;
  assert.deepEqual(await two, { deny: 'Read limit reached' });
  assert.deepEqual(operations, ['pre_tool:/one', 'post_tool:/one', 'pre_tool:/two']);
});

test('cancellation during pre_tool cannot grant permission to execute', async () => {
  const controller = new AbortController();
  const { a } = fixture({ request: async () => { controller.abort(); return encode({ decision: 'allow' }); } });
  let executed = false;
  assert.match((await read(a, 'one', { signal: controller.signal, before: () => { executed = true; } })).deny, /cancel/i);
  assert.equal(executed, false);
});

test('missing completion and a throwing fault reporter still settle the queued Read', async () => {
  const release = deferred(), failure = new Error('fault reporter failed');
  const { adapter, v } = fixture({ fault: () => { throw failure; } });
  const first = adapter().call({}, { tool: 'Read', tool_use_id: 'one' }, async () => {
    await adapter().check({}, { tool: 'Read', tool_use_id: 'one', input: {} }, async () => ({ decision: 'allow' }));
    await release.promise;
    return { result: 'no completion event' };
  });
  const rejected = assert.rejects(first, error => error === failure); await tick();
  const two = read(adapter(), 'two'); await tick(); release.resolve(); await rejected;
  assert.match((await two).deny, /record|refresh/i); assert.equal(v.runningTool, null);
});

for (const change of ['off', 'generation', 'conversation', 'cancel']) test(`delayed native permission cannot authorize a Read after ${change}`, async () => {
  const original = { requiresEnforcement: true, generation: 0 };
  let current = original;
  const { adapter, calls } = fixture({ view: async () => current });
  const permission = deferred(), entered = deferred(), controller = new AbortController();
  let verdict;
  const next = async () => {
    verdict = await adapter().check({}, { tool: 'Read', tool_use_id: 'one', input: {} }, async () => {
      entered.resolve(); return permission.promise;
    });
    return verdict.decision === 'deny' ? { deny: verdict.reason } : { result: 'would execute' };
  };
  next.signal = controller.signal;
  const pending = adapter().call({}, { tool: 'Read', tool_use_id: 'one' }, next); await entered.promise;
  if (change === 'off') { original.generation++; original.requiresEnforcement = false; }
  else if (change === 'generation') original.generation++;
  else if (change === 'conversation') current = { requiresEnforcement: false, generation: 0 };
  else controller.abort();
  permission.resolve({ decision: 'allow' });
  assert.match((await pending).deny, /changed|cancel/i);
  assert.equal(verdict.decision, 'deny'); assert.deepEqual(calls, []);
  assert.equal(original.runningTool, null);
});

test('a delayed native denial remains authoritative after Off', async () => {
  const { adapter, v, calls } = fixture(), permission = deferred(), entered = deferred();
  const native = { decision: 'deny', reason: 'organization policy', rule: 'Read' };
  const pending = adapter().call({}, { tool: 'Read', tool_use_id: 'one' }, async () => {
    const verdict = await adapter().check({}, { tool: 'Read', tool_use_id: 'one', input: {} }, async () => {
      entered.resolve(); return permission.promise;
    });
    assert.equal(verdict, native); return { deny: verdict.reason };
  });
  await entered.promise; v.generation = 1; v.requiresEnforcement = false; v.native = null;
  permission.resolve(native); assert.deepEqual(await pending, { deny: native.reason }); assert.deepEqual(calls, []);
});
