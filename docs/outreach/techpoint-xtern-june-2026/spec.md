# Incident Signal Dashboard Spec

## Product Goal

Security teams receive too many raw events. Build a small dashboard that turns a simulated security firehose into incident-level signal.

## Required API

`GET /api/summary`

Returns:

- `totalEvents`: number of parsed input events.
- `openIncidents`: number of incident groups.
- `criticalIncidents`: number of incidents with severity `critical`.
- `topEntity`: entity with the highest total risk.

`GET /api/incidents`

Returns incidents sorted by descending `riskScore`.

Each incident must include:

- `id`
- `entity`
- `severity`
- `riskScore`
- `eventCount`
- `vendors`
- `recommendedAction`

`GET /api/timeline`

Returns hourly buckets sorted oldest to newest. Each bucket includes:

- `hour`
- `eventCount`
- `riskScore`

## Normalization Rules

- Accept either `entity`, `host`, `username`, or `ip` as the affected entity.
- Normalize severity to `low`, `medium`, `high`, or `critical`.
- Map unknown severities to `low`.
- Preserve vendor names.
- Ignore blank lines in NDJSON input.

## Risk Rules

Base severity points:

- `low`: 1
- `medium`: 3
- `high`: 7
- `critical`: 12

Additive risk modifiers:

- `malware`: +6
- `credential_access`: +5
- `data_exfiltration`: +8
- `policy_violation`: +2
- `recon`: +1

Incident severity is based on total incident risk:

- `critical`: 24 or higher
- `high`: 14 to 23
- `medium`: 6 to 13
- `low`: 5 or lower

## Recommended Actions

- Critical incidents: `Escalate to incident commander`
- High incidents: `Assign analyst for same-day triage`
- Medium incidents: `Queue for review`
- Low incidents: `Monitor`

## Acceptance Criteria

- `npm test` passes.
- The dashboard loads without console errors.
- The dashboard displays summary, incident, and timeline data from the API.
- The implementation is deterministic; tests should not depend on current time.
