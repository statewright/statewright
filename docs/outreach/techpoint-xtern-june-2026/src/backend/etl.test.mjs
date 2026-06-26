import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIncidents,
  buildSummary,
  buildTimeline,
  normalizeEvent,
  parseEvents,
  scoreEvent,
} from './etl.mjs';

const raw = `
{"timestamp":"2026-06-26T13:04:00Z","vendor":"A","type":"malware","severity":"critical","host":"laptop-1"}

{"timestamp":"2026-06-26T13:20:00Z","vendor":"B","type":"data_exfiltration","severity":"high","entity":"laptop-1"}
{"timestamp":"2026-06-26T14:10:00Z","vendor":"C","type":"recon","severity":"informational","ip":"203.0.113.10"}
`;

test('parseEvents ignores blank lines', () => {
  assert.equal(parseEvents(raw).length, 3);
});

test('normalizeEvent accepts fallback entity fields and known severities', () => {
  const byHost = normalizeEvent({ host: 'h1', severity: 'critical', vendor: 'A', type: 'malware' });
  const byIp = normalizeEvent({ ip: '203.0.113.10', severity: 'informational', vendor: 'C', type: 'recon' });

  assert.equal(byHost.entity, 'h1');
  assert.equal(byHost.severity, 'critical');
  assert.equal(byIp.entity, '203.0.113.10');
  assert.equal(byIp.severity, 'low');
});

test('scoreEvent combines severity and event type risk', () => {
  assert.equal(scoreEvent({ severity: 'critical', type: 'malware' }), 18);
  assert.equal(scoreEvent({ severity: 'low', type: 'recon' }), 2);
});

test('buildIncidents groups by entity and sorts by risk descending', () => {
  const incidents = buildIncidents(parseEvents(raw));

  assert.equal(incidents.length, 2);
  assert.equal(incidents[0].entity, 'laptop-1');
  assert.equal(incidents[0].riskScore, 33);
  assert.equal(incidents[0].severity, 'critical');
  assert.deepEqual(incidents[0].vendors, ['A', 'B']);
  assert.equal(incidents[0].recommendedAction, 'Escalate to incident commander');
});

test('buildTimeline returns hourly buckets sorted oldest to newest', () => {
  const timeline = buildTimeline(parseEvents(raw));

  assert.deepEqual(timeline, [
    { hour: '2026-06-26T13:00:00.000Z', eventCount: 2, riskScore: 33 },
    { hour: '2026-06-26T14:00:00.000Z', eventCount: 1, riskScore: 2 },
  ]);
});

test('buildSummary reports incident counts and top entity', () => {
  const events = parseEvents(raw);
  const incidents = buildIncidents(events);
  const summary = buildSummary(events, incidents);

  assert.deepEqual(summary, {
    totalEvents: 3,
    openIncidents: 2,
    criticalIncidents: 1,
    topEntity: 'laptop-1',
  });
});
