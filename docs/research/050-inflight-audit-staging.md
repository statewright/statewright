# In-flight audit and staging dogfood

2026-11-09; source base a882bfe27b076f3fa673c16fed769387ad30a459.
Ben accepted the 41.6% frozen projection for staging dogfood and authorized the
staging/dev in-flight MCP control. No production release, S1 enablement or workflow
activation is part of this delivery. Native get_state: no active workflow;
execution remains shelved while repairing the classifier.

Scope: run-local audit control, checkpoint identity, MCP discovery, private staging
capture storage, full-tree staging release through the existing controller.
Preserve canonical dirty sources and unrelated worktrees. No alternate launcher,
native trust automation, hosted private argv, corpus execution or guard bypass.

Budget observed_only: 60min normal/90min contraction for source and release
preparation, 100/140 tool calls, 20% reserve for validation/review/handoff. Cluster
build duration is tracked separately; inspect the exact owned job and retain its
failed receipt if it exceeds the supported build timeout. Provider token counts
are unavailable; do not estimate them as telemetry.

Acceptance: bound mode audit/enforce, exact run+session generation+revision,
production hidden and denied, terminal/foreign/replay rejected, no definition or
transition mutation, current host/review guards retained, private durable intake.
Database-backed checkpoint persistence is distinct from a memory-only gateway;
responses expose that distinction explicitly. New runs reset the override.

Independent review found whole-session replacement and false durability claims.
Repairs atomically CAS only audit fields, preserve concurrent pending review/state,
conditionally roll back the same generation/revision, and return the exact rollback
snapshot for compensation. Checkpoint writes use that explicit snapshot, never a
fresh successor lookup under an old run ID. Tests cover pending-review arrival,
transition preservation, successor/revision rejection and database connection
failure. Serialization round-trip is not proof of database recovery.

Validation receipts are retained under /Volumes/sidecar/build-tmp/:
inflight-audit full v1 failed three catalog expectations after adding a new tool;
these were updated to assert the new explicit mutating annotation and trusted-env
catalog size, not to weaken existing read annotations. Default full v2 passed526
with8 ignored; metering v3 passed534 with21 ignored before final explicit-snapshot
compensation repair. Final repaired checks and deployment outcome must be recorded
in a separate candidate-bound receipt. No earlier pass substitutes for final bytes.

Live staging preimage observed: application e9624a4, gateway43289e9 on both surfaces,
server e9624a4-43289e9. Gateway43289e9 is an ancestor of source candidate a882bfe.
Use controller /Volumes/sidecar/.agent-worktrees/auldwyrm-human-events-stage-20261107,
base77bf85d, Auldwyrm runtime e9624a4901ec5d42046fbc5fb58728016688d738. Do not use
canonical main's obsolete staging pins. Namespace remains statewright-dev.

Rollback: full-tree controller and source preimages in the receipt, not gateway-only
replacement. Audit defaults enforced; a new persistent intake is staging-only and
must be retained on workload rollback. Native local plugin installation and live
in-flight workflow acceptance remain distinct gates from backend deployment.
