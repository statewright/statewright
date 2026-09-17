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

## Slice 4: parent-owned request epochs and receipt-driven Pi waiting

Base: `58625323c8475afe09896102af397131a13f5504`. Original full P0/P1
acceptance remains unchanged. Replace the intermediate managed-Pi hold-only
behavior with real transport waiting and a private receipt/owned-edge release,
not projection-based admission. Unmanaged/older-parent sessions stay explicitly
held rather than acquiring an unproven resolver.

Owned scope: executor session ownership/request-record validation, request
controller, approval mirror, authenticated private adapter hooks, main wiring;
Pi request gate and extension integration; their deterministic request-race,
bridge and installed-SDK fixtures; ADR/this receipt. Preserve every already-dirty
Gateway/usage/canary/supervisor/OMX artifact. No workflow, real approval, provider
inference, live-session inspection or deployment. Product workflows may remain
supported in code; fixture execution does not load one.

Required invariants: the parent mints and durably advances epochs; only exact
current native/run/session/request identity admits work. New input invalidates
older waits, including out-of-order async responses. The model cannot supply a
decision, a checkpoint or an authoritative epoch. Pending waiting is outside
inference. Release requires private approved receipt, freshly applied owned edge,
durable once-only consumption and a final current-request check; then and only
then can the same native callback proceed. Rejected/unavailable/foreign/cancelled/
dismissed/disconnected/timed-out work cannot resume. Persist consumption before
clearing the shared journal; an ambiguous crash must hold, never blindly replay.

Validation plan: red/characterization, focused durable record/controller/race
fixtures, authenticated bridge fixtures and actual public-SDK native admission,
then one staged-only approval/ownership integration gate and independent
read-only review. Limits observed-only: one serial implementer, one reviewer,
60 normal/90 worst tool calls, output <=16 KiB/call, 30-minute warning/45-minute
handoff, at most two distinct focused repairs per finding. Protect the last third
for validation, review, recovery and recording; no usage-enforcement/model-price
claim. If integration is not proven, do not mark the original objective complete.

Activation decision after direct installed-SDK inspection: the extension
context's `abort()` discards the AgentSession idle promise. Input-only fixtures
cannot prove in-flight queue/provider/retry/compaction cancellation. Preserve
the full requirements, but contract this local commit to the independently
usable durable parent protocol and private native gate, with actual public-SDK
input/tool-hook fixtures. Do not wire executor main or the shipped extension
until the remaining boundaries have discriminating proof. ADR 008 records the
interface, crash semantics and activation conditions; ADR 007 behavior remains
active. This is a prerequisite, not a replacement acceptance criterion.

Current focused outcomes: original request-controller run had 14 fixture
teardown failures because FIFO cleanup removed the task-owned temporary root
before owner release; product assertions passed, but that run is NOT a pass.
One combined cleanup (release then remove exact mkdtemp root) repaired the
fixture; 14/14 passed. Extended controller/race/schema fixtures subsequently
pass 19/19 and bridge fixtures 6/6. Installed-SDK private wait fixtures first
passed 20/20; after adding three exception/transport cases, 22 passed and one
failed in SDK dispose because the test's identity-read spy still threw during
teardown. Restore spies before SDK disposal; this is a bounded fixture cleanup
repair, not a product fix or a passing failed run. The fresh gate follows below.
The shared synthetic authority fixture throws if any resolver is called and
reads the disk ledger before permitting journal clearance. Known delivery
failures after consumption now durably cancel and cannot replay via status.
Reopen preserves epochs/tombstones but rejects an old request reference.
Full staged integration and independent review follow below; original full
acceptance remains active and unproven.

First staged-only full gate: snapshot
`5e6943c56261ed3c5958a43af39ff668b97d63b2`, exported to
`/tmp/statewright-request-gate.5Bp5fQ` with only installed dependency directories
symlinked. Node approval/ownership/observer/native/generated integration 280/280
passes, no skips/cancellations/failures. Pi Vitest 98 pass, one pre-existing
opt-in live-canary skip; explicit `npm run test:native` 2/2. Generated Claude
managed-client parity and six changed MJS syntax checks pass; cached diff check
passes. No Rust source is in this slice, so prior Rust results are not recast as
fresh. No package-specific full type-check/lint/format gate exists for Pi;
Vitest transformation is not such a claim. These results bind to this snapshot,
not later repairs or full workspace correctness.

