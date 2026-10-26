# ADR 002: Guard and narrowly repair Codex paginated resume history

Status: Accepted

## Context

Codex's paginated history projector can stop permanently when a restarted TUI
appends `thread_settings_applied` with the same ordinal as the immediately
preceding record. The canonical JSONL continues to receive complete turns, but
the derived `thread_history_1.sqlite` cursor remains at the first duplicate.
Later resumes reconstruct the stale projection, mark the projected tail as
interrupted, and hide valid user and assistant turns that remain present in the
rollout.

Statewright intentionally restarts Codex at route boundaries, so its managed
launcher is the earliest reliable point at which to prevent another silent
stale resume. The rollout is Codex-owned canonical data, while the paginated
SQLite tables are a rebuildable projection; modifying either requires an
auditable backup and a much narrower contract than generic JSONL cleanup.

## Decision

Before an explicit managed Codex resume, Statewright locates the single local
rollout for that UUID and inspects its ordinal stream. The default behavior is
fail-closed. Healthy, missing, non-paginated, selector-based, and non-UUID
resumes retain native behavior. A malformed record, ordinal gap, regression,
or ambiguous rollout is never repaired automatically.

Legacy rollouts are validated against their own canonical contract: one root
`session_meta` with the requested identity, record-shaped JSON objects with
non-empty types, no ordinal fields, unambiguous mode metadata, and a canonical
final newline. They never enter the paginated repair path. A file that mixes
legacy metadata with paginated ordinals fails closed.

The sole repairable anomaly is an `event_msg/thread_settings_applied` record
whose ordinal exactly repeats the immediately preceding ordinal. When the user
opts into `auto` repair, Statewright:

- follows Codex's native lock lifecycle: hold `.coordination.lock` while
  opening and locking the per-thread file, retain the thread lock through final
  manifest persistence, then reacquire coordination before closing and
  removing that file;
- resolves the same `CODEX_HOME`, top-level `sqlite_home`,
  `CODEX_SQLITE_HOME`, and command-line `sqlite_home` override as the child,
  including compact `-c` spellings and `-C/--cd`-relative environment or CLI
  paths. Config-file-relative paths use the defining Codex-home layer, and the
  guard fails closed when a configured storage root cannot be resolved;
- takes a byte-for-byte rollout backup and a consistent SQLite backup in a
  private directory;
- records hashes, exact paths, thread identity, repair count, and rollback
  instructions in a manifest;
- streams a candidate that omits only recognized duplicate settings records;
- requires a canonical `session_meta` whose embedded ID matches the requested
  UUID, starting at zero for standalone history or at the validated inherited
  boundary for a fork, valid JSON, contiguous ordinals, the same final ordinal,
  and the expected semantic hash;
- compares source identity and hash immediately before atomic replacement; and
- transactionally removes only that thread from `thread_items`,
  `thread_turns`, `thread_realtime_items`, and
  `thread_history_projection_state`.

Forked paginated rollouts may contain only a local suffix. Their `history_base`
names a parent thread, exclusive ordinal boundary, and exclusive byte boundary;
the local `session_meta` starts at that ordinal, not necessarily zero. Validate
the reference shape and any accompanying `forked_from_*` fields, then validate
the exact parent prefix (including identity, contiguous ordinals and a complete
final line). Follow nested bases with cycle detection and a bounded depth. Later
parent records are outside the inherited prefix and do not affect the child.
Missing, ambiguous, malformed or inconsistent ancestry fails closed. Inspection
never renumbers history, modifies an ancestor, or resets its projection. This
contract is grounded in the native fork metadata observed during the October 26
resume failure: local first ordinal and inherited exclusive boundary both
47294. Regression fixtures cover local suffixes, nested ancestry, invalid
references, and preserving parent bytes during the existing child-only repair.
Ancestor prefix hashes are retained and rechecked immediately before child
replacement; parent-tail appends are permitted. This is not a multi-ancestor
atomic lock. Malformed fork records do not enter the standalone partial-write
repair path.

October 26 validation: the new positive fork fixture failed on the old guard;
the repaired history and plugin-runtime contract suites passed 39/39. The
actual affected history passed both inspection and the launcher's guard-mode
preflight without mutation (SHA256
`7d2481866a6d65baa13a6c04e503c5f61f5e2c9280d87524698761c7e9c9f0c1`).
Codex and Claude generated-runtime consistency checks passed. Independent
static review identified the ancestor CAS and malformed-fork repair cases;
both were fixed and re-reviewed with no remaining blockers. This evidence
does not claim a native interactive resume, whole-workspace suite, or gateway
deployment. Local Codex runtime build identity: `0.3.5+codex.20261026200121`.

The manifest journals preparation, rollout replacement, projection commit, and
completion with file-synced artifacts and atomic manifest replacement. The
backup root's parent and the backup root itself are directory-synced before
canonical replacement, so a durable mutation cannot outrun the new backup
directory entry. A
failure before projection commit restores the rollout backup. A failure after
projection commit retains the mutually consistent repaired rollout and cleared
target projection rather than restoring the defect. Statewright does not
rewrite Git history, remote telemetry, other Codex sessions, prompt content,
or response content.

## Security and privacy

Inspection and repair are entirely local. User-facing errors name the defect
class but do not include transcript content, filesystem paths, or the full
thread identifier. The detailed manifest remains mode-0600 beneath a mode-0700
backup directory. Error reporting receives the sanitized exception message;
the detailed inspection object is non-enumerable.

## Consequences

- Managed resume no longer silently presents a known-stale projection.
- Opted-in users recover complete canonical history without a broad database or
  transcript rewrite.
- Automatic repair currently requires a POSIX runtime with Perl advisory-lock
  support and a Node runtime that provides `node:sqlite` backup support. Other
  runtimes fail closed with an upgrade or guard-mode instruction.
- Custom Codex and SQLite homes are protected rather than silently falling back
  to `~/.codex`; unresolved configured roots block the resume.
- Each repair leaves a deliberate full projection-database backup. Operators
  may prune it only after independently confirming the rebuilt thread and no
  longer needing rollback.

## Rollback

Stop every Codex writer before rollback. Restore the exact rollout and use the
manifest's target-scoped SQL to restore only this thread's projection rows.
Restoring the entire shared projection database is offline disaster recovery:
it rewinds every other thread changed after the backup and must not be the
normal rollback. Revert this ADR and the history-integrity preflight to remove
Statewright's interception. Setting `codex_history_repair` to `guard` retains
detection without automatic mutation; `off` restores native unmanaged resume
behavior for diagnosis.

## Rejected alternatives

- Deleting only the projection rows re-encounters the duplicate and stalls at
  the same ordinal.
- Advancing only the projection cursor skips canonical input and leaves an
  internally inconsistent page boundary.
- Trusting Total Recall as the primary fix recovers semantic context but does
  not repair Codex's native resume projection.
- Generic ordinal renumbering or broad history scrubbing changes more
  canonical data than the observed defect justifies.
- Silent automatic repair for every managed user would mutate host-owned
  history without an explicit local policy choice.
