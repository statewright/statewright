import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './summarize-local-judgment.mjs';

const row = (id, expected, score) => ({id, task:'command', arm:'shape', expected:{read_only:expected},
  status:'assessed', truncated:false, actual_device:'mps', latency_ms:10,
  result:{answers:{read_only:{noul:score}, may_write:{noul:0.1}, reversible:{noul:0.1},
    destructive:{noul:0.1}, irreversible:{noul:0.1}, external_or_account_effect:{noul:0.1}}}});
const receipt = rows => ({schema:'statewright/local-judgment-diagnostic/v1', enforcement:'none', actual_device:'mps', rows});
test('counts errors, unknowns and truncation without treating them as successful labels', () => {
  const result = summarize(receipt([row('a', false, 0.9), row('b', true, 0.1), row('c', null, 0.9),
    {...row('d', true, 0.9), status:'abstain_truncated', truncated:true}]));
  const group = result.groups['command/shape'];
  assert.equal(group.assessed, 3); assert.equal(group.abstained, 1);
  assert.equal(group.labeled, 2); assert.equal(group.accuracy, 0);
  assert.equal(group.false_read, 1); assert.equal(group.missed_read, 1);
  assert.equal(group.unknown_labels, 1); assert.equal(group.brier, 0.81);
});
test('rejects malformed, duplicate and fallback evidence', () => {
  for (const change of [r => r.result.answers.read_only.noul = 2, r => r.latency_ms = null,
    r => r.status = 'failed', r => r.truncated = true, r => r.actual_device = 'cpu']) {
    const bad = row('a', true, 0.9); change(bad);
    assert.throws(() => summarize(receipt([bad])));
  }
  assert.throws(() => summarize(receipt([row('a', true, 1), row('a', true, 1)])));
});
test('separates false supported transitions from command score errors', () => {
  const value = {id:'old', task:'transition', arm:'evidence', expected:{support:'insufficient'},
    status:'assessed', truncated:false, actual_device:'mps', latency_ms:12,
    result:{answers:{support:{choice:'supported', probabilities:{supported:0.8, contradicted:0.1, insufficient:0.1}}}}};
  assert.equal(summarize(receipt([value])).groups['transition/evidence'].false_supported, 1);
  value.result.answers.support.probabilities.insufficient = 0.9;
  assert.throws(() => summarize(receipt([value])));
});
test('validates every requested answer even when unlabelled or labelled unknown', () => {
  for (const change of [r => r.result = {}, r => delete r.result.answers.read_only,
    r => r.result.answers.read_only.noul = NaN, r => delete r.result.answers.reversible,
    r => r.result.answers.irreversible.noul = 'unknown', r => r.result.answers.extra = {noul:0.1}]) {
    const bad = row('unknown', null, 0.1); change(bad);
    assert.throws(() => summarize(receipt([bad])));
  }
  assert.throws(() => summarize({...receipt([row('valid', true, 0.9)]), provenance_unchanged:false}));
});