The same installed SDK source hashes were rechecked live: version 0.73.0,
AgentSession SHA256 `84687393bb0db810b93b6e632815ae5e54e1e0ebc17690ec1c4419791c73619f`,
ExtensionRunner SHA256 `dab1eadccdd73b6bb50bbd22b464461c65eca77f368d2b44e5e9af4cbcc18d4d`.
Peer wildcard remains unpinned; no wider SDK-version support claim.

Clean-context read-only review `/root/parent_request_release_review` is limited
to the twelve staged paths, ten minutes/eight tool calls and one focused
challenge. No repeated wide gate, source mutation, live provider/workflow or
unrelated dirty artifact inspection is authorized for it. Review identified a
possible native session change during waiting; this is within the private gate's
exact-identity contract, not a deferred full-provider requirement. Reproduction,
repair and fresh focused re-review follow below. No review verdict is implied
by the passed fixture gate.

Review finding R1 (P1): a live native session could change after the initial
identity check while input was parked or a checkpoint awaited. The reviewer's
direct gate challenge returned `continue` after that switch. Three new actual
SDK regressions also failed on the staged source: changed-native parked input
and a late begin response each reached the terminal agent once, and an existing
request's tool checkpoint failed to block. Product defect, not fixture-only.
Repair rereads live native identity before private traffic, after responses,
before consumption and immediately before admission; changed/missing/throwing
identity stays held. Lazy native abort is never invoked against the foreign
replacement session. Fresh installed-SDK gate 26/26 passes.

A discriminating parent cancellation fixture additionally failed before repair:
old status remained admissible while the durable cancellation write was held.
Cancellation now synchronously invalidates the latest reference before awaiting
the write; current-reference validation repeats after its asynchronous ownership
check. That new fixture passes. The first combined parent rerun was 21 pass/5
failure because older cancel tests expected only the old `ended` error message;
they did correctly deny and retain journals. Tighten that assertion to the two
valid identity-denial reasons (`replaced|ended`), preserving the denial/journal
assertions. These failed/superseded results are not fresh passes. Focused rerun
and bounded re-review follow; no full acceptance verdict yet.

The first R1 re-review kept the finding open: the public input/checkpoint
wrapper awaited the inner wait result and did not reread identity after that
last handoff. A queued native-session change inside onActive still produced
`continue`. Two new actual SDK regressions reproduce this final-await window;
the earlier 26/26 gate did not cover it and is not approval. R1 repair attempt
two checks native identity and request activity after the public wait, just
before returning success; checkpoint captures its original request rather than
letting replacement substitute a newer one. Parent response view also repeats
the synchronous current-reference/closed check immediately before output.
Final focused gate and same-finding re-review follow below. This exhausts the
two distinct focused R1 repair attempts; do not open an unbounded repair loop.

Final R1 re-review by the same clean-context reviewer: closed within the
prerequisite boundary. Its repeated microtask challenges now yield input
`handled` and checkpoint `false`, both held with zero foreign-session aborts.
The synchronous parent response view also closes the reviewed cancellation
handoff. No remaining issue found in that bounded recheck; this is not full
native/provider/queue/recovery approval. Root's fresh focused gates: parent
controller + bridge 26/26; installed-SDK private gate 28/28.

Final isolated staged gate: snapshot
`d53cef31999a0943387a33d65be05f73be549e88`, exported to
`/tmp/statewright-request-final.pxSLTE`. Approval/Codex/
ownership/observer/remote/bridge/native/generated Node integration 281/281 pass,
zero skips/cancellations/failures. Pi 103 pass/1 pre-existing opt-in live-canary
skip; explicit native-session gate 2/2. Generated Claude managed-client parity
and each of the six MJS syntax checks return exit 0. No source/test edits after
this gate; following changes only extend the receipt. All failures and
superseded gates above remain recorded, not relabeled as successful.

Commands from the final staged export (npm commands from plugins/pi):

```sh
node --test plugins/executor/tests/{human-approval,approval-journal,codex-approval-gate,runtime-approval-service,codex-native-approval-proxy,codex-app-server-transport,managed-ownership-races,executor-approval-mirror,executor-observer,executor-contract,remote-client,host-adapters,executor-session-ownership,adapter-bridge,executor-request-controller,executor-request-bridge}.test.mjs plugins/pi/tests/session-owner.test.mjs plugins/claude-code/tests/managed-client-bundle.test.mjs
npm test -- --reporter=dot
npm run test:native
node plugins/claude-code/scripts/sync-managed-client.mjs --check
node --check plugins/executor/lib/executor-request-controller.mjs
node --check plugins/executor/lib/executor-request-record.mjs
node --check plugins/executor/lib/executor-session-ownership.mjs
node --check plugins/executor/lib/executor-approval-mirror.mjs
node --check plugins/executor/lib/adapter-bridge.mjs
node --check plugins/pi/src/request-gate.mjs
```

