# P0/P1 approval journal and resume ownership

Date: 2026-09-17. Status: implementation in progress; no release or live approval claim.

## Manual run contract

User objective: continue P0/P1 approval-journal and resume-ownership work directly,
without loading or using a Statewright workflow. No supervising workflow was
queried, activated or loaded. Only deterministic local fixtures are authorized in
this slice; no live workflow, real approval, provider inference, deployment or
existing managed/native session is touched.

Entry checkout: `/Users/ben/dev/auldwyrm`, main at `65025b5`. Owning runtime:
`/Users/ben/dev/statewright`, main at
`4a6ce365ee86a4e19c50feb32fe48ea5c62579db`. Specs 111 and 116 in Auldwyrm point
to this canonical runtime. Both worktrees were already dirty. Preserve grant,
website, gateway usage, canary and host work not owned by this slice.

Acceptance remains the full P0 shared approval/request-ownership contract in
`006-control-plane-host-feasibility.md` and the P1 host/authority/restart contract
in `012-pi-approval-p1.md`. Vendor transport-only evidence in 007 is not evidence
of a complete live pause/decision/resume journey.

## Slice 1: durable, fail-closed journal reconciliation

Owned files: shared `approval-journal.mjs`, `runtime-approval-service.mjs`,
`executor-approval-mirror.mjs`, `statewright-exec.mjs`, their focused tests, and
this receipt. Includes repair of pre-existing incomplete mirror wiring. Excludes
Pi/Gateway behavioral changes, canary tooling and managed-supervisor edits.

Required invariants:

1. Park acknowledges after file sync and atomic publication; POSIX also syncs
   the containing directory. Windows directory-sync support is not claimed.
2. Park/clear mutations are exclusive across journal instances/processes. An
   unresolved checkpoint cannot be overwritten, including corrupt checkpoints.
3. Missing/foreign run or session, changed ticket/edge, malformed pending state,
   unavailable authority, pending receipt and rejected receipt retain the journal
   and deny continuation. Target-state coincidence is not a decision receipt.
4. Release requires the approved authoritative ticket and the matching applied
   target state. The mirror never calls `resolve` or opens reviewer UI.
5. The stable private storage namespace includes credential fingerprint,
   gateway, host, workflow, project and checkout. It must not replace the real
   authenticated transport client header used for receipt reads.
6. Initial journal failure prevents host launch; poll-time failure stops only
   the owned child and propagates. In-flight reconciliation drains before host
   observation returns. A pending approval cannot trigger routed restart.

Observed red baseline: 12 of 16 mirror regressions failed on the previous source.
Failures included destructive missing/foreign reconciliation, foreign-session
restore, malformed pending-state admission and unapproved target-state release.

Validation commands (deterministic fixtures, no live workflow):

```sh
node --test plugins/executor/tests/approval-journal.test.mjs
node --test plugins/executor/tests/executor-observer.test.mjs plugins/executor/tests/executor-approval-mirror.test.mjs plugins/executor/tests/runtime-approval-service.test.mjs plugins/executor/tests/executor-contract.test.mjs
node --test plugins/executor/tests/human-approval.test.mjs plugins/executor/tests/approval-journal.test.mjs plugins/executor/tests/codex-approval-gate.test.mjs plugins/executor/tests/runtime-approval-service.test.mjs plugins/executor/tests/codex-native-approval-proxy.test.mjs plugins/executor/tests/codex-app-server-transport.test.mjs plugins/executor/tests/managed-ownership-races.test.mjs plugins/executor/tests/executor-approval-mirror.test.mjs plugins/executor/tests/executor-observer.test.mjs plugins/executor/tests/executor-contract.test.mjs
git diff --check
```

Initial focused evidence: journal 18/18 pass; mirror/service/observer/executor
57/57 pass. Initial wider integration 197/197 pass, then 203/203 after
post-receipt state revalidation and the first review repair. Final integration
after both repairs and explicit cross-process locking fixture: 210/210 pass,
zero failures, skips or cancellations (exit 0). Local limits are
observed-only: one serial slice, no implementation fan-out, at most one bounded
reviewer, two focused repair attempts per discriminating finding, one wider
fixture gate and 30 minutes before a compact handoff. Preserve review/validation
capacity; no provider-token enforcement or model-price claim is made.

