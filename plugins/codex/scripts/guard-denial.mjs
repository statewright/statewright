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
]);
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
  const explanation = explanations.get(basis) ?? (capability
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
    return ` Rework attempt ${number(rework.attempts)}/${number(rework.max_reworks)}. No approval has been granted; reaching the budget does not itself submit or approve this invocation.`;
  }
  if (rework?.action === 'approval_required') return ' Rework budget exhausted; native human approval is required but not yet confirmed.';
  return '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 256 * 1024) throw new Error('classifier display input exceeds limit');
  }
  process.stdout.write(classifierDenialDisplay(JSON.parse(input)));
}
