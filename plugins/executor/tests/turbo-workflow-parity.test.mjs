import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const read = relative => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
const baseline = read('../../../docs/research/turbo-parity-20261021/baseline-v2.json');
const turbo = read('../../../workflows/agentic-engineering-v2-turbo.json');

test('Turbo matches the captured live V2 contract except identity and priority tiers', () => {
  const normalized = structuredClone(turbo);
  assert.equal(turbo.id, 'agentic-engineering-v2-turbo');
  assert.equal(turbo.context.profile, turbo.id);
  assert.equal(turbo.context.speed_policy, 'priority (/fast) for all actionable Codex states');
  normalized.id = baseline.id;
  normalized.context.profile = baseline.context.profile;
  normalized.context.speed_policy = baseline.context.speed_policy;
  for (const [name, state] of Object.entries(baseline.states)) {
    if (state.type === 'final') continue;
    assert.equal(turbo.states[name].env_overrides.STATEWRIGHT_CODEX_SERVICE_TIER, 'priority');
    normalized.states[name].env_overrides.STATEWRIGHT_CODEX_SERVICE_TIER = state.env_overrides.STATEWRIGHT_CODEX_SERVICE_TIER;
  }
  assert.deepEqual(normalized, baseline);
});

test('Turbo has no executable Anthropic route or dangling deferred review transition', () => {
  assert.equal(turbo.states.devils_advocate, undefined);
  assert.equal(turbo.context.temporary_review_deferral.status, 'deferred');
  assert.equal(turbo.states.frontier_review.on.APPROVED, 'record');
  for (const state of Object.values(turbo.states)) {
    if (state.type !== 'final') assert.match(state.model, /^openai-codex\//);
    for (const transition of Object.values(state.on ?? {})) {
      const target = typeof transition === 'string' ? transition : transition.target;
      assert.ok(turbo.states[target], `Missing target ${target}`);
      for (const guard of [...(transition.guards ?? []), ...(transition.guard ? [transition.guard] : [])]) {
        assert.ok(turbo.guards[guard], `Missing guard ${guard}`);
      }
    }
  }
});

test('Turbo retains normal, repair and no-change paths and guarded completion', () => {
  const walk = events => events.reduce((name, event) => {
    const transition = turbo.states[name].on[event];
    assert.ok(transition, `Missing ${name}/${event}`);
    return typeof transition === 'string' ? transition : transition.target;
  }, turbo.initial);
  const prefix = ['INTAKE_COMPLETE', 'LOCALIZED', 'BASELINED', 'DESIGN_RECORDED', 'CONTRACT_ACCEPTED'];
  const suffix = ['IMPLEMENTED', 'VALIDATED', 'CROSSCHECKED', 'APPROVED', 'RECORDED', 'COMMIT_RECORDED', 'VERIFY_PASSED', 'COMMITTED'];
  assert.equal(walk([...prefix, ...suffix]), 'complete');
  assert.equal(walk([...prefix, 'IMPLEMENTED', 'VALIDATION_FAILED', 'REPAIR_PACKET_READY', 'DESIGN_RECORDED', 'CONTRACT_ACCEPTED', ...suffix]), 'complete');
  assert.equal(walk(['INTAKE_COMPLETE', 'LOCALIZED', 'NO_CHANGE_NEEDED', 'VALIDATED', 'CROSSCHECKED', 'APPROVED', 'NO_CHANGE_RECORDED', 'NO_CHANGE_CONFIRMED']), 'complete');
  assert.equal(walk(['BLOCKED']), 'blocked');
  assert.deepEqual(turbo.states.commit_finalize.on.COMMITTED.guards, ['commit_sha_recorded', 'commit_verified', 'commit_scope_verified']);
});
