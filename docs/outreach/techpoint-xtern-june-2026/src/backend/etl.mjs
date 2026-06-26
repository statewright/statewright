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
      id: `inc-${groups.size + 1}`,
      entity: event.entity,
      severity: event.severity,
      riskScore: 0,
      eventCount: 0,
      vendors: [],
      recommendedAction: 'Monitor',
    };

    current.riskScore += risk;
    current.eventCount += 1;
    current.vendors.push(event.vendor);
    groups.set(event.entity, current);
  }

  return Array.from(groups.values());
}

export function buildTimeline(events) {
  return events.map((event) => ({
    hour: event.timestamp,
    eventCount: 1,
    riskScore: scoreEvent(normalizeEvent(event)),
  }));
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
