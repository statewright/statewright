#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { s1ClassificationDisplay } from './lib/human-interaction.mjs';

// Presentation only. Never classify command text or turn a hint into authority.
const explanations = new Map([
  ['semantic_authorization_disabled', 'Statewright could not verify the command, and S1 is not enabled to authorize it here.'],
  ['incomplete_structural_evidence', 'Statewright could not verify every part of this command or its dependencies.'],
  ['semantic_vector_unavailable', 'S1 did not return usable predictions for this command.'],
  ['semantic_assessment_incomplete', 'S1 could not finish assessing this command.'],
  ['semantic_threshold_not_met', 'S1 was uncertain about the command; this does not mean it is destructive.'],
  ['external_effect_unresolved', 'This request reaches an external service, and Statewright could not verify its effects.'],
  ['effective_known_risk', 'The effective risk classification requires a separately approved execution path.'],
  ['deterministic_known_risk', 'Structural classification identified a known-risk operation requiring a separately approved execution path.'],
  ['deterministic_nonlocal_risk', 'The resolved effect is outside the permitted local-effect path.'],
  ['interceptor_policy', 'An independent interceptor policy denied this invocation; classifier approval cannot override it.'],
  ['workflow_approval_policy', 'This workflow does not permit the request at this stage; S1 approval cannot override that restriction.'],
  ['workflow_tool_policy', 'This tool falls outside the capabilities granted in this phase. Use a tool already authorized for the task or move to a phase that grants the required capability.'],
]);
const missingExternalCapability = 'Classifier approval cannot grant a missing external capability.';
const capabilities = new Set(['Read', 'Write', 'BoundedLocalExecution', 'GitLocalWrite',
  'Write+GitLocalWrite', 'Write+BoundedLocalExecution', 'BoundedLocalExecution+GitLocalWrite',
  'Write+BoundedLocalExecution+GitLocalWrite']);
const label = (value, allowed) => allowed.includes(value) ? value : 'unknown';

export function classifierDenialDisplay(result) {
  const risk = result?.risk_assessment ?? result?.riskAssessment;
  if (!risk || typeof risk !== 'object' || Array.isArray(risk)) return '';
  const basis = risk.final_denial_basis ?? risk.resolution_basis;
  const capability = typeof basis === 'string' && basis.startsWith('workflow_capability_');
  const policy = typeof basis === 'string' && basis.startsWith('classifier_policy_');
  const required = capabilities.has(risk.required_authority) ? risk.required_authority : 'the required authority';
  const knownBasis = explanations.has(basis);
  // Unknown strings may contain payloads: show a category, not arbitrary receipt text.
  const explanation = basis === 'workflow_approval_policy' && result.reason === missingExternalCapability
    ? 'Statewright could not establish the effects of the external operation, and this phase lacks the capability to review it. Use an existing local receipt if it answers the question. For fresh external evidence, use an authorized phase that grants the required capability.'
    : explanations.get(basis) ?? (capability
    ? `This workflow phase does not grant ${required} for the resolved effect. Next: use a supported transition to a phase that grants it, if authorized.`
    : policy ? `The workflow risk policy does not admit the resolved effect (${required}). Next: request the appropriate authorized execution path.`
    : 'The classifier returned an unrecognized reason code; inspect the machine receipt before deciding a recovery path.');
  let message = `Statewright blocked this request. ${explanation}`;
  message += ` Detected risk: ${label(risk.deterministic_risk, ['Low','Moderate','High','Critical']).toLowerCase()}`
    + `; scope: ${label(risk.deterministic_exposure, ['Local','External','Account','Unknown']).toLowerCase()}.`;
  message += ` ${s1ClassificationDisplay(risk)}`;
  const uncertain = knownBasis && ['semantic_authorization_disabled','incomplete_structural_evidence',
    'semantic_vector_unavailable','semantic_assessment_incomplete','semantic_threshold_not_met','external_effect_unresolved'].includes(basis);
  if (uncertain && risk.reformulation_allowed === true) {
    message += ' Check the command and any scripts it runs; the available evidence does not identify the unresolved part.';
  }
  if (risk.separate_approval_allowed === true && uncertain) {
    message += ' A human can review this request if the approval dialog is available; approval has not yet been granted.';
  } else if (risk.separate_approval_allowed === false) {
    message += ' This workflow does not offer S1 approval for this request.';
  } else {
    message += ' Whether S1 approval is available has not been confirmed.';
  }
  if (risk.exact_invocation_retry_allowed === false) message += ' Do not replay the unchanged invocation.';
  return message;
}

export function classifierReworkDisplay(rework) {
  if (rework?.action === 'rework') {
    const number = value => Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : '?';
    const next = typeof rework.review_ticket === 'string' && /^[a-f0-9-]{36}$/.test(rework.review_ticket)
      ? `If no permitted alternative answers the task, call the local statewright_request_classifier_review tool with ticket ${rework.review_ticket} and await the native decision.`
      : 'If a later request is still uncertain and eligible after rework, wait for its native approval dialog.';
    return ` Rework attempt ${number(rework.attempts)}/${number(rework.max_reworks)}. Before asking the user, try a materially narrower, independently permitted operation that still answers the task. For example, read an existing receipt, inspect a script before running it, or remove an unnecessary shell operation. Statewright assesses the alternative independently. No approval has been granted. ${next}`;
  }
  if (rework?.action === 'approval_required') return ' Rework budget exhausted; native human approval is required but not yet confirmed.';
  return '';
}

export function classifierApprovalDisplay(approval) {
  const duration = ({'2h': '2 hours', '4h': '4 hours', '8h': '8 hours', always: 'future matching invocations'})[approval?.duration];
  if (approval?.grant_id && typeof duration === 'string') {
    return approval.reason === 'remembered_human_approval'
      ? `Reused human approval for this exact invocation. The grant was issued for ${duration}.`
      : `Human approved this exact invocation. Statewright will remember it for ${duration}.`;
  }
  return 'Human approved this exact invocation once.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 256 * 1024) throw new Error('classifier display input exceeds limit');
  }
  const result = JSON.parse(input);
  const mode = process.argv[2];
  process.stdout.write(mode === '--approval' ? classifierApprovalDisplay(result)
    : mode === '--rework' ? classifierReworkDisplay(result) : classifierDenialDisplay(result));
}