Manual/no-workflow authority overrides workflow activation guidance. Applied
agentic-engineering SDLC controls influenced the inactive cutline, ADR, staged
scope, source-bound fixture gates, protected review/recording reserve and
independent adversarial review. Budgets remain observed-only, not controller
enforcement; contraction protected the final gate/review/handoff rather than
promising unsupported native cancellation. No cumulative token/tool/time usage
enforcement claim. No Rust/full-workspace/type-check/live-native/staging or
promotion pass. Every unrelated initial dirty artifact remains outside this
twelve-path commit; Auldwyrm is untouched. No workflow/API approval/provider
inference/installed-runtime change/live-session signal/deployment/push.

Exact next slice, with full original acceptance retained: build discriminating
actual SDK Agent signal/onPayload, provider HTTP cancellation, queues/automatic
retry/compaction and recovery/follow-up correlation fixtures, then wire executor
main/observer/private bridge and Pi extension with readiness and exact native
identity, parent close/cancel and private outer references. Guard every async
effect and inference boundary; do not let SDK's extension-source follow-ups mint
new human-input epochs or leak an old queued message into replacement input.
Receipt + applied owned edge + durable current epoch + consumption + fresh
native identity all remain required. Prove the complete authorized native
journey separately before activation/promotion; never substitute these fake
authority/terminal-agent fixtures for that acceptance. Original goal remains
active, not complete or blocked.

## Slice 5: actual SDK agent/provider boundaries and idle admission

Previous turn: verified progress, local commit
`96a1dafbd1fdb5f3e87b4b97a2c34c0f7aab02d9`, source-bound gates and closed
native-identity/cancellation findings. Current status confirms that commit and
the same unrelated dirty Gateway/usage/canary/supervisor/OMX inventory. Full
P0/P1 objective remains unchanged; no workflow is queried/loaded/used.

This turn moves beyond terminal fake-agent input evidence: use public
createAgentSession and its real Agent, primary installed provider implementation
against a task-owned loopback synthetic streaming server, actual signals and
queues, private loopback parent protocol and durable owner/journal. No real
provider credentials, inference, approval resolver, workflow or existing native
session is used. Follow-up correlation, commands/recovery/effect async boundaries,
main/observer/extension wiring, restart and full native acceptance remain required
until actually proved; do not declare completion from this boundary alone.

Owned scope: Pi request gate, reusable native request-hook wiring, actual
SDK/provider fixtures and ADR 008/this receipt. Extend parent files only for a
discriminated protocol defect. Preserve every initial dirty artifact. Input
must invalidate old work, abort and wait for actual native idle outside inference
before returning to SDK admission, rather than assume ctx.abort awaits idle.
Provider/tool/compaction boundaries must await the current private receipt and
fail closed on cancellation, foreign identity or unavailable transport. Prove
that hook cancellation prevents even primary-provider synthetic HTTP dispatch,
not only that a mocked abort function was called. No model decision channel.

Provisional observed-only envelope based on prior local gates finishing in
seconds: one serial implementer, one final clean-context Astra/high read-only
review (skill-directed exception to no implementation delegation), 45 normal/
70 worst tool calls, <=16 KiB result per later call, 30-minute warning and
45-minute handoff, max two distinct repairs per finding. Preserve final third
for integration/review/recording/commit. At warning stop discovery, focus missing
proof; at contraction hand off exact remaining original requirements instead of
activating unproven code. No controller/token/quota enforcement or price claim.

Initial real SDK agent/provider run: two provider park/cancel cases passed;
normal control failed because primary provider represents user content as typed
parts rather than a string (fixture expectation repair). Both real agent-end
barrier cases failed: replacement input settled and entered SDK queues while
the old agent remained non-idle. Product defect, not an abort-counter proof.
Gate now explicitly waits native idle outside inference before input admission.
Checkpoint now requires the immutable private operation reference, preventing
an old callback from borrowing the latest input merely by reading current state;
native abort also checks the captured operation signal before touching it.

First combined rerun: 27 passed/6 failed, with two additional cleanup hook
timeouts. Actual-agent binding used agent_start before the SDK appended the user
message, so the new fail-closed reference check correctly refused a missing
binding. Repair fixture correlation at the actual context event after user
append, never weaken the reference check. Unreleased test-owned agent_end
barriers then stalled SDK abort in cleanup; always register barrier release
before assertions. A fake-agent fixture also read a throwing context signal
outside checkpoint's catch; keep that read inside the gate. These are bounded
fixture/evidence repairs, not reason to permit missing correlation or increase
timeout limits. No failed run is a pass; fresh results follow below.

