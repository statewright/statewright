#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

// Presentation only. Never classify command text or turn a hint into authority.
const explanations = new Map([
  ['semantic_authorization_disabled', 'The structural classifier did not establish an allowed effect, and semantic authorization is disabled. This is not a model judgment that the operation is dangerous.'],
  ['incomplete_structural_evidence', 'Structural evidence is incomplete; Statewright cannot establish the effects of every execution unit.'],
  ['semantic_vector_unavailable', 'No usable semantic assessment vector was available for the unresolved effect.'],
  ['semantic_assessment_incomplete', 'Semantic assessment did not complete successfully for the unresolved effect.'],
  ['semantic_threshold_not_met', 'The assessment did not meet the configured effect thresholds. This is uncertainty, not proof that the operation is destructive.'],
  ['effective_known_risk', 'The effective risk classification requires a separately approved execution path.'],
  ['deterministic_known_risk', 'Structural classification identified a known-risk operation requiring a separately approved execution path.'],
  ['deterministic_nonlocal_risk', 'The resolved effect is outside the permitted local-effect path.'],
  ['interceptor_policy', 'An independent interceptor policy denied this invocation; classifier approval cannot override it.'],
]);
const capabilities = new Set(['Read', 'Write', 'BoundedLocalExecution', 'GitLocalWrite',
  'Write+GitLocalWrite', 'Write+BoundedLocalExecution', 'BoundedLocalExecution+GitLocalWrite',
  'Write+BoundedLocalExecution+GitLocalWrite']);
const sources = ['shell', 'shell_ast', 'native_write', 'native_read', 'native_tool_discovery',
  'native_web_read', 'mcp_annotation', 'mcp_selector', 'mcp_name', 'mcp_unknown',
  'mcp_opaque_payload', 'native_command_evidence', 'native_command_evidence_incomplete',
  'unmanaged_agent_delegation'];
const policyCodes = new Set(['classifier_policy_low_local', 'classifier_policy_semantic_local_write',
  'classifier_policy_semantic_resolution', 'workflow_capability_read_denied', 'workflow_capability_write_denied',
  'workflow_capability_bounded_execution_and_git_not_allowed', 'workflow_capability_bounded_local_execution_not_allowed',
  'workflow_capability_combined_local_execution_not_allowed', 'workflow_capability_combined_local_write_not_allowed',
  'workflow_capability_git_local_write_not_allowed', 'workflow_capability_write_and_bounded_execution_not_allowed']);
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
  const code = knownBasis || policyCodes.has(basis) ? basis : capability ? 'workflow_capability_denial'
    : policy ? 'classifier_policy_denial' : 'unknown';
  const explanation = explanations.get(basis) ?? (capability
    ? `This workflow phase does not grant ${required} for the resolved effect. Next: use a supported transition to a phase that grants it, if authorized.`
    : policy ? `The workflow risk policy does not admit the resolved effect (${required}). Next: request the appropriate authorized execution path.`
    : 'The classifier returned an unrecognized reason code; inspect the machine receipt before deciding a recovery path.');
  let message = `Statewright guard: denied [${code}] · ${explanation}`;
  message += ` Classification: ${label(risk.deterministic_risk, ['Low','Moderate','High','Critical'])}`
    + ` / ${label(risk.deterministic_exposure, ['Local','External','Account','Unknown'])}`
    + `; source ${label(risk.deterministic_source, sources)}.`;
  message += ` Semantic assessment: ${label(risk.semantic_status, ['Disabled','Queued','Unavailable','Timeout','Malformed','QueueFull','Assessed'])}.`;
  const vector = risk.semantic_vector;
  if (risk.semantic_status === 'Assessed' && vector && typeof vector === 'object') {
    const percent = value => Number.isFinite(value) && value >= 0 && value <= 1 ? `${Math.round(value * 100)}%` : 'unknown';
    message += ` System One signals (uncalibrated): read-only ${percent(vector.read_only)}, write ${percent(vector.may_write)}, destructive ${percent(vector.destructive)}, external ${percent(vector.external_or_account_effect)}.`;
  }
  const uncertain = knownBasis && ['semantic_authorization_disabled','incomplete_structural_evidence',
    'semantic_vector_unavailable','semantic_assessment_incomplete','semantic_threshold_not_met'].includes(basis);
  if (uncertain && risk.reformulation_allowed === true) {
    message += ' Next: supply complete structural evidence through a supported path; the receipt does not identify a specific failing argument or shell fragment.';
  }
  if (risk.separate_approval_allowed === true && uncertain) {
    message += ' Separate approval is eligible, not granted; it requires a connected approval-capable runtime.';
  } else if (risk.separate_approval_allowed === false) {
    message += ' Classifier fallback approval is not offered by this receipt.';
  } else {
    message += ' Classifier fallback approval eligibility is not confirmed by this receipt.';
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