Decision: strict identity/authority checks replace snapshot-based deletion and
warning-only journal errors. Existing version-1 Codex journal envelopes remain
readable. The new executor namespace must not auto-adopt legacy ambiguous
executor checkpoints; legacy namespace handling remains an explicit recovery
requirement below. Rollback is a coherent revert of the slice, never deletion of
live checkpoint files or schema-only rollback while a gate is pending.

## Remaining full-objective requirements

- Stable executor transport/native ownership is implemented in slice 2 below;
  live native restart and complete approval journeys remain unverified.
- Journal crash recovery: an exclusive `.lock` left by a killed writer must not
  be broken by age alone or treated as proof of a live writer. Prove liveness and
  safe recovery, or retain an explicit recovery-required outcome. No automatic
  stale-lock takeover is implemented in slice 1.
- Legacy executor namespaces: slice 2 preserves/denies known ambiguous namespaces
  plus opaque raw-URL legacy journals for the same workflow through bounded
  inventory. Explicit operator recovery/mapping remains unimplemented.
- Pi must not instruct the model to approve via `statewright_transition`.
  Approval decisions remain private authorized-human operations.
- Pending Pi approvals must park inference, not merely return tool errors to
  a still-running model. Waiting uses transport polling; rejection, disconnect,
  dismissal, timeout and replacement input cannot resume old work.
- Verify exact ownership/request epochs and once-only continuation for the full
  resume journey across restarts, newer input, concurrent processes and races.
- Canonical/generated-runtime parity and scoped local milestone commit/review
  receipts remain required; installed live runtimes are not to be mutated here.
- Live authorized Pi/Codex acceptance and any broader advertised host cases stay
  unverified, not substituted with the reference-PB canary or vendor form smoke.
  Production promotion remains held.

Next action: finish slice-2 integration/review, then implement Pi authority-safe
inference parking and request epochs with deterministic race fixtures. Do not run
the workflow-loading canaries under the current no-workflow instruction.

## Independent review and repair receipts

Reviewer: controller-created clean-context read-only task
`/root/approval_journal_review`. No implementation edits, provider inference,
workflow calls or live-session access. Review limited to the named slice files.

- R1: a previously requested reroute remained latched after a later poll saw a
  pending gate. The new `executor-observer.test.mjs` interleaving reproduced
  `pending gate restarted` (5 pass, 1 fail). The post-exit restart guard now checks
  the latest pending gate. Observer tests 6/6 pass. Independent source re-review
  confirmed closure.
- R2: false/zero/empty-string `pending_approval` values were treated as absent,
  both initially and after the receipt read. Six fixtures reproduced the issue
  (21 pass, 6 fail). Only null/absent is now absence; malformed values deny.
  Mirror/observer 33/33 pass. Fresh independent focused re-review independently
  ran all six cited regressions: 6/6 pass; no additional repair-scope findings.

Generated Claude managed-client bundle `--check`, syntax checks and
`git diff --check` passed. None of this is installed-runtime, staging, Windows
native fsync, authenticated vendor-turn or complete P1 resume acceptance.

Slice-1 gate map: invariants 1 and 2 have the journal fsync/publication/error and
in-process/separate-process exclusion fixtures; invariants 3 and 4 have the
mirror foreign/malformed/rejected/unavailable/post-receipt state fixtures;
invariant 5 has namespace-isolation and actual header assertions; invariant 6
has observer prelaunch/poll failure/drain/latched-reroute fixtures. All pass in
the final 210-test gate. The existing Codex lifecycle/proxy/request-epoch fixtures
also pass against the changed shared journal. Review R1 and R2 are fixed and
independently rechecked; no other slice-scoped findings remain open.

The coherent local milestone commit includes this receipt and the nine named
owned source/test/receipt files. Its identity is recoverable with
`git log -1 -- docs/research/015-approval-journal-resume-ownership.md`; no push,
merge, deployment or live acceptance is part of the commit. Other pre-existing
worktree changes remain deliberately outside this boundary.

