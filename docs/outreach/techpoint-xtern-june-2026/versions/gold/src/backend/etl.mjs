import { readFile } from 'node:fs/promises';

const SEVERITY_POINTS = {
  low: 1,
  medium: 3,
  high: 7,
  critical: 12,
};

const TYPE_POINTS = {
  malware: 6,
  credential_access: 5,
  data_exfiltration: 8,
  policy_violation: 2,
  recon: 1,
};

const KNOWN_SEVERITIES = new Set(Object.keys(SEVERITY_POINTS));

export async function loadEvents(path = new URL('../../data/security-events.ndjson', import.meta.url)) {
  const text = await readFile(path, 'utf8');
  return parseEvents(text);
}

export function parseEvents(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function normalizeEvent(event) {
  const severity = String(event.severity ?? 'low').toLowerCase();

  return {
    timestamp: event.timestamp,
    vendor: event.vendor,
    type: event.type,
    severity: KNOWN_SEVERITIES.has(severity) ? severity : 'low',
    entity: event.entity ?? event.host ?? event.username ?? event.ip ?? 'unknown',
    message: event.message ?? '',
  };
}

export function scoreEvent(event) {
  const severityPoints = SEVERITY_POINTS[event.severity] ?? SEVERITY_POINTS.low;
  const typePoints = TYPE_POINTS[event.type] ?? 0;
  return severityPoints + typePoints;
}

export function buildIncidents(events) {
  const groups = new Map();

  for (const rawEvent of events) {
    const event = normalizeEvent(rawEvent);
    const risk = scoreEvent(event);
    const current = groups.get(event.entity) ?? {
      id: `inc-${slug(event.entity)}`,
      entity: event.entity,
      severity: 'low',
      riskScore: 0,
      eventCount: 0,
      vendors: new Set(),
      recommendedAction: 'Monitor',
    };

    current.riskScore += risk;
    current.eventCount += 1;
    current.vendors.add(event.vendor);
    groups.set(event.entity, current);
  }

  return Array.from(groups.values())
    .map((incident) => ({
      ...incident,
      severity: severityForRisk(incident.riskScore),
      vendors: Array.from(incident.vendors).sort(),
      recommendedAction: recommendedActionForRisk(incident.riskScore),
    }))
    .sort((a, b) => b.riskScore - a.riskScore || a.entity.localeCompare(b.entity));
}

export function buildTimeline(events) {
  const buckets = new Map();

  for (const rawEvent of events) {
    const event = normalizeEvent(rawEvent);
    const hour = hourBucket(event.timestamp);
    const current = buckets.get(hour) ?? { hour, eventCount: 0, riskScore: 0 };

    current.eventCount += 1;
    current.riskScore += scoreEvent(event);
    buckets.set(hour, current);
  }

  return Array.from(buckets.values()).sort((a, b) => a.hour.localeCompare(b.hour));
}

export function buildSummary(events, incidents) {
  return {
    totalEvents: events.length,
    openIncidents: incidents.length,
    criticalIncidents: incidents.filter((incident) => incident.severity === 'critical').length,
    topEntity: incidents[0]?.entity ?? null,
  };
}

export async function buildDashboardData(path) {
  const events = await loadEvents(path);
  const incidents = buildIncidents(events);
  const timeline = buildTimeline(events);
  const summary = buildSummary(events, incidents);

  return { events, incidents, timeline, summary };
}

function severityForRisk(riskScore) {
  if (riskScore >= 24) return 'critical';
  if (riskScore >= 14) return 'high';
  if (riskScore >= 6) return 'medium';
  return 'low';
}

function recommendedActionForRisk(riskScore) {
  if (riskScore >= 24) return 'Escalate to incident commander';
  if (riskScore >= 14) return 'Assign analyst for same-day triage';
  if (riskScore >= 6) return 'Queue for review';
  return 'Monitor';
}

function hourBucket(timestamp) {
  const date = new Date(timestamp);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
