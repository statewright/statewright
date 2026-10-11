# P0/P1 approval journal and resume ownership

Historical engineering summary of the investigation begun 2026-09-17.
Sanitized 2026-10-10: the operational journal, personal execution identifiers,
private workspace references and reviewer transcripts are omitted. This summary
is not the complete journal, a fresh test run, or a release approval.

## Public implementation scope

The work addressed durable approval parking, authoritative reconciliation,
request epochs, native writer ownership and cold resume across the shared
executor and Pi integration. Public sources include:

- `plugins/executor/lib/approval-journal.mjs`
- `plugins/executor/lib/runtime-approval-service.mjs`
- `plugins/executor/lib/executor-approval-mirror.mjs`
- `plugins/executor/tests/executor-observer.test.mjs`
- `plugins/executor/statewright-exec.mjs`
- `plugins/pi/src/index.ts`

The host contract is described in
[006](006-control-plane-host-feasibility.md) and
[012](012-pi-approval-p1.md). Vendor transport smoke in
[007](007-w1-x0-release-train-receipts.md) does not establish a complete live
pause/decision/resume journey.

## Durable approval invariants

1. A parked checkpoint is acknowledged only after sync and atomic publication;
   POSIX additionally syncs its directory. Windows directory-sync parity was
   not established.
2. Journal mutations are exclusive across instances and processes. Unresolved
   or corrupt checkpoints cannot be silently overwritten.
3. Missing or foreign session/run identity, changed ticket/edge, malformed
   pending state, unavailable authority and rejected receipts retain the
   journal and deny continuation. Target-state coincidence is not approval.
4. Release requires the authoritative approved ticket and matching applied
   target state. The observation mirror does not decide approvals.
5. Storage identity includes gateway, credential fingerprint, host, workflow,
   project and checkout; it must not replace authenticated transport identity.
6. Initial journal failure prevents host launch. Poll-time failure stops only
   the owned child. In-flight reconciliation drains before observation ends,
   and pending approval cannot trigger a routed restart.
7. New input or configuration invalidates stale continuation/final ownership.
   Native effect admission and late output must respect the owning epoch.
8. API keys, creator IPC and process identifiers alone do not prove a genuine
   entitled human decision or isolation from a malicious same-OS process.

## Resume and writer ownership

The investigation progressively exercised SDK process resume, executor-parent
reopening, lost HTTP responses, crash boundaries around consumed writes, and
explicit recovery binding. These tests did not authorize automatic takeover.

The final recorded slice used test-only parent/relay wiring with actual
registered parent/writer handles. It distinguished creator-channel birth/lease
identities from independently random readiness challenges. A surviving writer
prevented exit-witness issuance after parent death; an observed writer exit
permitted one matching in-memory witness, not lock reclamation.

Dead locks and raw checkpoint/native bytes remained unchanged on denied resume.
Age, a PID, a fixture receipt or a process kill was not accepted as recovery
authority. Durable intent, file identity, all-contender admission and exclusive
crash-safe transfer remained separate requirements.

## Selected historical validation

These counts are retained from the original journal, not rerun for this
documentation cleanup:

- Initial mirror regressions: 12 of 16 failed on the earlier source.
- First repaired slice: journal 18/18; mirror/service/observer/executor 57/57;
  broader integration grew from 197 to 203 and finally 210 passing tests after
  revalidation, review repairs and cross-process locking coverage.
- Final recorded test-only parent slice: four focused cases, 339/339 serial
  Node integration tests, and 15/15 native Pi wildcard tests passed.
- Generated Claude parity and syntax checks passed for that recorded slice.

The final slice did not rerun frontend/Vitest, Rust/gateway, provider, native UI,
human approval, Windows/WSL, release, install or soak acceptance. Static review
of supplied sources was not an independent runtime or filesystem audit.

## Remaining acceptance boundaries at the recorded cut

The original objective remained incomplete. Outstanding requirements included:

- Full immutable ticket identity and authoritative authorization, artifact,
  policy, reviewer, expiry and revocation checks.
- Canonical launcher/observer integration, branch/replacement lineage and
  durable participation by every potential writer.
- Complete coverage of declared effects while pending, beyond the named SDK
  inference and native-write fixtures.
- Genuine authenticated reviewer journeys, including unauthorized
  dismissal-only behavior and independent native/web surfaces.
- Durable crash recovery, unknown-writer exclusion and gateway checkpoint
  persistence; no automatic stale-lock takeover.
- Exactly-once crash delivery and durable one-use recovery reconciliation.
- Cross-host stale-final/publication rejection after replacement or new input.
- Human decision-source/authentication strength and same-OS threat boundaries.
- Clean standalone installation, each advertised host/provider, distinct
  Windows/WSL acceptance, proposed race iterations and staging soak.

No production promotion or current completion claim follows from this record.
Recovery must preserve checkpoint data; deleting a live lock or journal to
make a test pass is not a repair.