## Slice 2: explicit transport/run/native ownership

Base: `770b68c7fa992daaa1310f334bd42b10fe3b577b`. Decision and compatibility
boundary: `docs/adr/006-explicit-executor-session-ownership.md`.

Owned files: new executor ownership module/tests; shared remote client and its
repository-generated Claude copy; mirror, host adapters, executor and focused
tests; new Pi SDK session descriptor and SDK-only fixture; exact-run gateway
selector/tool advertisement hunks; this receipt and ADR. Existing gateway
approval tool denial, Pi extension, managed supervisor, canary and research
changes remain outside this commit.

Acceptance for this slice: explicit session selector, stable saved transport and
native identity, private durable records, exclusive process ownership, exact
run reattachment/resume with no new-run fallback, malformed/foreign admission
denial, immutable known legacy checkpoints, and ordinary new-host compatibility.
This does not replace the remaining full-objective requirements above.

Characterized baseline: executor minted transport/native UUIDs per launch;
gateway could select latest paused run; Pi launch passed unsupported
`--session-id`. Current SDK source establishes the actual native parser and
silent repair behavior. First SDK-bound fixture failed with
`ERR_PACKAGE_PATH_NOT_EXPORTED`: public SDK exports are ESM-only. Resolution now
uses a tiny Pi-root ESM module importing its public SDK, not a private-path or
global-package fallback.

Focused evidence: ownership/remote/environment 24/24 pass; ownership/observer
20/20 pass; ownership/host/installed-public-SDK 20/20 pass. Separate-process
fixtures prove duplicate exclusion, exact saved identity after release/reopen,
and recovery-required after an exited owner leaves a claim. Native SDK reopening
is file-only, with no inference or transport to a live gateway.

Gateway library fixtures before final formatting: no-default-features 205 pass,
1 ignored; metering-enabled 206 pass, 3 ignored, zero failures. The optional
PostgreSQL exact-selector and pause/resume tests are ignored and not execution
evidence. `cargo` was absent from this tool shell PATH; the installed absolute
`/Users/ben/.cargo/bin/cargo` resolved that environment issue. No validation
boundary was weakened. Full package formatting check reports unrelated existing
format drift; scope-only formatting is applied without editing those files.

Wider deterministic gate: the ten slice-1 approval/lifecycle fixture files plus
ownership, remote client, host adapters, installed Pi SDK fixture and Claude
managed bundle fixture: 243/243 pass, zero failures, skips or cancellations
(exit 0). `sync-managed-client.mjs` regenerated the repository copy of the
shared remote client; `--check` passes. No installed runtime was synchronized.
Scope syntax/whitespace checks and independent review receipts follow once run.
No live workflow-loading canary is allowed under the manual run contract.

Staged-only validation (unrelated dirty edits excluded): index tree
`9987cc5b65c8d6af206c838c017d531a4c43c062` exported with `checkout-index` to a
temporary snapshot, with only installed dependency-directory symlinks.
Node 243/243 pass; gateway metering 204 pass/3 ignored; no-default 204 pass/1
ignored. These counts exclude the unrelated pre-existing Gateway adapter and
remote branch-usage tests. Existing compiler unused-variable warnings remain.

The exact-selector PostgreSQL fixture was separately executed against a new
disposable cached `postgres:17-alpine` database published only on loopback. It
uses connection-local `pg_temp` storage; no live workflow/run/approval storage.
Command: `cargo test -p statewright-mcp-gateway --features metering --lib
gateway::tests::exact_resume_selects_owned_run_not_latest_candidate -- --ignored
--exact --quiet` with the fixture-only `STATEWRIGHT_TEST_DATABASE_URL`. Result:
1/1 pass, zero ignored. Older owned run selected despite newer candidate;
missing run/wrong project denied, paused rows unchanged. Container
`c32aa4a5469dc04b88f90609b8bd4fecbfe7a3c2e0c565febe4f8a437c620d90` was stopped;
`--rm` removed its disposable fixture data. Existing containers untouched. The
other ignored PostgreSQL/authority tests are not acceptance evidence.

