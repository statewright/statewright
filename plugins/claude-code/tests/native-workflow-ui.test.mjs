import assert from 'node:assert/strict';
import test from 'node:test';
import { observeJourney, graphRows, statusPresentation, modelPresentation } from '../hooks/workflow-ui.mjs';

const snapshot = (state = 'localize', count = 1, extra = {}) => ({ conversation_id: 'chat',
  state: { workflow: 'canary', run_id: 'run', state, transition_count: count, is_final: false,
    transitions: [{ event: 'BLOCKED', target: 'blocked' }, { event: 'LOCALIZED', target: 'baseline' }], ...extra } });

test('single status uses actual events, not a branch count or target names', () => {
  const p = statusPresentation({ connected: true, native: snapshot() });
  assert.equal(p.status, 'localize');
  assert.equal(p.tail, ' events: :blocked | :localized >');
  assert.equal(p.powerline, false);
  assert.equal(statusPresentation({}, { powerline: true }).powerline, true);
  assert.equal(statusPresentation({}, { powerline: false }).powerline, false);
  assert.equal(statusPresentation({}, { surface: 'desktop' }).powerline, false);
  assert.equal(statusPresentation({ connected: true, native: snapshot() }, { powerline: true }).tail,
    ' events: :blocked | :localized ');
  assert.equal(statusPresentation({ connected: true, native: snapshot() }, { powerline: true, surface: 'desktop' }).tail,
    ' events: :blocked | :localized >');
});
test('pending approval and errors win over decorative next steps', () => {
  const pending = statusPresentation({ connected: true, native: snapshot('review', 1, { pending_approval: {} }) });
  assert.match(pending.status, /Needs your decision/); assert.equal(pending.tail, '');
  assert.equal(pending.attention, true);
  assert.equal(statusPresentation({ connected: true, native: snapshot('very-long-review-state', 1,
    { pending_approval: {} }) }, { compact: true }).status, 'Review needed');
  assert.equal(statusPresentation({ connected: true, native: snapshot(), controlError: 'Failed' }).tail, '');
  assert.match(statusPresentation({ busy: true, interactive: true }).status, /Connecting/);
});
test('observed graph links visits and events without fabricating past states', () => {
  const first = observeJourney(null, snapshot('intake', 0));
  const next = observeJourney(first, snapshot());
  assert.deepEqual(graphRows(snapshot(), next).map(r => r.text), [
    '○ intake', '│', '● localize', '├─ :blocked → ○ blocked', '└─ :localized → ○ baseline',
  ]);
  assert.equal(observeJourney(next, snapshot()), next, 'ordinary tools do not add visits');
  assert.deepEqual(graphRows(snapshot(), null).map(r => r.text).slice(0, 1), ['● localize']);
});
test('history is bounded and isolates restart, new run, conversation, Off and gaps', () => {
  let history = null;
  for (let i = 0; i < 9; i++) history = observeJourney(history, snapshot(`state-${i}`, i));
  assert.equal(history.entries.length, 5); assert.equal(history.entries[0].count, 4);
  const skipped = observeJourney(history, snapshot('later', 11));
  assert.ok(graphRows(snapshot('later', 11), skipped).some(r => r.text === '┊  …'));
  assert.equal(observeJourney(history, snapshot('intake', 0)).entries.length, 1);
  assert.equal(observeJourney(history, snapshot('intake', 9, { run_id: 'other' })).entries.length, 1);
  assert.equal(observeJourney(history, { ...snapshot(), conversation_id: 'other' }).entries.length, 1);
  assert.equal(observeJourney(history, { state: null }), null);
  const unknown = observeJourney(null, snapshot('earlier', 0, { run_id: undefined }));
  assert.deepEqual(observeJourney(unknown, snapshot('later', 1, { run_id: undefined })).entries,
    [{ state: 'later', count: 1, gap: false }], 'unknown run identity cannot join separate runs');
  assert.equal(graphRows(snapshot('done', 12, { is_final: true }), null).length, 1);
});
test('wide branching remains bounded without implying hidden branches do not exist', () => {
  const s = snapshot('branch', 0, { transitions: Array.from({ length: 30 }, (_, i) => ({ event: `E${i}`, target: `T${i}` })) });
  assert.match(statusPresentation({ connected: true, native: s }).tail, / \| … >$/);
  assert.equal(graphRows(s, null).length, 10);
  assert.match(graphRows(s, null).at(-1).text, /22 more/);
  assert.doesNotMatch(graphRows(s, null).at(-1).text, /Next step/);
});

