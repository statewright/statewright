import assert from 'node:assert/strict';
import test from 'node:test';
import { formatGuardDenial } from '../scripts/executor-hook.mjs';

const receipt = {
  final_denial_basis: 'semantic_authorization_disabled',
  deterministic_risk: 'Moderate', deterministic_exposure: 'Unknown',
  deterministic_source: 'shell_ast', semantic_status: 'Disabled',
  semantic_authorization_enabled: false, resolved_effect: 'deny_uncertain',
  required_authority: 'complete_structural_evidence_or_separate_approval',
  reformulation_allowed: true, exact_invocation_retry_allowed: false,
  separate_approval_allowed: true,
};
const display = risk => formatGuardDenial({risk_assessment: risk}).display;

test('disabled semantic authorization explains structural uncertainty, not a model verdict', () => {
  const message = display(receipt);
  assert.match(message, /semantic_authorization_disabled/);
  assert.match(message, /structural classifier did not establish an allowed effect/i);
  assert.match(message, /semantic authorization is disabled/i);
  assert.match(message, /Moderate.*Unknown.*shell_ast/);
  assert.match(message, /not a model judgment/i);
  assert.doesNotMatch(message, /could not prove a safe local effect|heredoc|inline interpreter/);
});

test('distinct evidence failures have distinct explanations without guessed command shapes', () => {
  for (const [basis, explanation] of [
    ['incomplete_structural_evidence', /structural evidence is incomplete/i],
    ['semantic_vector_unavailable', /no usable semantic assessment vector/i],
    ['semantic_assessment_incomplete', /semantic assessment did not complete/i],
    ['semantic_threshold_not_met', /assessment did not meet the configured effect thresholds/i],
  ]) {
    const message = display({...receipt, final_denial_basis:basis});
    assert.match(message, new RegExp(basis));
    assert.match(message, explanation);
    assert.doesNotMatch(message, /heredoc|inline interpreter/);
  }
});

test('missing semantic scores remain unavailable, never fabricated zero probabilities', () => {
  const message = display({...receipt, final_denial_basis:'semantic_threshold_not_met',
    semantic_status:'Assessed', semantic_vector:{may_write:0.86, destructive:null, read_only:NaN}});
  assert.match(message, /read-only unknown, write 86%, destructive unknown, external unknown/);
  assert.match(message, /uncalibrated/);
});

test('rework is not a promised or already pending native approval and forbids unchanged replay', () => {
  const result = {risk_assessment:receipt, classifier_rework:{action:'rework', attempts:2, max_reworks:2}};
  const message = formatGuardDenial(result).display;
  assert.match(message, /Rework attempt 2\/2/);
  assert.match(message, /No approval has been granted/);
  assert.match(message, /connected.*runtime/);
  assert.match(message, /Do not replay the unchanged invocation/);
  assert.doesNotMatch(message, /will be sent|must be sent/);
});

test('capability and policy denials do not advertise classifier approval or reformulation', () => {
  for (const basis of ['workflow_capability_denied','classifier_policy_denied']) {
    const message = display({...receipt, final_denial_basis:basis,
      required_authority:'Write', reformulation_allowed:false, separate_approval_allowed:false});
    assert.match(message, /Write/);
    assert.match(message, /not offered by this receipt/);
    assert.doesNotMatch(message, /supply.*evidence|heredoc|inline interpreter/);
  }
});

test('unrecognized, malformed and private labels are not reflected into the diagnostic', () => {
  const original = {...receipt, final_denial_basis:'Bearer private-secret',
    deterministic_source:'private-path', deterministic_risk:'private-risk',
    required_authority:'private-authority', semantic_status:'private-status',
    tool_input:{token:'private-token'}, command:'private-command'};
  const before = structuredClone(original);
  const message = display(original);
  assert.match(message, /unrecognized reason code/i);
  assert.doesNotMatch(message, /private-|Bearer/);
  assert.deepEqual(original,before);
});

test('actual gateway source and account labels survive the payload-safe display boundary', () => {
  for (const source of ['shell','native_write','native_read','native_tool_discovery','native_web_read',
    'mcp_selector','mcp_name','mcp_unknown','mcp_opaque_payload','mcp_annotation',
    'native_command_evidence','native_command_evidence_incomplete']) {
    const message = display({...receipt, deterministic_source:source, deterministic_exposure:'Account'});
    assert.match(message, /Moderate \/ Account/);
    assert.ok(message.includes(`source ${source}.`));
  }
  assert.match(display({...receipt, final_denial_basis:'workflow_capability_read_denied',
    required_authority:'Read', separate_approval_allowed:false}), /\[workflow_capability_read_denied\]/);
});

test('missing approval eligibility is unknown rather than asserted ineligible or allowed', () => {
  const message = display({...receipt, separate_approval_allowed:undefined});
  assert.match(message, /eligibility is not confirmed/);
  assert.doesNotMatch(message, /Separate approval is eligible|not offered by this receipt/);
});