Independent clean read-only reviewer `/root/executor_ownership_review` found:

- R3: canonical store ownership and raw-URL journal keys disagreed; a URL alias
  could hide the owner's old checkpoint. Regression reproduced unequal keys.
  Shared endpoint normalization now governs transport, ownership and owned
  journal identity; legacy raw-key inventory holds ambiguous old checkpoints.
- R4: native SDK first-turn flush appended the header twice; the strict duplicate
  rejection then prevented ordinary resume. Public SDK user/assistant/reopen
  regression reproduced denial. Accept only an identical owned bootstrap header
  as required by the installed SDK; do not seed production assistant messages.
- R5: a `{type:"message"}` row and complete row lacking final newline were
  admitted. Regression reproduced missing rejection. Native v3 structural,
  payload and ancestry checks plus append-safe newline now deny malformed
  history without altering rejected bytes. The SDK fixture also covers later
  settings, custom metadata/messages, labels, compaction and branch summaries.

Discriminating red gate: 37 pass/3 fail before these repairs. Focused post-repair
gate: 61/61 pass, then ownership/expanded SDK 15/15 pass. Reviewer independently
ran the original index-only focused gate (70/70 pass) and file-only fixtures
that disproved native first-turn compatibility; those initial green tests were
not sufficient evidence.

Fresh reviewer `/root/executor_ownership_recheck` independently ran 69/69 focused
and 7/7 environment/bundle tests against the staged-only snapshot. R3/R4 and the
original R5 reproductions closed. New R6: an absent/off-branch compaction boundary
could silently discard retained messages despite valid JSON and parent ancestry.
The SDK-only regression reproduced missing rejection (1 pass/1 fail). The
validator now requires the boundary on that compaction's own prior parent chain;
focused native tests 10/10 pass. Fresh bounded read-only recheck by
`/root/executor_ownership_review` independently verified 10/10 tests, four valid
public-SDK boundary/compaction cases and three denied malformed cases with bytes
unchanged. Staged blob hashes match the reviewed snapshot; no further
repair-scoped finding. No reviewer authored repairs.

Final staged source snapshot tree
`687ae1c6fbd86e39082cd67a8e14c192886dda3f`: wider gate 249/249 pass, zero
failures, skips or cancellations; source syntax, generated bundle `--check`,
staged and worktree whitespace checks pass. Final receipt/ADR-only updates do not
change those tested source blobs. Rust selector source is unchanged from the
staged-only metering/no-default and disposable SQL fixture gates above.

Additional affected supervisor/bridge/proxy gate (four fixture files): 58 pass,
4 fail, zero skipped. Failures are telemetry/shim-bootstrap cases caused by
`existsSync` referenced without its import in the base managed supervisor.
All four reproduce against a clean archive of base `770b68c`; no source from
this slice is present there. The two canonical/generated supervisor files have
an already-existing unstaged one-line import fix in the original checkout;
preserve it outside this ownership commit. This is a pre-existing broader-suite
failure, not a full-package pass or a repair claimed by this slice. Full workspace
tests, live host acceptance and promotion remain unverified/held.

Commit boundary: 18 explicitly staged paths; exact selector hunks only in the
mixed Gateway file. Pre-existing approval tool-denial hunks and every other
unrelated change remain unstaged. Entry Auldwyrm worktree is untouched. The
agentic-engineering/SDLC guidance supplied durable ADR, independent review and
Git/evidence gates; the user's manual/no-workflow restriction overrides workflow
activation. One serial implementer and at most one read-only reviewer at a time;
no provider/model-price or runtime-quota enforcement claim.

