import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { identityFields, requiredChecks, validateLedger, requireAccepted } from './host-compatibility.mjs';
const identity = { client: 'claude', surface: 'desktop', appVersion: 'test-app', appBuild: '100',
  engineVersion: '2.1.321', engineBuild: 'fixture-engine-sha', cliVersion: '2.1.323', osVersion: 'fixture-os',
  architecture: 'arm64', pluginVersion: '0.3.8', pluginSource: 'a'.repeat(40), pluginArtifactSha256: 'b'.repeat(64),
  gatewayOrigin: 'https://mcp.statewright.ai' };
const fixture = () => ({ schema: 'statewright/host-compatibility/v1', records: [{ id: 'fixture', identity: { ...identity },
  status: 'passed', observedAt: '2026-11-12T00:00:00Z', evidence: 'fixture only',
  checks: Object.fromEntries(requiredChecks.map(check => [check, { status: 'passed', evidence: `fixture:${check}` }])) }] });
test('checked-in ledger is valid but never asserts acceptance from the user report', () => {
  const ledger = validateLedger(JSON.parse(readFileSync(new URL('../docs/releases/host-compatibility.json', import.meta.url))));
  assert.equal(ledger.records.find(record => record.id === '2026-11-12-claude-desktop-credential-reload').status, 'reported_failure');
  assert.throws(() => requireAccepted(ledger, identity), /No current live acceptance/);
});
test('every identity boundary invalidates prior acceptance', () => {
  assert.equal(requireAccepted(fixture(), identity), 'fixture');
  for (const field of identityFields) {
    const value = field === 'client' ? 'codex' : field === 'surface' ? 'cli'
      : field === 'pluginSource' ? 'c'.repeat(40) : field === 'pluginArtifactSha256' ? 'd'.repeat(64)
      : field === 'gatewayOrigin' ? 'https://staging.example.com' : `${identity[field]}-changed`;
    assert.throws(() => requireAccepted(fixture(), { ...identity, [field]: value }), /No current live acceptance/, field);
  }
});
test('missing identities and missing scenario evidence cannot pass', () => {
  for (const field of identityFields) {
    const ledger = fixture(); ledger.records[0].identity[field] = null;
    assert.throws(() => requireAccepted(ledger, identity), undefined, field);
  }
  for (const check of requiredChecks) {
    const ledger = fixture(); ledger.records[0].checks[check] = { status: 'passed' };
    assert.throws(() => validateLedger(ledger), /incomplete/, check);
  }
});
test('a later failure supersedes a pass, even for an identical host', () => {
  const ledger = fixture(); ledger.records.push({ ...ledger.records[0], id: 'regression', status: 'reported_failure' });
  assert.throws(() => requireAccepted(ledger, identity), /No current live acceptance/);
});
