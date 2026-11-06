# Configured durable storage is a startup requirement

## Evidence and cause

A staging rollout reported healthy gateway pods while reading an existing owned
approval returned HTTP 404. A read-only database check found the exact run and
pending approval still checkpointed. The serving gateway's startup log reported
a PostgreSQL connection failure followed by `Metering disabled.`

In a metering-enabled build, `start_remote_server` previously converted a
configured database connection failure into `db_pool = None`. The pool also
supports approval recovery and workflow checkpoints, not only metering. The
gateway could then serve healthy HTTP responses indefinitely without recovery
storage. A missing in-memory session could not be recovered from its intact
checkpoint. Successful health and image attribution did not prove this feature.

## Decision

When `DATABASE_URL` is configured in a metering-enabled build, require a
successful initial database connection before binding the listener. Empty,
invalid, and unreachable configurations return a stable error without the DSN
or driver error. Bound pool acquisition at ten seconds. The existing process
supervisor handles startup restart; do not silently select memory-only mode or
add an internal retry loop.

An explicitly absent database configuration retains the existing memory-only
mode. Non-metering build behavior is unchanged. There are no database schema,
classifier, entitlement, approval authority, hook trust, or workflow changes.

## Validation and limits

- Red regression: malformed configured storage previously reached listener
  binding rather than reporting the storage failure.
- Tests cover malformed and empty configuration, actual loopback connection
  refusal with a bounded deadline, and a healthy explicitly memory-only server.
- Exact returned error assertions guard against exposing connection strings.
  They do not capture all dependency logs.
- Focused and affected default/metering gateway suites are recorded in the
  private delivery receipt. Ignored database-dependent tests are not passes.
- Native review recovery after a fresh deployment remains a separate acceptance
  gate. This change does not grant a reviewer a paid entitlement or authority.

## Deployment and rollback

Deploy through the normal complete staging release with new source/image
identity. Confirm startup records a successful durable connection and observe
the existing review through its supported identity-bound read path. Do not
recreate the workflow or approval to conceal failed recovery. A persistent
database outage now makes the deployment visibly unavailable instead of
apparently healthy without persistence; operators must repair connectivity or
configuration. Rollback uses the prior complete release, with its known silent
fallback limitation retained in the incident record.