Next safe slice: Pi authority/inference parking, then explicit input epochs and
once-only continuation through the owned adapter. Installed SDK 0.73.0 evidence
to carry forward: `agent-session.js:709-716` handles an input result before model
authentication/possible compaction; `:776-813` emits `before_agent_start`, then
unconditionally calls `agent.prompt`; `extensions/runner.js:700-745,793-835`
catches hook exceptions, and `agent-session.js:1057-1060` aborts a currently
running agent. A mocked `ctx.abort()` call or thrown hook error is not proof that
an upcoming native turn/compaction is parked. Establish a discriminating native
SDK fixture before implementing that boundary. Preserve existing Pi/Gateway
P1 edits while fixing the model self-approval instruction and waiting lifecycle.
Do not run any workflow-loading canary under the current instruction.

## Slice 3: Pi fail-closed native admission

Base: `16732d7a5cabd11c3b1963ff619785a1fd1bdbbf`. This is the first
admission/hold boundary, not the complete P1 waiting/continuation milestone.
Adopt only the already-dirty Pi extension and its approval tests within scope;
preserve all Gateway, canary, usage and supervisor edits outside this slice.
Owned additions: Pi approval-hold helper, actual installed-SDK prompt/runner
fixtures, executor Pi launch/stop hold fixtures, ADR and this receipt. The Pi
test-runner configuration must keep native `node:test` fixtures out of Vitest
discovery, and run them explicitly rather than silently omit them.

Invariants: a pending/malformed approval or unavailable managed transport
returns the native `input` event's `handled` result before authentication,
compaction, queueing or agent inference. Exceptions from UI notification must
not turn the hook into fail-open continuation. Once held, a projection becoming
absent does not release this process. The model is never told to approve;
model tools (including Statewright transitions) and recovery are held as well.
The parent denies a parked Pi launch and stops only its owned Pi child when a
poll durably observes a pending checkpoint; no automatic old-input continuation.

Cut line: receipt-driven long polling, persisted request epochs, cancellation
and exactly-once continuation are still required subsequent work. The safe
intermediate behavior is an explicit hold, not an implicit approval or an
automatic retry. No live workflow, provider inference or existing session is
touched. One serial implementer, one bounded read-only review and deterministic
local fixture gates only. Full original acceptance and promotion remain held.

Primary SDK provenance (installed dependency, not a pinned peer contract):
version 0.73.0; SHA256 `dist/core/agent-session.js` =
`84687393bb0db810b93b6e632815ae5e54e1e0ebc17690ec1c4419791c73619f`,
`dist/core/extensions/runner.js` =
`dab1eadccdd73b6bb50bbd22b464461c65eca77f368d2b44e5e9af4cbcc18d4d`.

Red/characterization: the first actual-SDK prompt/runner and adopted Pi tests
had 11 failures, 53 passes: pending/malformed/disconnected/UI-failure input
reached authentication/compaction/inference, model transitions were exempt,
and projection absence released old work. The inference boundary is a terminal
fake-agent counter, not real inference. The three new parent hold fixtures also
failed on the old source; one unbounded red fixture was terminated by its exact
task-owned PID, then repaired to finish its own fake child for bounded negative
validation. No existing live session was signaled.

Pi's initial `npm test` gate showed 54 pass/1 opt-in canary skip and one failed
suite because Vitest discovered the prior slice's `node:test` session fixture.
The configuration now routes TypeScript tests to Vitest and adds an explicit
`npm run test:native` command (2/2 pass), rather than claiming those files were
run by Vitest.

Initial isolated staged-only snapshot:
`dad89d6a0186a1e3aba012972c729a5a7062d5dc`, exported under
`/tmp/statewright-pi-hold.mHTYPO/staged` with installed dependency directories
symlinked. Approval/Codex/ownership/observer/remote/native/generated-bundle
integration: 252/252 pass, no failures/skips/cancellations. Pi 67 pass with the
single pre-existing opt-in live canary skipped; extended admission coverage
subsequently passes 20/20 focused cases (interactive/RPC/extension input,
malformed/absent state, stream queueing, initial disconnect, UI failure and
actual SDK tool-hook non-awaiting abort). Final gate/review pending below.

Syntax checks, generated Claude managed-client `--check`, cached/working
`git diff --check` pass. No Pi package-specific TypeScript/lint/format
configuration is present; Vitest transform is not a full type-check claim.
Rust is unchanged by this slice; prior Rust gates are not relabeled as fresh.
Full workspace, live/native provider approval journey, Windows process shutdown,
staging and promotion remain unverified/held.

