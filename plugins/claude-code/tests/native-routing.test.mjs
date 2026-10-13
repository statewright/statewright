import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeRoute, routeEvent, routeReceipt } from '../hooks/native-routing.mjs';

test('confirmed Claude equivalents include Luna and Astra, never reverse Astra/Fable', () => {
  for (const [model, thinking_level, expected] of [
    ['luna', 'medium', 'claude-haiku-5-5'], ['openai-codex/gpt-6-luna', 'low', 'claude-haiku-5-5'],
    ['openai-codex/gpt-5.6-terra', 'low', 'claude-haiku-5-5'], ['gpt-5.6-terra', 'medium', 'claude-sonnet-5-5'],
    ['openai/gpt-6.1-sol', 'high', 'claude-opus-5-5'], ['openai-codex/gpt-6-astra', 'high', 'claude-fable-5-1'],
    ['anthropic/claude-sonnet-4-6', 'medium', 'claude-sonnet-4-6'], ['fable', 'max', 'claude-fable-5-1'],
    ['anthropic/haiku-5-5', 'low', 'claude-haiku-5-5'], ['sonnet-5-5', 'xhigh', 'claude-sonnet-5-5'],
    ['haiku-4-5-20251001', 'low', 'claude-haiku-4-5-20251001'],
  ]) assert.equal(claudeRoute({ model, thinking_level }).model, expected);
});
test('no active/final/model route passes; unknown provider, model or effort is not guessed', () => {
  for (const state of [null, { is_final: true, model: 'unknown' }, {}]) assert.equal(claudeRoute(state), null);
  for (const state of [{ model: 'ollama/luna' }, { model: 'gpt-unknown' }, { model: 'astra-typo' },
    { model: 'sol', thinking_level: 'potato' }]) assert.throws(() => claudeRoute(state));
});
test('per-request route uses native IDs and retains current-model effort without changing baseline', () => {
  const original = Object.freeze({ turnId: 't', index: 2, model: 'claude-opus-5-5', effort: 'max', messageCount: 8 });
  const haiku = routeEvent(original, claudeRoute({ model: 'luna', thinking_level: 'low' }));
  assert.equal(haiku.model, 'claude-haiku-5-5'); assert.equal(haiku.effort, 'low');
  assert.equal(original.effort, 'max');
  assert.equal(routeEvent(original, null), original);
  assert.equal(routeEvent(original, claudeRoute({ model: 'sol', thinking_level: 'medium' })).effort, 'medium');
  assert.equal(routeEvent(original, claudeRoute({ model: 'sol' })).effort, undefined);
  for (const family of ['haiku', 'sonnet', 'opus', 'fable']) {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      for (const model of [family, `claude-${family}`, `anthropic/${family}`]) {
        const routed = routeEvent(original, claudeRoute({ model, thinking_level: level }));
        assert.match(routed.model, /^claude-(haiku|sonnet|opus|fable)-\d/);
        assert.equal(routed.effort, level);
      }
    }
  }
});
test('receipts distinguish observed, missing and mismatched provider evidence without payloads', () => {
  const route = claudeRoute({ model: 'luna', thinking_level: 'low' });
  const event = { turnId: 't', index: 1, model: 'opus' };
  const usage = { model: 'claude-haiku-5-5', input_tokens: 11, output_tokens: 2 };
  assert.equal(routeReceipt(event, route, { usage }).status, 'observed');
  assert.equal(routeReceipt(event, route, { usage: null }).status, 'unavailable');
  assert.equal(routeReceipt(event, route, { usage: { ...usage, model: 'claude-opus-5-5' } }).status, 'mismatch');
  assert.equal(routeReceipt(event, route, { usage: { ...usage, model: 'claude-haiku-4-5' } }).status, 'mismatch');
  assert.equal(routeReceipt(event, route, { usage }).requested_effort, 'low');
  assert.equal(routeReceipt(event, route, { usage }).native_effort, 'low');
  assert.equal(routeReceipt(event, route, { answer: 'SECRET', usage }).answer, undefined);
});