test('model display separates next route from streaming request and omits stale Off/final routes', () => {
  const view = { connected: true, native: snapshot('intake', 0, { model: 'luna', thinking_level: 'low' }) };
  assert.equal(modelPresentation(view), 'next Haiku 5.5 / low');
  assert.equal(modelPresentation(view, true), '→Haiku/low');
  const running = { ...view, modelActivity: { model: 'claude-haiku-5-5', effort: 'low' } };
  assert.equal(modelPresentation(running), 'Haiku 5.5 / low · running');
  // The request still owns the stream even if its tool transitions or turns Off.
  assert.equal(modelPresentation({ ...running, native: snapshot('review', 1, { model: 'astra', thinking_level: 'high' }) }),
    'Haiku 5.5 / low · running');
  assert.equal(modelPresentation({ ...running, native: null }), 'Haiku 5.5 / low · running');
  assert.equal(modelPresentation({ ...view, native: null }), '');
  assert.equal(modelPresentation({ ...view, native: snapshot('done', 1, { is_final: true, model: 'luna' }) }), '');
  assert.equal(modelPresentation({ ...view, native: snapshot('review', 1, { model: 'astra', thinking_level: 'high' }) }),
    'next Fable 5.1 / high');
  assert.equal(modelPresentation({ modelActivity: { model: 'claude-opus-5-5', effort: 'high' } }), 'Opus 5.5 / high · running');
  assert.equal(modelPresentation({}), '');
});
test('model display preserves errors, unknown/default effort and compact width priority', () => {
  const view = { connected: true, native: snapshot('implementation-long', 0, { model: 'sol' }) };
  assert.equal(modelPresentation(view), 'next Opus 5.5 / default');
  assert.equal(modelPresentation({ modelActivity: { model: 'custom-native-model', effort: 42 } }),
    'custom-native-model / 42 · running');
  assert.equal(modelPresentation({ ...view, routeError: 'No response' }), '');
  assert.equal(modelPresentation({ ...view, busy: true }), '');
  assert.equal(modelPresentation({ ...view, actionBusy: true }), '');
  assert.equal(modelPresentation({ ...view, native: snapshot('x', 0, { model: 'unsupported' }) }), '');
  const compact = statusPresentation(view, { compact: true });
  assert.equal(compact.status, 'impleme…'); assert.equal(compact.model, '→Opus/default');
  const running = { ...view, modelActivity: { model: 'claude-sonnet-5-5', effort: 'medium' } };
  for (const columns of [32, 54, 55, 60]) {
    const fitting = statusPresentation(running, { columns });
    assert.equal(fitting.compact, true); assert.equal(fitting.model, 'Sonnet/medium…');
    assert.ok(3 + fitting.status.length + fitting.model.length + 7 <= columns);
  }
  assert.equal(statusPresentation(running, { columns: 100 }).compact, false);
  const idle = statusPresentation({ ...view, native: snapshot('implementation-long', 1,
    { model: 'terra', thinking_level: 'medium' }) }, { columns: 32 });
  assert.equal(idle.model, '→Sonnet/medium'); assert.equal(idle.tail, '');
  assert.ok(3 + idle.status.length + idle.model.length + 7 <= 32);
  const blocked = statusPresentation({ ...view, routeError: 'No response' });
  assert.equal(blocked.status, 'Needs attention'); assert.equal(blocked.attention, true); assert.equal(blocked.tail, '');
});

test('idle and completed views keep the host selection, never a stale workflow model', () => {
  const view = { connected: true, selectedModel: 'claude-opus-5-5' };
  assert.equal(modelPresentation(view), 'Opus 5.5');
  assert.equal(modelPresentation({ ...view, native: snapshot('done', 9, { is_final: true, model: 'astra' }) }), 'Opus 5.5');
  assert.equal(modelPresentation({ ...view, baseRequest: { model: 'claude-opus-5-5', effort: 'high' } }), 'Opus 5.5 / high');
  assert.equal(modelPresentation({ ...view, selectedModel: 'claude-haiku-5-5', baseRequest: { model: 'claude-opus-5-5', effort: 'high' } }), 'Haiku 5.5');
  assert.equal(modelPresentation({ ...view, native: snapshot('review', 8, { model: 'astra', thinking_level: 'high' }) }), 'next Fable 5.1 / high');
  assert.equal(modelPresentation({ ...view, selectedModel: undefined }), '');
});