Next slice must connect fresh native admission to the parent-owned private
receipt and persisted request epoch, not add a model resolver or release from
raw projection absence. The ownership record's current `request_epoch` remains
reserved/unused. Coordinate journal clearance with durable once-only release
consumption; a crash between consumption and native acceptance must hold
explicitly, never blindly replay. Verify newer input, rejection, disconnect,
dismissal, timeout, concurrent processes, run replacement, mid-await recovery,
automatic retry/compaction and SDK request-boundary races. These remain original
requirements, not omitted acceptance.

Independent clean-context read-only review:
`/root/pi_admission_hold_review`, ten named owned paths against base 16732d7.
Reviewer independently ran staged native admission 13/13, coverage-extended
admission 20/20, executor observer/contract 16/16 and additional helper callback
failure/monotonic fixtures. No reproducible must-fix within the explicit
hold-only cut line; no full-P1 approval verdict. Nonblocking gap was direct
recovery/inactivity coverage; a new fixture arms normal inactivity, admits a
valid pending projection through native input, then fires held error recovery
and advances ten minutes. No user-message delivery, exec or additional gateway
traffic occurs. The tightened fixture also proves one armed mock timer is
removed and exercises both error auto-retry and non-error embedded-tool recovery.
Focused repair 1/1 passes. Independent same-file recheck 1/1 passes (54 tests
filtered by the single-test selection), closing this mock-timer/extension
coverage gap. Native in-flight inference cancellation is not proven by it.

Final isolated gate snapshot:
`9a15555de22f884ada26e158ab85a28e57a67e45`, exported at
`/tmp/statewright-pi-hold-gate.r5Ip0v/staged`. Node integration 252/252 pass
(zero skips/cancellations), Pi 75 pass/1 pre-existing opt-in live-canary skip,
exit 0. Generated managed-client parity and both changed MJS syntax checks
pass. No failure is relabeled as a pass. Subsequent receipt-only edits do not
change validated source/test blobs.

Exact final fixture commands, run from the staged export (Pi commands from its
`plugins/pi` directory):

```sh
node --test plugins/executor/tests/human-approval.test.mjs plugins/executor/tests/approval-journal.test.mjs plugins/executor/tests/codex-approval-gate.test.mjs plugins/executor/tests/runtime-approval-service.test.mjs plugins/executor/tests/codex-native-approval-proxy.test.mjs plugins/executor/tests/codex-app-server-transport.test.mjs plugins/executor/tests/managed-ownership-races.test.mjs plugins/executor/tests/executor-approval-mirror.test.mjs plugins/executor/tests/executor-observer.test.mjs plugins/executor/tests/executor-contract.test.mjs plugins/executor/tests/remote-client.test.mjs plugins/executor/tests/host-adapters.test.mjs plugins/executor/tests/executor-session-ownership.test.mjs plugins/pi/tests/session-owner.test.mjs plugins/claude-code/tests/managed-client-bundle.test.mjs
npm test -- --reporter=dot
npm run test:native
node plugins/claude-code/scripts/sync-managed-client.mjs --check
node --check plugins/executor/statewright-exec.mjs
node --check plugins/pi/src/approval-hold.mjs
```

Original acceptance-source SHA256: 006 =
`6f9c9a84eaadc3f026844d942ad643254e0c87a5794272d1ad7c97c111fab218`;
012 = `6197628edd0156d59dc135b57d2b1eba6bd25cdb556808ec1a1197d399e70fd8`.
012 remains a pre-existing untracked user artifact, not adopted into this commit.
The ten-path local commit contains only this reviewed hold boundary and its
receipt/ADR/fixtures/configuration. Every unrelated entry in the initial dirty
inventory remains unstaged; Auldwyrm is untouched. No push, merge, deployment,
installed-runtime update or workflow use. Full objective remains in progress.
The agentic-engineering guidance supplied ADR, scoped Git boundary, isolated
validation and independent review; manual/no-workflow authority took precedence.
