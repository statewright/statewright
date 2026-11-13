#!/usr/bin/env node
// Local receipt check only. Never starts a host, signs in, or changes settings.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const identityFields = ['client', 'surface', 'appVersion', 'appBuild', 'engineVersion',
  'engineBuild', 'cliVersion', 'osVersion', 'architecture', 'pluginVersion', 'pluginSource',
  'pluginArtifactSha256', 'gatewayOrigin'];
export const requiredChecks = ['freshLogin', 'externalLoginReload', 'expiredCredentialRecovery',
  'catalog', 'permissionDenial', 'workflowApproval', 'modelRouting', 'cancelAndResume', 'restartAndResume'];
const present = value => typeof value === 'string' && value.trim().length > 0;
export function validateLedger(ledger) {
  if (ledger?.schema !== 'statewright/host-compatibility/v1' || !Array.isArray(ledger.records))
    throw new Error('Invalid host compatibility ledger');
  const ids = new Set();
  for (const record of ledger.records) {
    if (!present(record.id) || ids.has(record.id)) throw new Error('Missing or duplicate record ID');
    ids.add(record.id);
    if (!['claude', 'codex'].includes(record.identity?.client) || !['desktop', 'cli'].includes(record.identity?.surface))
      throw new Error(`${record.id}: unknown host lane`);
    if (!['reported_failure', 'reported_recovery', 'untested', 'failed', 'passed'].includes(record.status) || !present(record.evidence))
      throw new Error(`${record.id}: missing status or evidence`);
    if (record.status === 'passed') {
      validateIdentity(record.identity);
      if (!present(record.observedAt) || Number.isNaN(Date.parse(record.observedAt)) ||
          requiredChecks.some(check => record.checks?.[check]?.status !== 'passed' || !present(record.checks[check].evidence)))
        throw new Error(`${record.id}: live acceptance evidence is incomplete`);
    }
  }
  return ledger;
}
export function validateIdentity(identity) {
  if (!identity || identityFields.some(field => !present(identity[field]) || /^(unknown|pending|latest)$/i.test(identity[field])))
    throw new Error('Exact host, plugin, artifact and gateway identities are required');
  if (!['claude', 'codex'].includes(identity.client) || !['desktop', 'cli'].includes(identity.surface) ||
      !/^[a-f0-9]{40}$/.test(identity.pluginSource) || !/^[a-f0-9]{64}$/.test(identity.pluginArtifactSha256))
    throw new Error('Invalid host lane or source/artifact identity');
  const origin = new URL(identity.gatewayOrigin);
  if (origin.origin !== identity.gatewayOrigin || origin.protocol !== 'https:') throw new Error('Expected HTTPS gateway origin without credentials or path');
  for (const field of identityFields.filter(field => !['appVersion', 'appBuild'].includes(field)))
    if (identity[field] === 'not-applicable') throw new Error(`${field} must identify the tested runtime`);
  if (identity.surface === 'desktop' && ['appVersion', 'appBuild'].some(field => identity[field] === 'not-applicable'))
    throw new Error('Desktop application version and build are required');
}
export function requireAccepted(ledger, identity) {
  validateLedger(ledger); validateIdentity(identity);
  const matching = ledger.records.filter(record => identityFields.every(field => record.identity[field] === identity[field]));
  // A later failed/reported/untested receipt supersedes an earlier pass.
  const latest = matching.at(-1);
  if (latest?.status !== 'passed') throw new Error('No current live acceptance for this exact host/plugin combination');
  return latest.id;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 && !(args.length === 3 && args[1] === '--require-accepted'))
      throw new Error('Usage: node scripts/host-compatibility.mjs LEDGER [--require-accepted CANDIDATE_IDENTITY_JSON]');
    const ledger = validateLedger(JSON.parse(readFileSync(args[0], 'utf8')));
    console.log(args.length === 3 ? `Accepted: ${requireAccepted(ledger, JSON.parse(readFileSync(args[2], 'utf8')))}`
      : `Valid ledger: ${ledger.records.length} records. Validation alone is not live acceptance.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