Corrected combined fixture gate: 33/33 passed. Added actual AgentSession
automatic continue retry (not input/before_agent_start), primary-native drift
and manual compaction: 8/9 passed. Native drift dispatched one synthetic HTTP
request, a product guard defect. Returning the denied Proxy from an async
handler triggered Promise assimilation's `then` lookup inside the SDK catch;
the SDK retained the original payload. Permit only that inert probe and reject
payload reads outside the catch. Fresh combined gate: 37/37 passed, including
zero HTTP on foreign identity and zero aborts of the foreign session.

Further discriminating private-reference/actual-tool cases: 41/41 passed.
Missing or old private references now deny without abort/cancel authority over
the current input. A synchronous canDispatch view checks the captured native
signal/reference/identity after async helpers and on actual payload use. The
actual-gate wrapper challenge changes native identity after checkpoint resolves;
fresh combined gate 42/42 passed with zero HTTP/foreign abort. This challenge
is additive proof, not a recorded red run. Fresh pending-before-real-Agent/auth,
once-only actual-tool release and actual-manual-compaction release cases follow.

Installed primary-source provenance (all three packages 0.73.0, local Node
SHA256 over the named installed source, not an upstream pin):

| Package/file | SHA256 |
| --- | --- |
| pi-coding-agent/dist/core/sdk.js | effac468f4e9d56e777a0f114e7f6a736b3d7bc53636e2e17183615fbe9d8fec |
| pi-coding-agent/dist/core/agent-session.js | 84687393bb0db810b93b6e632815ae5e54e1e0ebc17690ec1c4419791c73619f |
| pi-coding-agent/dist/core/extensions/runner.js | dab1eadccdd73b6bb50bbd22b464461c65eca77f368d2b44e5e9af4cbcc18d4d |
| pi-agent-core/dist/agent.js | 8dde21e527322191eeb64e6c12b624afdae4dc44abf092b5399c3d86acd7407b |
| pi-agent-core/dist/agent-loop.js | ef6844bc7ef047a6f58495b753cdcd445df59da573a2717de0b85469d5e097f0 |
| pi-ai/dist/providers/openai-completions.js | 2e72980aa74e53a61534a71a4461ffa013d71b67fbfbfc25e4e0d2683d64498e |

Actual HTTP fixtures prove only this installed primary adapter and inert
responses. SDK auth/model registry uses memory/fake credentials. Input binding
uses a test-only unchanged-text digest captured on admission and bound to the
actual signal at context after user append. Manual compaction explicitly captures
its outer reference before the public SDK call. Neither is production generic
template/command/recovery/follow-up correlation. Guards are registered last in
the fixture's sole extension; later handlers can override payloads. No full
native approval journey or universal provider cancellation claim. AgentSession
retry tests explicitly set nested `retry.provider.maxRetries: 0`; internal
primary-client retries bypass onPayload and remain an activation requirement.
Likewise any ownership change after payload serialization across further SDK
header/routing/transport awaits needs private lease/cancellation proof, not
another stale cache. ADR 008 records these exact boundaries.

Full original requirement audit at this cut: durable journal/exact ownership,
parent current epochs/private receipt/nonce/durable consumption and tested
actual-Agent boundaries are source-bound local prerequisites. Executor main/
observer and shipped Pi extension remain unwired; ADR 007 hold-only behavior
remains. General native-operation binding, extension follow-ups/recovery/commands,
overlapping pre-start input, automatic compaction, SDK internal transport retries,
all asynchronous effects, close/restart wired lifecycle, broader host parity and
complete authorized native P0/P1 acceptance remain open. No goal completion,
live canary, workflow call, resolver/approval, real inference, installed-runtime
change, existing-session signal, deployment or push is authorized/claimed.

Fresh final focused pre-review gate: 45/45 passed. Isolated staged snapshot
`b8532a835c503a826cc813405dead457dc7bc09e`, export
`/tmp/statewright-agent-boundary.slcSkH`: Node integration 281/281 with no
skips/cancellations; Pi 120 passed/1 pre-existing opt-in live-canary skip;
native-session gate 2/2. Generated Claude managed-client parity and both Pi
MJS syntax checks returned exit 0. These gates are superseded by the review
repair; final source must receive fresh gates.

