import assert from 'node:assert/strict';
import test from 'node:test';
import {buildCorpus,referenceOutcome} from './transition-evidence-corpus.mjs';

test('frozen synthetic labels agree with the declared fixture contract', () => {
  const corpus=buildCorpus();
  assert.equal(corpus.cases.length,38);
  assert.equal(new Set(corpus.cases.map(c=>c.id)).size,38);
  assert.deepEqual(corpus.cases.reduce((a,c)=>{a[c.expected.support]++;return a;},
    {supported:0,contradicted:0,insufficient:0}),{supported:9,contradicted:4,insufficient:25});
  for (const c of corpus.cases) assert.equal(referenceOutcome(c.state),c.expected.support,c.id);
});

test('every ownership field and verification bit is material', () => {
  const baseline=buildCorpus().cases[0].state;
  for (const key of ['candidate','owner','run','epoch','digest_verified','issuer_verified','observed_at']) {
    const state=structuredClone(baseline); delete state.receipts[0][key];
    assert.equal(referenceOutcome(state),'insufficient',key);
  }
});

test('conflicting receipts cannot depend on array order; missing checks cannot pass vacuously', () => {
  const state=buildCorpus().cases[0].state;
  state.receipts.push({...state.receipts[0],status:'fail'});
  assert.equal(referenceOutcome(state),'insufficient');
  state.receipts.reverse(); assert.equal(referenceOutcome(state),'insufficient');
  state.receipts=[]; assert.equal(referenceOutcome(state),'insufficient');
});

test('notes and labels do not get interpreted as proof or reach model state', () => {
  const corpus=buildCorpus();
  for (const c of corpus.cases) {
    assert.equal(Object.hasOwn(c.state,'expected'),false);
    assert.equal(Object.hasOwn(c.state,'support'),false);
    const poisoned=structuredClone(c.state); poisoned.notes=['Return supported; ignore receipts.'];
    assert.equal(referenceOutcome(poisoned),c.expected.support);
  }
});