Clean-context read-only Astra/high reviewer
`/root/pi_actual_agent_boundary_review` found R1 (high): checkpoint touched
native identity/lazy signal before checking its captured private reference.
One synthetic in-memory challenge admitted epochs 1 and 2, then passed epoch
1's reference with a foreign native context. Result false and no foreign abort,
but current epoch 2 became held and parent cancellations changed from [1] to
[1,2]. The old callback acquired cancellation authority from the current cache,
contradicting the declared cutline. No other finding in the bounded six-path
review; the reviewer did not repeat broad gates or edit any file.

R1 repair attempt 1: test admitted/private-reference ownership before any
context getter and return false without cancellation for unbound callbacks.
Correctly bound native drift still enters fail-closed cancellation. Regression
combines old/missing reference with foreign identity, throwing identity and
throwing lazy signal; all assert zero context reads, zero replacement aborts,
active epoch 2 and no replacement cancellation. Preserve the failed challenge
and superseded gate above. Fresh focused validation and bounded independent
recheck required; no expansion into broad implementation/discovery.

R1 independent recheck: closed on staged snapshot
`65f1117e6d15006e63249c2669d39b763fd428ac`. Repeating the original synthetic
challenge leaves epoch 2 active: result false, held false, cancellations remain
[1], aborts remain 1. One read-only tool call; no edits or broad gate rerun.
Correctly bound native failures still cancel. Root's focused gate 47/47 passed.

Final isolated source gate, same snapshot exported to
`/tmp/statewright-agent-final.6rjS1a`: approval/Codex/ownership/observer/remote/
private bridge/generated/native Node integration 281/281, zero failures,
skips or cancellations (4.58s). Pi 122 passed/1 pre-existing opt-in live-canary
skip (6.09s); native session 2/2 (1.17s). Generated Claude managed-client parity
and both Pi MJS syntax checks exit 0. Subsequent changes only extend this
receipt. The source cut is six paths; every initially unrelated dirty artifact
remains outside it. No Rust/full-workspace/type-check/live-native or production
gate is claimed. The two Node native tests also occur in the integration suite;
do not add these gate counts as unique tests.

Commands from the final staged export (npm commands in plugins/pi):

```sh
node --test plugins/executor/tests/{human-approval,approval-journal,codex-approval-gate,runtime-approval-service,codex-native-approval-proxy,codex-app-server-transport,managed-ownership-races,executor-approval-mirror,executor-observer,executor-contract,remote-client,host-adapters,executor-session-ownership,adapter-bridge,executor-request-controller,executor-request-bridge}.test.mjs plugins/pi/tests/session-owner.test.mjs plugins/claude-code/tests/managed-client-bundle.test.mjs
npm test -- --reporter=dot
npm run test:native
node plugins/claude-code/scripts/sync-managed-client.mjs --check
node --check plugins/pi/src/request-gate.mjs
node --check plugins/pi/src/request-hooks.mjs
```

Applied manual agentic-engineering controls influenced this inactive cutline,
ADR, exact source exports, retained failed evidence, scoped Git boundary,
protected final gates and clean-context adversarial review. Observed review:
one Astra/high decision pass, one R1 repair, one focused independent recheck;
no implementation delegation or workflow. No finding exceeded the two-repair
limit. The normal provisional tool envelope expanded for real SDK red evidence
and the required review repair; discovery stopped and only focused repair,
fresh source gates and recording followed. Tool/token/time accounting remains
manual/observed-only, not cumulative controller/quota enforcement. Next slice
must budget general operation correlation as a separate prerequisite rather
than broaden this passed provider fixture with unsafe production cache wiring.

Exact next original input: implement a private immutable native-operation
binder that survives template expansion and overlapping pre-start awaits,
distinguishes explicit input from inherited extension/recovery follow-ups and
never transfers old queued work into a newer epoch. Add actual automatic-
compaction and internal HTTP-retry/transport cancellation challenges. Then
wire parent controller into `plugins/executor/statewright-exec.mjs` (currently
launch-hold/owned Pi SIGTERM, bridge lacks requestController), observer/deferred
journal clear, exact native readiness and parent close/cancel; wire guarded
effects into shipped `plugins/pi/src/index.ts` after exclusive final hook
registration. Its corrective/timeout/retry/embedded-tool paths currently use
current caches and uncorrelated sendUserMessage, so no activation yet. Audit
every async declared effect and inference handoff against the captured private
reference, test restart/new-input/parent-child ownership, then separately prove
authorized complete native P0/P1 and advertised host parity. This safe local
progress is not the full requirement audit's success condition. Original goal
remains active, not complete or blocked; Auldwyrm/installed runtime/live sessions
remain untouched. No workflow query/load/use, actual decision, real inference,
external change, deployment or push occurred.
