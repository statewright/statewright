# P0/P1 approval journal and resume ownership

Date: 2026-09-17. Status: implementation in progress; no release or live approval claim.

## Slice 22 entry: native retry lifetime and completion handoffs

Previous turn PROGRESS: sourcef4ae56e/receipt727d6a8 committed, validation and
independent partial/failed probe limits retained. Current Statewright main
HEAD727d6a8122645417c60093c65fa45f75ce6a9057; index empty, previous owned paths
quiet, seven unrelated tracked changes exact hash unchanged. Auldwyrm HEAD/
tracked diff unchanged. Full006147-172/0121-43/111 native shared milestones/
11649-100 re-read; nine original requirements remain OPEN. No workflow/state/
catalog/usage tool query/load/use; explicit user override remains authoritative.

Primary installed SDK0.73.0 native events synchronously create a retry promise
on agent_end, then queue completion processing. Native retry later mutates
attempt/message/controller fields, emits retry events, sleeps and schedules
continue. Existing inference guards are not proof of completion publication or
idle retry teardown. Actual SDK/real owner/loopback RED: cancel during60ms native
retry sleep leaves old prompt unsettled after300ms; replacement control PASSED
via native input abort. Two-case gate1 failed/1 passed (60 excluded), exit1;
do not invent a replacement defect. Add discriminating pending retry-event/error
persistence case before source acceptance.

Proposed bounded source direction: preserve native retry algorithm, public APIs
only/no private imports/vendor patch/copied retry loop. Capture original private
producer epoch signal at public Agent completion before async native queue;
track retry promise/lifetime with public wait/abort methods, exact private slot
cleanup, epoch cancellation and stale-caller denial. Guard native message_end/
agent_end aggregate awaits before publication/core retry effects, and actual
event type consumption across return microtasks against original epoch cancellation.
Do not adopt latest caller/global retry fields as authority, disable retry, weaken
pending/no-effect assertions, or claim all backend/internal/native effects.

Owned scope: request-operations.mjs, new request-retry.mjs,
actual request-agent-native.spec.ts, request-frontend-native.spec.ts, new ADR011,
this receipt (six paths; frontend fixture added after exact-export timing RED). Root
sole implementer. Source acceptance: actual natural native retry positive/error/
pending/cancel/replacement/stale caller/late event controls; affected Pi suite;
exact staged export Node308 SERIAL/Pi baseline332+existing skip/native2, SOURCE
Claude parity/all changed mjs syntax; mandatory independent clean-context Astra/
high read-only review, scrubbed ephemeral CLI if thread cap remains. Record
failed/unavailable evidence, source-identical fixture reconciliation only, no
full-goal/installed/native GUI/real decision/recovery/host conformance claim.

Retained RED/repair: pending case failed with auto_retry_start1 vs0 (exit1).
Initial event-type consumption getter broke passive lifecycle observers and
early user-message checkpoints interfered with before-provider parking; native
suite61 passed/5 failed/2 unhandled, exit1. Removed that invalid approach, not
diagnostic assertions. Overbroad settings-read denial then blocked synchronous
initial promise preparation (53 passed/13 failed, unhandled rejections, exit1). Private
producer-object completion WeakSet separates that preparation from later queued
retry consumption; subsequent65 passed/1 threshold test timeout, exit1, no
unhandled errors. Threshold fixture awaited a prompt now legitimately held at
assistant completion before it could grant: retain an input promise, prove no
assistant persistence/no compaction/no second HTTP while pending, grant, then
await it and original genuine split-turn compaction/result assertions. This is
a stronger pending assertion, not disabling retries or loosening no-effect proof.
Actual source now guards only assistant-message/agent-end aggregates and the
productive completed-producer retry settings read, no event-type getter. SeeADR011.

Pre-export actual SDK gate:66/66 passed, exit0, including idle cancel/replacement,
pending retry event/error-persistence/grant, stale abortRetry, aggregate-return
microtask cancellation and genuine native exhaustion. Retry algorithm, enabled
setting, maxRetries1 and actual loopback503 remain intact. Threshold compaction
stronger pending fixture retains native split-turn result/three HTTP proof.

First exact export tree7772e356b07972fd20f4d34cefc28eff9991ebad at
/tmp/statewright-owned-retry.4tvADX, all five blob pairs match frozen index;
Node308 SERIAL/native2/SOURCE parity/two changed-mjs syntax exit0. FullPi first
337 passed/1 failed/1 existing skip, exit1: superseded parked slash fixture had
empty consumed IDs. Same source focused1/1 and whole338+existingSkip exit0.
Primary owner.beginRequest publishes epoch before controller.begin awaits
status/journal reconciliation. Fixture f.approve after epoch2 alone could race
that first journal park. Strengthen both old/replacement to await actual durable
request.phase=parked before replacing/granting; no production gate or expected
consume/clear/effect assertion loosened. This justified sixth owned test path.

Mandatory clean-context spawn failed thread cap; scrubbed ephemeral read-only CLI
review requestedAstra/high, effective route unverified. Parent captured actual
thread.started01a0b21e-e7ce-7b43-bfc2-3add823b1b7f (child env same UUID), distinct
from writer01a0b0f5-909c-7b61-b632-3375983b613f; terminal process/final output exit0.
Eight diagnostics, initial inert harness exit13/unsettled top-level await then
corrected actual SDK/real operations/substitute-authority probe exit0. Not real
owner/journal acceptance or independent Vitest. Reviewer cannot verify export tree
without Git metadata; parent five exact blob pairs above provide source provenance.
Review P1: reentrant auto_retry_start cancellation clears promise before controller
creation, leaves attempt1 and next request loses its one retry. SDK actual inert
control during established sleep attempt0/two next streams vs reentrant attempt1/
one next stream. Initial export rejected for this finding, not accepted on greens.
Observed reviewer usage input390142/cache333184/output5720/reasoning1547, not cost/
full-goal quota/effective-route proof. Review/task output targets exceeded; root
cumulative byte/tool accounting incomplete, no hard-envelope compliance claim.

Root actual SDK/real owner/loopback RED both reentrant cancel/replacement failed
attempt1 vs0, exit1 (66 excluded). Repair only owned public retry-start subscriber
delivery: captured original producer/event, defer one microtask until SDK controller
exists, exact original private owned-phase check/drop stale or unsubscribed,
public runner error reporting for observer failures. No copy/disable of algorithm,
new latest-scope grant, or raw private controller mutation. Compatibility timing/
exception policy and pre-wrapper/raw listener limits disclosedADR011. Actual69/69
passed, exit0, including both reentrant controls and observable observer error with
genuine native retry/reset. Freeze repaired source for full gates/fresh4-call review.

Repaired exact export tree621e111b449064aa6beaa3b684ca18d0b6ce804c at
/tmp/statewright-owned-retry-repair.XLC5sl. All six staged/export blob pairs match;
owned unstaged source quiet. FullPi341 passed/one pre-existing live skip (342),
Node308 SERIAL/native2/SOURCE Claude parity/two changed-mjs syntax all exit0.
No install/live inference/workflow use/decision/deployment or fallback was needed.

Fresh independent repair recheck requestedAstra/high through new scrubbed ephemeral
read-only CLI, effective route unverified. Parent captured actual thread.started
01a0b222-d503-7602-b601-04f12e9cd79a, distinct from writer/initial reviewer, terminal
process/final output exit0. Four diagnostics; one combined read command exit1 at
trailing no-match AGENTS search, not a SDK/test failure. Final bounded PASS SOURCE
REVIEW ONLY: no concrete introduced defect in inspected retry-ordering/completion
authority paths. Explicit partial fixture inspection, no test/inert prototype run;
69/69 remains root actual SDK/real owner/loopback evidence. Parent six-blob match
and exact-export341/308/2 gates above reconcile source provenance. Do not turn this
into independent runtime, all-provider/native, security or activation acceptance.
Observed usage input113490/cache96768/output2028/reasoning1066. Review raw output
exceeded20KiB target despite narrower packet; root output/tool accounting remains
incomplete, no hard-cap/cost/quota/effective model proof. Engineering disposition:
accept this bounded six-path experimental source cut, original nine rows OPEN.
Initial P1 reentrancy finding repaired by real SDK RED/GREEN plus fresh clean-context
source review, not erased by initial green gates or substituted-authority PASS.

Both immutable exports retained; no source/ADR/test change after repaired freeze,
only this receipt/full original audit appended. Unrelated Statewright seven-file
binary diff55c81137fb1ab1c4ce10632d5ac5c62c46c050a3a766a38ab8b9b995512f0270 and
Auld HEAD65025b50952e27b38b215b18905ba1c4770fbdb4/diff94f585de57d915f93623de690dca8ebad3ffec018fbdf85e24617da4510547aa
reverified unchanged. All validation/reviewer processes terminal before handoff.

### Slice 22 full original requirement audit and continuation

Authoritative006147-172/0121-43 and Auld11119-62/202-242,11649-100 re-read.
All nine original requirements remain OPEN; no full-goal completion disposition:

1. Immutable tenant/client/session/run/edge/action/artifact/policy/reviewer ticket,
   expiry/revocation: OPEN; no authoritative complete binding proof added.
2. Original private producer/epoch and user replacement improved; complete parent/
   child/thread/branch/restart/cross-host lineage and owning tree gestures: OPEN.
3. Named retry lifetime/assistant-end guards proven; exhaustive SDK/native state/
   pre-wrapper/direct listener/UI/FS/spawn/auth/provider/WS/fixed backend FX: OPEN.
4. Actual authenticated entitled native/website/required-reviewer journeys: OPEN;
   no real decision/resolver/authentication boundary exercised or weakened.
5. Local cancellation/held and durable fixtures partial; lost begin/cold native/
   legacy/crash locks/permanent failed-provider drain/foreign-tuple teardown: OPEN.
6. Synthetic once-only release primitives partial; actual reauthorization/
   entitlement/artifact/policy and exactly-once crash delivery: OPEN.
7. Named assistant/retry event/persistence and stale guards improved; every final
   response/native effect/publication against newer input: OPEN.
8. Decision source/authentication-strength/human provenance: OPEN; routing/API
   keys/owned aliases are not human authority or same-OS malicious-agent isolation.
9. Client-neutral evidence/review/retention, clean standalone install and every
   advertised native host/provider acceptance: OPEN.

012 A/1 user-dirty Rust denial preserved/unvalidated/uncommitted;2 trusted decisions
unproved;C/3 parent/journal/cold fixtures partial;B/4 source experimental, installed/
main activation unproved;D real canaries not run.111 native+website/shared evidence
and116 desktop, native Windows distinct fromWSL, clean release,100 deterministic
iterations/runtime/provider-authenticated acceptance/24h multi-session staging
soak remain OPEN. Historical staging is not current evidence.114 proposed baseline
not certification;115 separate provenance unchanged. Full goal ACTIVE, not blocked.

Next safe manual source frontier: retry lifecycle effects through listeners already
registered before owned installation, raw native completion/state reduction and
foreign-tuple teardown. First inspect real owning factory/mode installation order;
do not claim the public subscription barrier retroactively guards prior listeners.
Build genuine task-owned SDK/owner reentrant/drain RED and reconcile baseline vs
introduced effects; no copied private loop, disable-retry mask, latest-epoch grant,
SDK/vendor mutation or weaker pending assertion. Broader ticket/authority/cold/
native conformance obligations remain controlling. No native SDK init/run, real
sessions, decisions or release/install permission inferred from this source cut.

### Slice 22 committed source and handoff

Local source commitab8aeb92933a7bed3df98337d4bdc8add9512e28 on Statewright main,
parent727d6a8122645417c60093c65fa45f75ce6a9057, exactly six owned paths. Compared
with tested/reviewed tree621e111b449064aa6beaa3b684ca18d0b6ce804c, source/ADR/tests
are identical; only research receipt/full audit appended71 lines. Pre-receipt
postcommit index empty/all six owned paths quiet, seven-user-file hash unchanged.
This final addition records that immutable source commit, not a new algorithm
or validation result. Both reviewers and all gate processes terminal; root elapsed
about24min, two source exports/two clean-context requestedAstra/high CLI turns,
bounded budgets/output targets observed-only with overruns/incomplete accounting
retained above. No push/install/activation/deploy/workflow/live decision occurred.
Rollback only scoped six-path experimental changes; preserve owner journals,
native files, user dirt and unrelated changes. Next frontier/full audit above
remain controlling: full goal ACTIVE and all original requirements in scope.

Observed-only manual envelope root85 normal/120 contraction tools,30min warning/
45min contraction,24KiB task-output target excluding mandatory skill reads,
final third reserved for validation/review/repair/handoff. No hard provider/quota/
controller probe (workflow use forbidden); inherited root route, one normal/two
worst Astra/high review turns justified by ownership/no-inference boundary;
initial8 diagnostics/8min/2 focused, repair recheck4/5min/2, max2 repairs/finding,
2 source exports plus regression-justified third. Stop optional breadth at
threshold; do not erase prior Slice20/21 usage/rework. Reuse existing manual
control profile, no production/compliance baseline. No real resolver/decision/
approval/inference/live sessions/signals/install/deploy/push. Temporary SDK/SSE/
synthetic owner/journal fixtures only. Full goal active, safe source work remains.

## Slice 21 entry: immutable SDK summary handoff (continues uncommitted Slice20)

Previous turn classified PROGRESS: authoritative P1 handoff finding plus actual
SDK RED changed the next action; no unfinished handle restarted. Recheck confirms
Statewright main HEADbd00adf, eight root-owned staged Slice20 paths and seven
unrelated user tracked changes unchanged; Auldwyrm HEAD65025b5/diff unchanged.
Full006 nine-row/012 numbered1-4/slicesA-D/111/116 requirements re-read, not
redefined around this slice. No workflow/state/tool/catalog/usage query/load/use;
explicit user override remains authoritative over skill activation doctrine.

Microtask handoff regression revalidated unchanged source:1 failed/55 excluded,
HTTP2 rather than1, exit1. Root repair attempt1 for this NEW handoff finding:
freeze actual SDK-retained branch array before hooks; expose deep detached plain
hook preparation (preserves Sets/Maps), not native array/entry records. Diagnose
immediate/awaited mutation of original/project views and reference swaps; late
hook-view mutation is harmless because SDK consumption uses distinct frozen
array. Do NOT deep-freeze unrelated SessionManager records or patch installed
SDK. Actual SDK test now challenges BOTH hook-view and raw retained array at
the microtask window, asserts exact input separation/frozen retained array,
normal empty-tree continuation/zero summary HTTP and unfrozen native entry.
Add actual supported TREE custom summary/cancel, default instruction/replace/
label result controls, not just custom compaction. Direct/hidden replacement
and existing defaults/custom/cancel/stale tests stay.

Same eight owned paths. Acceptance: actual Agent60 expected/Pi332+existing skip
only after observed PASS; exact staged export Node308 SERIAL/native2, SOURCE
Claude parity/three mjs syntax/manifest-lock match; independent clean-context
Astra/high read-only finding-only review then coherent local eight-path commit.
No all-provider/retry/drain/recovery/human-authority/host promotion conformance.
No resolver/decision/real inference/live sessions/install/vendorpatch/deploy/push.
Source gate SDK0.73.0 public imports and inert local SDK/SSE/synthetic authority.

Manual observed-only profile: root70 normal/100 contraction tools,20min warning/
30min contraction,24KiB relevant task-output target excluding full mandatory skill
instructions; final third reserved for validation/review/repair/handoff. Stop
optional breadth at threshold, preserve failed/superseded evidence. No controller
probe (forbidden workflow use); requested/effective routing and provider aggregate
quota not enforced/verified. Root route inherited, sole implementer; review route
frontier Astra/high justified by no-inference/private ownership boundary, one
normal/two worst review turns, bounded10 diagnostics/8min/2 focused initial,
finding-only repair recheck4/5min/2, at most2 repairs per new finding. Two exports
plus regression-justified third. Do not erase prior Slice20 usage/rework: previous
turn25m41s,3 exports/3 CLI reviews incl incomplete, output target exceeded; no
cumulative hard-limit or cost compliance claim. Carry all nine OPEN requirement
rows, original Slice20 source receipts below and final requirement audit forward.

### Slice 21 exact-source results and independent evidence reconciliation

Canonical actual SDK Agent60/60 passed. Frozen source tree
22bfec746ea85ba749a4005b7f3fa7916390d6f3, export
/tmp/statewright-owned-summary-immutable.w0KWbS: Node308/308 SERIAL (zero
failures/skips/cancellations); Pi332 passed/1 existing opt-in live-test skip
(8 passed files/1 skipped, Agent60/frontend123); native2/2. SOURCE Claude
managed-client parity, three changed-mjs syntax and peer manifest/root lock
consistency/existing pi-ai0.73.0 entry exit0. No install/dependency resolution
change. No Rust/workspace-wide typecheck/lint/build/GUI/native decision/cold
restart/installed runtime/CI/staging/soak/promotion proof. Installed Claude
runtime drift remains known/unrepaired from Slice20; source parity is distinct.

One fresh collaboration spawn hit lifetime thread capacity; no reviewer identity
reuse. Two independent scrubbed ephemeral read-only CLI reviews, both requested
Astra/high (effective routing unverified), distinct from root runtime verified
01a0b0f5-909c-7b61-b632-3375983b613f. Both process exit0/final outputs captured,
both matched8/8 export blobs. Oracle direct review, no new agents/edits/network
inference/workflow use. Exact source unchanged between reviews; no second export.

First reviewer01a0b203-e7fc-7af2-a701-70e6ae4f9f01:4 diagnostic attempts,2
focused invocations, approximately2m12s. Vitest unavailable: tmpdir sandbox
denial, exit1/zero tests. Inert REAL adapter/PUBLIC native SDK prototype probe
with substituted operations passed5 cases: late detached mutation, late retained
array mutation rejected, current empty navigation, custom summary/label, cancel.
The two late cases asserted native event present, frozen actual retained array,
detached view, scheduled microtask observed, zero raw fallback and native TypeError
when appropriate: these are NOT no-op/current-leaf tests. Probe THEN exited1 on
wrong bare-summary expectation, stock SDK had added its branch preamble. Later
planned cases did not execute. No confirmed product finding, but probe overall
FAIL; do not relabel it pass or infer real ownership-gate acceptance from stubs.

Fresh evidence-only reviewer01a0b206-baf1-7651-a182-a6f7feaf12ad:4 diagnostics,
2 focused invocations, approximately3m32s. First invocation CommonJS resolution
failed before cases because SDK package exports are import-only; no product
change. Final public ESM/native prototype probe executed16:12 passed/4 failed,
6 inert provider calls/20 substituted dispatches/network0, terminal exit1.
Registry cleanup verified baseline9->final9. Passing: custom summary/label,
cancel, default additional/replacement instructions with correct stock prefix,
labels without summarization, six immediate/awaited hook value/reference mutation
cases, copied Sets/Maps/entry values and unfrozen native record. Four failures:
default output wrongly expected fromExtension entry field; empty fixture selected
current leaf, SDK returned before hooks, so empty/handoff tests never exercised
adapter. Nested completion0/2 is UNPROVED in THIS run, not a contradiction of
first review's actual executed late cases or root's actual-owner microtask tests.
No confirmed product finding; overall FAIL/incomplete, not a passing full probe.

Authoritative fixture reconciliation: installed branch-summarization.js149/233
defines/applies exact stock preamble; session-manager.js857-870 stores fromHook,
not fromExtension (native local variable name); agent-session.js2149 returns
immediately on target===oldLeaf. Root actual public SDK tree controls assert
fromHook true and labels; real microtask tests deliberately branch to ancestor
THEN select distinct descendant, verify hook/retained inputs and mutation ran.
These discriminating observations classify failures as fixture/unavailability,
not repaired product failures or waiver of a known product defect.

Disposition: microtask P1 fixed WITHIN this experimental boundary by root real
owner tests plus first independent executed late cases; supported overrides/value
separation supported by root controls plus second independent executed cases.
Engineering accepts the COMPOSED, source-identical evidence for scoped local
commit, NOT either overall probe as PASS, NOT production/all-provider acceptance.
Independent reviews both found no confirmed defect; their unavailable/incorrect
fixture paths and substituted-owner limits remain recorded. No third reviewer/
duplicate broad gate/optimistic self-close of an untested handoff. Source finding
repair count1, one source export, two review turns (declared worst path).

Provider counters reported first input137567/cache102400/output3970/reasoning870;
second input135647/cache101376/output5896/reasoning985. These are observed review
facts, not full-goal aggregate quota or price conversion. Review source output
targets exceeded (33391 and42684 bytes vs20KiB target); root output/call accounting
incomplete, task-output target exceeded, no hard-budget/compliance claim. Prior
Slice20 usage/rework retained, not erased. Final recording is RESEARCH RECEIPT-
ONLY delta from tested/reviewed source. Source/ADR/tests/manifest unchanged.

### Slice 21 full original completion audit: all nine requirements remain OPEN

Re-read authoritative006147-172,0121-43,11119-62/202-242,11649-100. Evidence
above proves the named SDK summary handoffs, not full original completion:

1. Immutable tenant/client/session/run/edge/action/artifact/policy/reviewer/
   expiry/revocation ticket: OPEN; no complete authoritative proof.
2. Private original SDK caller/epoch/UUID captured; complete parent/child/branch/
   restart/replacement/cross-host lineage and owning tree gestures: OPEN.
3. Default summary stream/payload/HTTP/immutable-handoff tests operating locally;
   all settings/UI/registry/FS/spawn/queue/auth/provider FX, fixed Codex retries/
   WS/auth internals and native core retry state/controllers/events: OPEN.
4. Actual authenticated entitled native/website/required-reviewer journey: OPEN;
   no resolver/decision/human authority added or exercised.
5. Synthetic durable pending/cancel/late proofs partial; lost begin/cold native
   restart/legacy/crash-lock/permanent SDK failure/in-flight drain: OPEN.
6. Nonce/tombstone primitives partial; real authorization/entitlement/artifact/
   policy revalidation and exactly-once crash delivery: OPEN.
7. Tested summary final persistence and stale/cancel guards improved; every
   native effect/final response ownership and publication: OPEN.
8. Decision source/authentication-strength provenance: OPEN; routing/API keys/
   discoverable aliases are not a human click or same-OS isolation.
9. Client-neutral reviewer/evidence/retention, clean standalone install and
   every advertised runtime/provider/native acceptance: OPEN.

012 A/1 user-dirty Rust denial unchanged/unvalidated/uncommitted;2 trusted decision
path unproved;C/3 parent/mirror/cold fixtures partial;B/4 inactive experimental
owner adapter, installed/main activation not proved;D authorized gateway/native
decision/restart canaries not run.111 shared native/website/evidence journey and
116 desktop/native Windows vsWSL/clean release/protocol100-iteration per-runtime/
24h multi-session/provider-authenticated promotion remain OPEN. Historical
staging receipts not current evidence. Full goal ACTIVE, not complete/blocked.

Next bounded source frontier: SDK native core retry state and lifetime ownership.
Installed agent-session.js1934-2003 mutates retry attempt/promise, emits retry
events, removes message, assigns shared abort controller, awaits sleep, then
clears shared fields/schedules continue. Existing inference-continue guards do
not prove all those effects/replacement/cancellation/drain races. Build actual
SDK/native input RED around retry sleep/new input and old controller/finally
cleanup before accepting a source fix; no disable-retry mask, copied algorithm,
latest-scope adoption or weaker pending assertion. Broader authority/recovery/
host obligations above remain controlling. Rollback: scoped local revert of
eight-path additive experimental source, preserve journals/native records.
No push/install/activation/deploy/live native session/workflow use occurred.

### Slice 21 committed source and handoff

Implementation commit f4ae56eff941ff3e533d1be9d81260e42d084239 on Statewright
main, parent bd00adf6d743003ebb341e2ca017bfd919c7d93c, eight owned paths.
Post-commit tested-tree22bfec.. -> implementation commit diff is ONLY this
research receipt; source/ADR/tests/manifest/lock unchanged from exact gates and
independent reviews. Index empty, eight owned paths unstaged quiet, diff check0.
Seven unrelated tracked Statewright changes remain exactly SHA256
55c81137fb1ab1c4ce10632d5ac5c62c46c050a3a766a38ab8b9b995512f0270;
Auldwyrm HEAD65025b50952e27b38b215b18905ba1c4770fbdb4/unchanged tracked diff
SHA25694f585de57d915f93623de690dca8ebad3ffec018fbdf85e24617da4510547aa.
User untracked012/013/014/canary artifacts preserved. All gate/review processes
terminal; no inherited writer identity or live reviewer handle retained.
Commit-identity recording is a separate RESEARCH-ONLY follow-up; no new product
source or validation claim. Source baseline for next retry-ownership slice is
f4ae56e; all nine original requirements above remain OPEN. No activation/push/
deployment/full-goal completion. Observed entry wall approximately14min before
final recording, under20min warning; tool accounting incomplete/no cap guarantee.

## Slice 20 entry: owned default compaction and branch summary inference

Basebd00adf; previous turn progress committed and exact-source verified. Continue
full006/012/111/116 contract manually, no Statewright query/load/use/workflow.
Preserve seven user tracked/untracked changes and Auldwyrm. Root sole implementer;
mandatory independent clean-context Astra/high read-only final review, isolated
scrubbed ephemeral CLI fallback if collaboration thread capacity unavailable.

SDK0.73.0 manual/automatic compaction and branch summary directly call public
compact/generateBranchSummary -> completeSimple, bypassing ordinary Agent payload
hook. Existing before-compaction admission does not lease later provider awaits
or final publication; branch summary lacks a native guard. Bind public runner.emit
aggregate result boundary on the owned session, preserve explicit cancel/custom
results, and supply default summaries using the SAME public SDK algorithms with
an ephemeral PRIVATE API alias. Alias delegates captured original public provider;
no builtin/global registration overwrite, private SDK import, installed patch or
session.model API rewrite. Require exact SDK version/shape and original private
call at alias invocation; fresh checkpoint before stream, after payload callback
await and before final native publication. Combined SDK/epoch signal, stale result
denial and exact alias unregister; disable uncheckpointed client-side retries
where public provider option supports it. Native fromExtension records adapter-
supplied SDK default summaries explicitly; no claim they came from stock path.

Owned scope: new request-compaction.mjs, operations install, request-hooks tree
guard, actual SDK Agent/native tests, paired public pi-ai peer manifest/lock
metadata if required, new ADR010 and this receipt. Red first: pending after payload
await and HTTP completion, replacement/cancellation/late callbacks, automatic
compaction, branch summary, current failure and positive SDK defaults/custom
overrides. Public provider onPayload contract backed by installed builtin sources;
not all transports/retry internals, headed recovery, every effect, policy/artifact/
reviewer/authorization/native restart or cross-host acceptance proved collectively.
No real authority/resolver/decision/inference, live sessions/signals, installs,
vendor patches, deploy/push. Inert task-owned SDK/loopback fixtures only.

Exact staged export gates: Node SERIAL308 baseline, Pi309+existing live skip,
native2, Claude generated parity and changed-mjs syntax. Root observed-only
100 normal/135 contraction tool calls,30min warning/45min contraction,16KiB output
target, final-third reserve. Stop optional breadth at warning/reserve; no catalog/
controller usage probe, invented workflow identity, hard provider/aggregate quota
or price conversion. Reviewer10 diagnostics/12min/2 focused invocations; fresh
finding-only recheck4/5min/2, max2 repairs/finding and2 exports plus a regression-
justified third. Existing manual source/evidence/Git control profile only, no new
production/compliance baseline. Coherent scoped commit/revert preserves journals/
native owner records. Full requirement audit before any completion disposition;
safe implementation remains, so goal active, not complete or blocked.

### Slice 20 retained red/repair evidence

Initial4-case gate4/4 failed; two cases were fixture-invalid (unadmitted slash
command cannot bind original reference), with one5s test and two10s cleanup hook
timeouts. Retain this failure, not proof of those paths. Fixture now captures
automatic/tree callbacks inside actual before_agent_start after native admission,
preserves default captured history and releases task-owned provider waits BEFORE
SDK drain on red. Corrected unchanged-source gate4/4 failed on missing onPark:
manual/automatic payload await, post-HTTP compaction and branch payload wait all
escaped fresh authority. All jobs terminal; no preserved/live session access.

First implementation six-case gate2 passed/4 failed: snapshot lost native Set
fileOps, causing fileOps.edited not iterable. Preserve actual Sets/Maps, no relaxed
algorithm/persistence assertions;6/6 passed including old manual controls. Full
Agent48-case gate46 passed/2 failed +one unhandled rejection: natural auto split
starts two summaries, second rejected when sibling parks; combined branch test
invented second approval incompatible with single-ticket fixture. Repair distinct
causes: serialize original alias siblings, keep exact SDK-derived summary count;
separate registry/post-HTTP race fixtures, attach rejection observation promptly.
Agent49/49 passed. New native event-kind mutation test1/1 RED: compaction resolved
from raw SDK fallback instead of rejecting. Snapshot kind/signal/preparation and
reject changed envelope; no fallback. Add completed-callback denial even SAME
original private request via lease expiry. Pre-freeze Pi323 passed/1 existing live
skip, including51 Agent and123 frontend tests; this is not exact export proof.
Model/preparation/provider context/payload snapshots prevent post-wait retargeting;
custom compaction/cancel and genuine500 error/no extra OpenAI retry controls stay.
ADR010 records public algorithms, temporary alias/global registry boundaries,
fromExtension provenance, native branch guards and known retry/internal gaps.

### Slice 20 independent finding and bounded repair

Initial exact tree c0e32d0f1d3ef9b3372a39068e9ebe5ea626b9a8 at
/tmp/statewright-owned-summary.qVuPVW passed Node308/308 SERIAL, Pi323 passed/1
existing live skip (Agent51/frontend123), native2/2, Claude parity/three changed
mjs syntax/peer-root-lock consistency exit0. Independent collaboration spawn
hit thread capacity; no identity reuse. Scrubbed read-only ephemeral CLI fallback
requested Astra/high, effective model unverified; distinct thread
01a0b1f4-902e-7d93-996e-e4b4abe8c91e, process exit0 and final output captured.
Reviewer used10 diagnostic attempts (one read-only sandbox-refused heredoc), two
inert focused probes, approximately4m15s; no edits/network inference/new agents.
All eight export files matched frozen blobs. P1: hook changes initially empty
branch entries array; adapter returns no summary from empty snapshot, SDK later
uses live nonempty array and dispatches raw provider while pending/auth awaits.
Both source-only probes reproduced one pending provider invocation/no payload
guard/zero writes, including actual request operations plus SDK navigateTree.
Native append guard worked, not sufficient to close escaped inference dispatch.

Root actual SDK/loopback regressions2/2 RED (51 excluded), exit1: mutated empty
preparation resolved via raw summary instead of rejection; caller options changed
summarize false->true while hook awaited caused HTTP count2 rather than1. Second
is a distinct adjacent fallback cause, not reviewer-reported direct evidence.
Repair attempt1 each: fail closed on preparation changes after aggregate hooks
AND after all owned dispatch waits; snapshot public navigateTree options before
first await under its original private caller and fresh checkpoint. No latest
adoption/unbound tree gesture activation. Supported result overrides preserved;
raw preparation mutation intentionally rejected, disclosed ADR010 compatibility
restriction. Initial green tree superseded. Fresh focused/export/review gates
required; failed outcomes retained, no weaker summary/no-inference assertions.

### Slice 20 repaired exact-source gates

Root actual SDK Agent53/53 passed (new regressions2, total Slice20new16). Second
frozen tree ae8a22a18ca025dc174e292cee2734ce4e0122ae at
/tmp/statewright-owned-summary-repaired.sNVjZg passed Node308/308 SERIAL (zero
failures/skips/cancellations), Pi325 passed/1 existing opt-in live-test skip
(8 passed files/1 skipped, Agent53/frontend123), native2/2. Claude generated
managed-client source parity, three changed-mjs syntax and peer-manifest/root-lock
consistency (existing pi-ai0.73.0 lock entry) exit0. Canonical staged diff check0;
all eight export blobs compared equal to exact tree; staged tree unchanged.

Retain two root parity command errors: guessed scripts/sync-runtime.mjs does not
exist (exit1); corrected sync-runtime --check unexpectedly includes installed
Claude runtimes and reported pre-existing stale hook/supervisor/model-ladder/
remote-client/windows-command files (exit1). No sync/install/overwrite performed.
Required SOURCE parity uses plugins/claude-code/scripts/sync-managed-client.mjs
--check, passed exit0; installed runtime parity remains unproved/known stale, not
waived by source success. No Rust/workspace-wide typecheck/lint/build, headed/live
native approval, cold restart, installed launcher, CI/staging/soak/promotion proof.
Seven unrelated Statewright tracked changes retain SHA256
55c81137fb1ab1c4ce10632d5ac5c62c46c050a3a766a38ab8b9b995512f0270;
Auldwyrm HEAD65025b5 and tracked diff SHA256
94f585de57d915f93623de690dca8ebad3ffec018fbdf85e24617da4510547aa unchanged.
Temporary exports are exact validation fixtures; durable proof is local source/
scoped Git milestone and this receipt. Fresh independent finding-only review
required before local commit; broader original goal remains active.

### Slice 20 retained-reference regression and final repair

First fresh repair CLI thread01a0b1fb-1f37-7fa3-b308-84609b4dd40d distinct from
root; process exit0/final captured. Four diagnostic commands, zero focused,
statuses0/1/0/1. No finding in inspected source, but explicitly INCOMPLETE:
SDK package path guessed incorrectly, sandbox refused heredoc, output truncated,
frozen-blob comparison not reached. Requested Astra/high unverified. Do not count
this as independent repair acceptance; label supplied by reviewer is not its
runtime identity (parent captured actual thread.started UUID above).

Root retained-reference challenge: hook mutates original entries, then swaps
visible preparation OR just entries property to a clean equal-valued copy.
Against first repair, focused3-case gate1 passed/2 failed (52 excluded), exit1;
both replacements still resolved through raw SDK summary. Values-only comparison
against latest event view was insufficient because SDK retained original array.
Repair attempt2 for original P1: capture native preparation AND branch entries
object identities, reject replacement of either, validate ORIGINAL preparation
values after hooks/owned waits. No latest-view comparison/adoption. Caller-options
repair remains attempt1. Third export explicitly regression-justified; second
green source superseded. Fresh exact gates and independent source-bound review
required. All failures retained; original full contract remains OPEN.

### Slice 20 latest review: OPEN immutable-handoff finding, no commit

Third frozen tree2f4aee6344c69919cc81bc89033b725d43079537 at
/tmp/statewright-owned-summary-final.90objb passed Node308/308 SERIAL (zero
failure/skip/cancel), Pi327 passed/1 existing live skip (Agent55/frontend123),
native2/2, Claude SOURCE managed-client parity, three mjs syntax and peer/root
lock consistency exit0. Root matched all eight exported blobs, owned unstaged
quiet, exact staged tree unchanged before review. These GREEN gates do NOT close
the subsequent adversarial finding or validate the latest staged RED regression.

Independent scrubbed ephemeral/read-only CLI, requested Astra/high (effective
selection unverified), runtime thread captured by parent
01a0b1fd-9498-7630-95be-01d836f868d1, distinct from root
01a0b0f5-909c-7b61-b632-3375983b613f. Process exit0/final output captured.
Oracle direct review:4 diagnostic attempts, terminal statuses0/1/0/0, one focused
invocation/ten inert cases, approximately2m03s; wrong root lockfile path failed
once then correct plugin lock verified. All eight frozen blobs matched. Six hook/
dispatch direct/hidden replacement cases rejected; microtask handoff depth1
returned undefined with retained array populated/raw fallback condition true.
P1 at request-compaction.mjs final unchanged() -> async resolution -> SDK source
agent-session.js2210. Dispatch queues a microtask which queues mutation: validation
runs BEFORE mutation but SDK resumes AFTER. Source-only inert probe used real
adapter with dispatch substitute; native fallback inferred from inspected actual
SDK, not independently executed with operations/provider. Counts/limits honest;
no broader goal acceptance. Reviewer lacked runtime ID visibility; parent
thread.started above is authoritative, not invented reviewer label.

Root actual SDK/REAL request operations regression schedules the same nested
microtask after the real dispatch completes (spy preserves checkpoint/effect),
with genuine original native entries. One focused test FAILED (55 excluded),
exit1: HTTP count2 rather than1; native navigation resolved via raw fallback.
This proves the handoff cause at the real SDK boundary, not just synthetic emit.
Attempting immutable-array mutation may be denied; fixture observes that denial
without unrelated unhandled microtask errors. No network model inference, real
authority or preserved sessions: task-owned loopback SSE/synthetic journal only.

NO COMMIT: HEAD remains bd00adf6d743003ebb341e2ca017bfd919c7d93c. Eight owned
paths pending/staged, root-owned continuation; implementation source remains third
reviewed tree, with latest RED test/ADR OPEN finding/receipt added. Original P1
two comparisons/identity repair attempts and three source exports consumed this
declared slice envelope; stop additional breadth/export churn, leave explicit
failed handoff for the NEXT bounded manual source slice, not self-accept. New
microtask finding repair not attempted yet. No required objective dropped.

Exact next safe source work: make the ACTUAL SDK-retained branch array immutable
BEFORE exposing hooks, not merely another comparison/snapshot/proxy of latest
event view. Avoid freezing unrelated SessionManager records or patching vendor;
preserve empty/current/default/custom/cancel semantics and original private caller.
Keep this actual handoff RED and direct/hidden replacement tests; expect Agent56/
Pi328+existing skip only after real passing evidence, then fresh exact export
Node308/native2/source parity and independent finding-only review before coherent
eight-path commit. Native core retry ownership follows, plus full006/012/111/116
audit below. Full goal ACTIVE, not complete or blocked; safe source work remains.

Observed-only usage envelope, no hard provider/controller/aggregate quota; root
call/output accounting incomplete,16KiB output target exceeded by diagnostics.
Do not assert budget compliance. Initial failed/incomplete reviews retained, no
model-price conversion, no workflow probe/load/use, no live resolver/decision/
approval/inference/install/deploy/push. Preservation hashes below rechecked at
handoff; no product changes outside eight owned paths, Auldwyrm untouched.

### Slice 20 full original requirement audit, not completion

Re-read current006 nine-row/012 numbered1-4 and slicesA-D, Auldwyrm111 native/
shared reviewer/evidence contract and116 cross-host promotion. Historical staging
receipts not current verification. All original requirements stay in scope:

1. Immutable ticket/artifact/policy/reviewer/expiry/revocation: OPEN.
2. Private original epoch/UUID/native summary/tree calls gain capture; complete
   parent/branch/replacement/cross-host lineage and owning tree gestures: OPEN.
3. SDK default compaction/branch summary stream/payload/HTTP-completion handoffs
   now reconcile fresh; natural split auto positive/stale/cancel cases tested.
   LATEST microtask retained-array -> raw fallback handoff finding remains OPEN;
   this experimental slice is NOT independently accepted or committed.
   Other raw settings/UI/registry/FS/spawn/queue/auth/provider FX, backend WS/retry
   internals (including fixed Codex response retries), core automatic retry shared
   state/controllers/events and all declared effect coverage: OPEN.
4. Entitled authenticated native+website reviewer/required-reviewer journeys:
   OPEN. No resolver/decision/human input authority introduced.
5. Observed pending cancellation retains journal and rejects late callback;
   lost begin reply/full cold native restart/legacy/crash-lock/permanent SDK
   teardown/in-flight drain recovery: OPEN.
6. Private nonce/tombstone primitives partial; real policy/artifact/authz/
   entitlement revalidation and exactly-once crash delivery: OPEN.
7. Protected summary final persistence/branch handoffs and captured callbacks
   reject old/held work; every native effect/final publication: OPEN.
8. Routing/API credentials/discoverable aliases are not human-auth strength or
   same-OS isolation. Full decision provenance: OPEN.
9. Neutral reviewer/evidence/retention, clean standalone install and advertised
   runtime/provider acceptance: OPEN; no collective conformance claim.

012 A/1 user-dirty Rust pending deny unvalidated/uncommitted;2 actual trusted
decision route untested;C/3 parent/mirror/cold fixtures partial not production
restart;B/4 experimental owning adapter improved, main activation not done;
D gateway/native decision/restart canaries not authorized/run.111 native+website/
reviewer/evidence journeys unproved;116 clean release/desktop/native Windows vs
WSL/protocol races100 per supported runtime/24h multi-session soak/provider-
authenticated promotion unproved. Full goal active, not complete or blocked;
safe remaining source implementation exists and no requirement removed by green.

## Slice 19 entry: settings and scoped-model configuration input

Basef1b2c75; last turn verified progress. Manual/no Statewright query/load/use
overrides skill activation/probing. Full006/012/111/116 objective stays active.
Root implements only; mandatory clean-context Astra/high read-only review.
Preserve user seven tracked/untracked changes and Auldwyrm unchanged.

SDK0.73.0 SettingsList changes currentValue before invoking callbacks; scoped
model input changes enabledIds/isDirty/refresh before its unawaited async onChange.
Guarding callbacks alone cannot prove truthful feedback or pending-no-write.
Extend ADR009's version-bound private INSTANCE adapter, not private imports or
vendor patches: capture /settings and /scoped-models before display/registry
waits; checkpoint original native input before settings/submenu/scoped writes;
retain original token through async completion, serialize per-selector changes,
track native callback promises, restore staged local UI while awaited work runs,
and publish local confirmation only after success. Delayed captured callbacks
must not become new input. Escape dismissal remains immediate/exact original;
submenu back is bounded UI resource cleanup, not effect approval.

Owned paths: request-interactive.mjs, new request-configuration-selector.mjs,
actual SDK frontend tests, optional narrow
operations adjustment only if regression requires it, ADR009 and this receipt.
First add red tests. Prove generic settings and submenu mutation, scoped toggle/
save, delayed registry/current-failure/UI truth, replacement/new-input/dismissal
and old callback denial, with genuine current positive controls. Scoped selector
class is not SDK-public-exported; bind only trusted actual mode-created object's
VERSION0.73.0 private fields/constructor identity shape, never private import.
Raw project settings/registry/UI/global-theme APIs, remaining effects/internal
transport/retry/compaction/recovery, headed/native cold acceptance and production
activation remain open. No full UI/provider/isolation/conformance claim.

Exact staged export gates: Node SERIAL308 baseline, Pi296+one existing opt-in
live skip, native2, Claude generated parity and changed-mjs syntax. Independent
review10 diagnostics/12min/2 focused checks; fresh finding-only recheck4/5min/
2 checks; max2 distinct repairs/finding,2 exports plus regression-justified third.
Observed-only root envelope100 normal/135 contraction calls,30min warning/45min
contraction,16KiB output target, final-third review/validation/repair reserve.
Stop optional breadth at warning/reserve; no controller/provider hard-budget,
catalog/telemetry probe, invented workflow identity or price/quota conversion.
Existing manual source/evidence/Git control profile only; no new production or
compliance baseline. No actual authority/decision/inference, preserved sessions/
signals, install/deploy/push. Inert task-owned SDK/HTTP only. Scoped local commit/
coherent revert preserve journals/native records; full goal not complete/blocked.

### Slice 19 retained red/repair evidence

Unchanged-source actual-SDK seven-case gate7/7 failed: native settings/scoped
submit displayed/cleared before admission, settings changed before park, thinking
callback lacked ownership, scoped UI changed before async completion, old persist
wrote after new input, and current failure left false local success. First repair
6 passed/1 failed (repeated after cleanup refinement): headless global TUI manager
lacked the SDK app.models.save binding. Fixture now constructs the public native
manager with TUI defaults and SDK0.73.0 ctrl+s app binding; preserve all persistence
assertions. Nine-case gate9/9 passed, including ordinary submenu back and scoped
Escape during registry wait. Add post-backend queued-render failure control;
commit local value before publication so a renderer error cannot falsify an
already applied mutation. Frontend120/120 passed before the next refinement.

Two NEW root tests both failed: authority can become pending during registry
lookup without a new input epoch; scoped write and selector display lacked a
fresh checkpoint. Repair1 each: private original-reference scope.effect after
literal-ID immutable model lookup, before synchronous native setScopedModels;
defer native selector factories until the helper returns, then private checkpoint
before construction/display (SDK ignores showSelector return). No latest-request
adoption, policy fallback or private module import. Focused12/12 now pass,
110 unselected; changed3 mjs syntax, Claude generated parity and diff check0.
These pre-freeze diagnostics are not the exact-source integration receipt.

### Slice 19 full original requirement audit, not completion

Re-read current006 nine-row contract,012 numbered1-4/slicesA-D and Auldwyrm111/
116 native/reviewer/evidence and cross-host requirements. Historical live receipts
are not current verification. Requirement dispositions remain:

1. Immutable ticket/artifact/policy/reviewer/expiry/revocation: OPEN.
2. Local private UUID/epoch/UI tokens gain native configuration capture; full
   branch/replacement/cross-host lineage: OPEN.
3. Settings/submenu/scoped native inputs now checkpoint before guarded writes,
   including authority becoming pending during registry awaits. Raw project
   settings/registry/UI/global theme, other FS/spawn/queue/branch/provider FX and
   internal inference/retry/compaction/summary boundaries: OPEN, not all FX proved.
4. Authenticated entitled native+website reviewer controls/required-reviewer
   journeys: OPEN. No resolver, decision or human authority added.
5. Exact native dismissal/stale callback tests retain journal and deny late
   work; lost begin replies, full native cold restart, legacy/crash-lock recovery,
   permanent SDK teardown and in-flight drains: OPEN.
6. Private consume/tombstone fixtures partial; real authorization/entitlement/
   artifact/policy revalidation and exactly-once crash delivery: OPEN.
7. Staged configuration UI now avoids pending/error false-success and rejects
   obsolete callbacks; every native effect/final publication boundary: OPEN.
8. Private routing is not human-auth-strength or same-OS isolation; complete
   decision provenance: OPEN.
9. Neutral reviewer/evidence/retention, clean standalone packaging and all
   advertised host acceptance: OPEN. No collective conformance claim.

012 A/1 user-dirty Rust deny remains unvalidated/uncommitted;2 real decision
route untested;C/3 parent/mirror/cold fixtures partial, not production recovery;
B/4 this experimental SDK adapter gains bounded configuration ownership, not
main-runtime activation;D gateway/native approval/restart canaries not run under
no-workflow/no-real-decision authority.111 combined native/website/reviewer/
evidence journeys remain separate acceptance.116 clean release, desktop/native
Windows distinct from WSL, real protocol races100 iterations per advertised
runtime,24-hour staging soak and provider-authenticated promotion remain OPEN.
Do not remove a requirement because local tests pass. Full goal stays active;
safe manual implementation remains, so no blocked or complete disposition.

### Slice 19 independent finding and bounded repair

Initial frozen tree `68bdea6106bbc687152f2668b7925e336444cfda`, export
`/tmp/statewright-settings-ownership.k8mOMi`: Node serial308/308 no skip/cancel,
Pi308 passed/1 existing opt-in live skip (122 frontend), native2/2 and fail-fast
Claude generated parity+3 changed-mjs syntax0. Exact6 owned paths; staged diff
check0 and preserved user/Auld hashes unchanged. This source is superseded below.

Independent clean-context Astra/high `/root/pi_configuration_ownership_review`
used8/10 diagnostics,2/2 focused inert actual-SDK invocations, reported under
12-minute envelope; both processes terminal. Existing focused11/11 passed, but
independent native Warning submenu reproduction established ONE P2: snapshot
only restores root items; nested currentValue/state stay changed after synchronous
persistence failure. No established P0/P1 finding WITHIN this bounded cut, not
full objective approval. Root's separate native warning failure/reopen/next-toggle
test1/1 red confirms currentValue false instead of true;122 unselected.

Repair1: snapshot/restore actual nested settings/select list fields, values,
search and warning state. Native currentWarnings closure updates BEFORE failed
callback; opening a new actual WarningSettingsSubmenu must rehydrate state/value
from public current SettingsManager.getWarnings with explicit0.73.0 field/id
checks, not reuse the attempted-value closure. Keep actual component/callbacks.
Root focused13/13 passes,110 unselected, including error visibility, failed-write
truth, back/reopen, next genuine successful persistence and successful reopen.
Required next: second exact-source integration export and fresh finding-only
independent review. Root cannot self-close this finding. No weakened gate/fixture,
fallback or transactional persistence claim. Full original audit remains OPEN.

### Slice 19 final exact-source receipt

Repaired tested tree `0c41adc93fbda68546b1ec044f2d8f301fdb95c1`, export
`/tmp/statewright-settings-ownership-repaired.3PE7z0`: Node SERIAL308/308 zero
failure/skip/cancel; Pi309 passed/1 existing opt-in live skip (123 frontend,
8 files passed/1 skipped); native session2/2; fail-fast Claude generated managed
parity+3 changed-mjs syntax0. Canonical staged diff check0, owned unstaged source
quiet0 and exact write-tree match before this receipt. All root gate processes
terminal. No Rust/typecheck/lint/build, headed TUI, actual decision/inference/
gateway, installed-main acceptance, full native cold restart, hosted protocol
race CI or staging soak proof. Initial export superseded; two source exports.

Fresh collaboration agent spawn hit thread limit, not a product failure or
approval. Use agentic-sdlc's isolated local review fallback: env removes parent
CODEX_SESSION_ID/THREAD_ID and prescribed Statewright ownership/control bindings;
codex exec --ephemeral --ignore-user-config --ignore-rules --sandbox read-only,
gpt-6-astra/high, no child agents, exact export and bounded finding-only packet.
Distinct captured reviewer thread `01a0b1e7-283f-7792-9bd8-fef20c8b4d90` versus
implementer `01a0b0f5-909c-7b61-b632-3375983b613f`; final output captured and
process exit0 before disposition.4/4 diagnostics,0/2 tests, under5min. Runtime
recheck unavailable in read-only sandbox because fixture creates temporary files;
root exact-source runtime gates above are separate, not attributed to reviewer.
All four repair files match frozen blob hashes. Primary installed SDK0.73.0
Warning state/closed currentWarnings/SettingsManager source confirms restoration
and authoritative reopen behavior. Finding CLOSED by independent source review;
no remaining established repair regression WITHIN bounded UI truth, not full
P0/P1 acceptance or atomic persistence. Reviewer archive-local Git probe lacked
.git; canonical tree/blob diagnostics established provenance instead. Root
diagnostic captures included truncated source/log output; terminal gate summaries
and final review output are captured complete, no output-target compliance claim.

Fallback reported usage133857 input tokens including106496 cached,2027 output,
292 reasoning output; observed-only, no aggregate hard enforcement/provider quota
or pricing conversion. Root remains below30-minute warning; optional breadth
stopped for review/repair/validation/handoff reserve. Final source/ADR unchanged
from repaired tested/reviewed tree; this recording is receipt-only delta.
Six owned paths only. Seven user tracked changes retain SHA256
`55c81137fb1ab1c4ce10632d5ac5c62c46c050a3a766a38ab8b9b995512f0270`;
Auldwyrm tracked diff retains
`94f585de57d915f93623de690dca8ebad3ffec018fbdf85e24617da4510547aa`.
Unrelated untracked artifacts untouched. Coherent scoped rollback preserves
journals/native owner records. No Statewright query/load/use/workflow, live
session access, actual approval/resolver/decision, real inference, install/vendor
patch, deploy or push. Native SDK fixtures/inert loopback only.

Next safe manual cut: internal compaction/summary transport and automatic retry
ownership/publication. Primary SDK _runAutoCompaction directly invokes compact
after session_before_compact and bypasses the ordinary provider payload hook;
its later writes and continue timer are separately guarded but not complete
no-inference proof. Automatic retry continuation already reaches guarded Agent
continue, but pre-retry shared state/controller/event races need discriminating
native tests. These are inspection leads, not newly established acceptance or
implemented repairs. Remaining raw project settings/UI/registry/every-effect,
lost-begin/cold recovery and authorized full native/cross-host journeys remain
OPEN under the full nine-row/012/111/116 audit above. Full goal active, not
complete or blocked; safe source implementation remains.

## Slice 18 entry: capture owning interactive configuration gestures

Base998cad2. Continue the full006/012/spec111/116 objective manually, without
Statewright query/load/use. Preserve the seven user changes and Auldwyrm; root
alone implements, with skill-required independent clean-context read-only review.
SDK0.73.0 has no public interactive gesture hook: its private mode helpers perform
model/name/thinking mutations, and public ModelSelectorComponent.handleSelect
saves the default BEFORE its callback. Callback-only guarding is insufficient.

Bounded cut: separate mode-only interactive admission before selector/registry
waits; immutable original-reference callback scopes, checkpoint before selector
default/native writes, stale result/status/render suppression, exact-selector
cleanup on revocation and cancel retaining journal. Use the public SDK classes
with an explicit version-checked private INSTANCE binding (ADR009), not private
module imports, vendor patching or a claimed public hook. Thinking/model cycle,
/model search and selector, /name are in scope. Settings/scoped-model editing,
other effects/retries/provider internals, headed TUI/cold restart and production
activation remain open; no weakened native/project guards or latest-lease adoption.

Owned paths: Pi operations/frontend/mode, new interactive adapter, actual SDK
frontend tests, ADR009 and this receipt. Add discriminating tests before source;
freeze exact staged export for Node serial308 baseline, Pi279+existing live skip,
native2, Claude generated parity and changed-mjs syntax, then Astra/high review.
Observed-only envelope:100 normal/135 contraction calls,30-minute warning/
45-minute contraction,16KiB output target, final-third review/validation reserve.
Reviewer10 diagnostics/12minutes/two focused checks; finding-only recheck4/
5minutes/two checks; max2 distinct repairs/finding, two exports plus regression-
justified third. No provider/controller hard enforcement or catalog probe.
No authority decisions/inference, real sessions/signals, install/deploy/push.
Only inert task-owned SDK/HTTP fixtures and scoped local commit; rollback is
coherent scoped revert preserving native/journal records. Full goal stays active.

Retained red/repair evidence: initial unchanged source6/6 selected tests fail
on missing interactive admission/binding. First adapter8-case gate6 failed/
2 passed: original spies were hidden by wrappers and native selector+setModel
each save the default. Preserve original feedback spies; expect both authorized
native saves, not one. Next7 passed/1 failed because SDK construction already
records a model_change; compare exact before/after entries, not zero lifetime
entries. These are fixture corrections, not relaxed stale-write acceptance.
Further root pending-selection gate2 passed/1 failed: Escape could not see a
callback parked at checkpoint. Keep exact original gesture pending across its
callback, clear only its own pending marker. Focused10/10 then passed.
Actual SDK outer submit gate1 passed/2 failed: /model and /name cleared editor
before admission. Bind the outer callback and reuse its admission in helpers;
13/13 passed. Frontend full106/106 passed before later UI-lease refinement.
Root covers exact selector replacement without a new epoch and delayed/capturable
callback denial; constructor rendering captures the exact selector UI token.
Counterfactual regression removes ONLY the pre-selector callback checkpoint,
retaining native setModel's checkpoint and all test assertions:1/1 fails because
default model is written once while approval is pending. Restore that dispatch
before freeze; this proves a callback-only/native-setter gate is insufficient,
not that the previous HEAD had this newly added gesture capability.

### Slice 18 independent findings and bounded repairs

Initial frozen tree `d1531a6d0bbd9ed83ac514c4436b504860e5da7f`, export
`/tmp/statewright-interactive-gesture.1v6b9U`: Node serial308/308, Pi293 passed/
1 existing opt-in live skip, native2/2, fail-fast Claude parity+4 mjs syntax0.
Independent clean-context Astra/high `/root/pi_interactive_gesture_review`
used8/10 diagnostics and2/2 focused inert actual-SDK checks; own processes
terminal. TWO HIGH findings established, not an approved source disposition:

1. `selected=true` denies SDK selector Escape/Ctrl+C during pending checkpoint;
   even ordinary dismissal requires a checkpoint and can itself park. Root own
   red actual owner/journal test1/1 leaves phase parked/reasonnull, not cancelled.
   Repair1: separate exact-original-current identity from active-effect owns;
   immediate private cancellation while parked, no admission/checkpoint, exact
   signal/token cleanup. Root tests now use actual SDK handleInput Escape and
   Ctrl+C, not only direct frontend.cancelInput. Journal/late grant/readiness
   and fresh ownership assertions remain required.
2. Token checked only before awaited checkpoint: different native selector can
   replace the model selector in the same epoch, then obsolete selection writes
   default. Root own new test1/1 reproduces exactly one forbidden default save.
   Repair1: token recheck immediately inside checkpointed effect before native
   helper; native UI replacement retires/cancels ONLY captured original gesture,
   removing its cleanup listener before showing replacement. Late approval must
   not be consumed/cleared; replaced UI cannot be removed by old completion.

Initial review source is superseded. Fresh finding-only clean-context review and
exact repaired-source integration are required before scoped commit. These are
two distinct repair paths, each first repair; do not claim root self-approval.

### Slice 18 full original requirement audit, not completion

Re-read current006 nine-row contract,012 numbered1-4/slicesA-D, Auldwyrm111
native/shared reviewer/evidence contract and116 cross-host promotion requirements.
Their historical staging receipts are not current live verification. Dispositions:

1. Full immutable ticket/artifact/policy/reviewer/expiry/revocation remains open.
2. Local UUID/epoch/private captures improve interactive gesture ordering; full
   branch/replacement/cross-host lineage remains open.
3. Protected interactive name/thinking/model helper/selector/outer-submit paths
   gain pending-before-effect capture and original callback guards. Settings/
   scoped-model edits, other registry/queue/FS/spawn/branch/provider effects and
   internal inference/retry/compaction/summary paths remain open; not all FX proved.
4. Entitled authenticated native+website reviewer controls/required-reviewer
   journeys remain unproved. No resolver, decision or human authority added.
5. Tested original selector dismissal/pending checkpoint retains observed journal
   and denies late continuation. Lost begin replies, full native cold restart,
   legacy/crash-lock recovery, permanent SDK failure/drains remain open.
6. Existing private consume/tombstone primitives remain partial; real policy/
   entitlement/artifact revalidation and exactly-once crash delivery remain open.
7. Original configuration results/status and exact selector async rendering gain
   guarded stale denial; all native final effects/publication remain unproved.
8. Private routing/capabilities are not human-auth-strength or same-OS isolation.
   Complete decision provenance remains open.
9. Shared neutral reviewer/evidence/retention, clean standalone packaging and all
   advertised host acceptance remain open; no collective conformance claim.

012 A/1 user-dirty Rust pending denial remains unvalidated/uncommitted;2 actual
trusted decision route untested;C/3 experimental parent/mirror/cold fixtures are
partial, not full native recovery;B/4 this experimental SDK mode gains bounded
interactive ownership, not production activation;D gateway/native approval/
restart canaries not run under no-workflow/no-real-decision authority.111 combined
native/website/reviewer/evidence journeys remain separate acceptance;116 clean
release/desktop/native-Windows-vs-WSL/protocol races,100 deterministic iterations
per advertised runtime and24-hour staging soak/promotion remain unproved.
No live requirement removed because local tests pass. Full goal active.

### Slice 18 final exact-source receipt

Repaired tested tree `bf1bbbef875f379cf898f8b70a9153ab7eec2939`, export
`/tmp/statewright-interactive-gesture-repaired.3siS7U`: Node serial308/308,
zero fail/skip/cancel; Pi296 passed/1 existing opt-in live skip (8 files pass/
1 skipped), including110 frontend tests; native session2/2; fail-fast Claude
generated managed parity+4 changed-mjs syntax exit0. Canonical staged diff
check0, source unstaged diff quiet0 and write-tree exact match before receipt.
An extra staged-Git diagnostic mistakenly ran in the source archive (no .git),
exit129; this is a validation-location error, not a product gate result. Rerun
the staged/unstaged/tree checks at canonical Git root, all0/exact bf1bbbe.
No Rust/typecheck/lint/build, headed TUI, real decision/inference/gateway,
installed acceptance, cold restart, hosted protocol CI or staging soak proof.

Fresh independent clean-context Astra/high `/root/pi_interactive_gesture_recheck`
inspected only the frozen repair diff/primary sources:3/4 diagnostic commands,
1/2 focused safe test invocations, under5minutes. Actual-SDK focused8 passed/
102 excluded by filter, exit0; own process terminal/fixture cleanup completed.
No established remaining finding WITHIN the two repaired boundaries; not an
approval of full P0/P1 acceptance. One oversized read was truncated; required
dispatch/fixture text was retrieved in a subsequent focused read. Real SDK
Escape/Ctrl+C during parked selection, replacement during checkpoint, obsolete
callbacks/exact UI cleanup, one selection and current error controls exercised.
Both initial HIGH findings closed by separately captured fresh review; root
did not self-approve. Final source/ADR unchanged from tested/reviewed tree;
this final recording is receipt-only delta before the scoped local commit.

Seven owned paths only. User's seven tracked changes retain SHA256
`55c81137fb1ab1c4ce10632d5ac5c62c46c050a3a766a38ab8b9b995512f0270`;
Auldwyrm tracked diff retains
`94f585de57d915f93623de690dca8ebad3ffec018fbdf85e24617da4510547aa`.
Unrelated untracked artifacts untouched. Two source exports; initial reviewed
source superseded by findings, repaired source verified. Observed-only budget,
no controller/provider hard enforcement or price/quota claim; root below the
30-minute warning, protected reserve spent on repairs/review/validation/handoff.
No Statewright query/load/use/workflow, live session access, actual approval,
resolver/decision, real inference, install/vendor patch, deployment or push.
Rollback is a coherent scoped revert retaining journals/native owner records.
Next safe bounded work: interactive settings/scoped-model gestures, then
remaining native effect/internal transport/publication and recovery boundaries;
authoritative live/cross-host acceptance requires its own permitted journey.
The full nine-row/012/111/116 objective is active, not complete or blocked.

## Slice 17 entry: owning native input cancellation

Base02fdff6; previous turn verified progress, not wait/no-progress. Fresh main/
dirty ownership checks retain the seven user changes and Auldwyrm unchanged.
Full006/012/spec111/116 objective remains active. Manual/no Statewright query,
load or use overrides skill workflow activation. Root alone implements; the
skill-required independent read-only review is not implementation delegation.

SDK0.73.0 RPC abort awaits Session.abort, which aborts retry/Agent and waits idle,
not private parked input. Interactive Escape calls Agent.abort only when native
isStreaming, which excludes a parked approval. This bounded source cut supplies
native modes a separate session/Agent view: private cancellation capability,
pending-input visibility for Escape, synchronous input invalidation before waits,
captured cancellation/Agent identity rather than any latest-reference lookup
after awaits. Raw SDK/project methods do not receive native-input authority.
Keep readiness alive for fresh explicit input; never clear approval journal or
consume a late grant for cancelled input. Native RPC abort and the actual SDK
Escape handler must exercise this boundary without patching/vendoring SDK.

Owned scope: request-operations/frontend/mode, actual SDK frontend/mode tests,
optional exact CLI cancellation tests, ADR008 and this receipt. First add red
actual SDK cancellation tests; then prove parked prompt/configuration denial,
pre-hook lookup cancellation, late reply/new-input ordering, current streaming
Agent abort and project inherited denial. Durable parent cancellation is proved
only after a private reference is received; cancellation before a lost begin
reply, compaction/retry/branch controls, interactive configuration selectors,
remaining effects/publication/recovery and authorized host acceptance stay open.
No actual authority/decision/inference, live sessions/panes/process signals,
install/deploy/push. Task-owned inert HTTP/SDK/streams/children only.

Exact staged/exported integration gate: Node308 baseline serial, Pi266 baseline
plus one existing opt-in live skip, native2, Claude managed parity/mjs syntax,
then mandatory clean-context Astra/high read-only review. Observed-only envelope:
100 normal/135 contraction root calls;30-minute warning/45-minute contraction;
16KiB output target and final-third validation/review reserve. Reviewer10 calls/
12minutes/two focused checks; fresh finding-only recheck4 calls/5minutes/two
checks; max2 distinct repairs/finding, two exports plus regression-justified
third. No controller/provider enforcement, catalog probe or quota-price claim.
Scoped local commit/revert preserves native/journal evidence and unrelated work.

Retained red baseline: three actual SDK tests fail on missing cancelInput.
First implementation passes those three. Expanded SDK fixture7/7 passes,
including actual Escape methods, streaming/new-input cancellation completion
and cancelled model-registry handoff. Initial in-process RPC fixture2 failed:
one infinite native-loop await/teardown timeout, one malformed configuration
payload before admission. Installed rpc-mode.js595 returns a forever promise
and shutdown owns process.exit; fixture/evidence defect, not product failure.
Replace only that unsafe fixture with task-owned CLI children and strict native
payloads, preserving cancellation/journal/late-approval/no-effect assertions.
Both actual native RPC CLI cancellation cases pass; no timeout enlargement,
production process interception or positive acceptance weakening. Those local
gate receipts precede source freeze/integration/review, not full acceptance.
Discriminating old native-control run: Escape1/1 fails parked streaming visibility;
actual RPC CLI2/2 fail because abort replies success while parent remains parked.
Restore only native mode view/dispatch, preserving all assertions. Further root
red tests cover late SDK/project callback handoff after explicit native cancel;
ordinary parked/cancelled phase alone must not suppress genuine current errors.
Both new awaited-handoff tests fail with the guarded SDK systemPrompt denial;
one also causes the cancelled project's declared-effect failure to revoke owning
readiness. Product defect, bounded repair1: retain the exact privately native-
cancelled reference as obsolete context, not phase-only/error-string suppression.
Existing genuine-current-held-error tests remain required positive controls.
Expanded root SDK/CLI/inlet gate131/131 passes (91 frontend,27 main,13 inlet),
including those two repaired handoffs and unchanged genuine-current-error
controls. Fail-fast changed mjs syntax and Claude managed parity exit0. These
precede exact-source freeze/integration/review; no Rust/typecheck/lint/build,
headed TUI or actual reviewer/gateway conformance has been run.

### Slice 17 full-objective audit, not completion

Re-read current006 required nine-row contract,012 numbered1-4/slicesA-D and
Auldwyrm111 native/reviewer/evidence requirements plus116 conformance/promotion.
Historical source/staging receipts are not current live verification. All
original acceptance obligations remain controlling, with these dispositions:

1. Immutable full ticket/artifact digest/policy/reviewer/expiry/revocation remains
   partial/open; no authority contract or complete ticket implementation added.
2. Local native UUID/epoch/private capture and experimental parent ownership
   remain partial; branch/replacement/cross-host lineage is still open. Native
   cancellation captures the existing reference, not model-supplied latest work.
3. Pending/no-declared-effect/no-inference gains reachable RPC abort and original
   SDK Escape cancellation for the tested parked prompt/configuration paths.
   Interactive configuration selectors/settings/hotkeys, other native settings/
   registry/queue, filesystem/spawn/branch/provider/publication/rendering and
   all internal transport/retry/summary continuations remain open.
4. Query-before-controls/required-reviewer information and entitled native plus
   website authenticated decision journeys remain unproved here; hosts do not
   gain a resolver. This slice adds cancellation, never approval/deny authority.
5. Cancel/dismiss/disconnect retention gains native control cancellation with
   exact received reference, preserved journal/readiness and fresh explicit
   input. Cancellation before lost begin reply, complete native cold restart,
   crash-lock/legacy recovery, parent inflight-drain and permanent SDK teardown
   failure stay open. Approval decisions are not consumed by cancelled input.
6. Exact private nonce/tombstone/consume-before-clear fixtures remain partial;
   real policy/entitlement/artifact reconciliation and exactly-once native
   delivery across crashes remain open. A late synthetic grant can be consumed
   only by a fresh explicit request, not the cancelled continuation.
7. Older continuation/final-response ownership gains cancellation-before-hook,
   late guarded SDK/project handoff denial and no newer Agent/pending-state
   interference on old cancellation completion. All native effects and final
   publication/rendering are not collectively proved; full activation stays open.
8. Private routing/API keys are not human-click/authentication-strength evidence
   or malicious same-OS isolation. Complete source/auth-strength provenance is
   open; no decision submitted or actual human authority verified.
9. Shared client-neutral reviewer/evidence/retention semantics, installed clean
   packaging and every advertised client/host acceptance remain open. No website
   requirement or enterprise/compliance coverage is inferred from local fixtures.

012 A/1 user-dirty Rust pending pre-tool denial preserved/uncommitted and not
validated here. 2 host-unprivileged/no-decision surface retained; actual trusted
decision route untested. C/3 experimental parent journal/deferred-clear/close/
synthetic reopen remain partial, not production cold-native restart. B/4 owning
RPC/Escape cancellation is reachable in this experimental mode but all effect/
transport integration and production main activation stay open. D actual native/
gateway approval, restart and host-parity canaries are not run under explicit
no-workflow/no-real-decision authority. Spec111 shared native/website/reviewer/
evidence/cold/new-input journeys and116 clean packaging, desktop/protocol/native
Windows versus WSL,100 deterministic iterations per supported runtime/24-hour
staging soak/production promotion are gates, not completed evidence. No workflow,
actual approval/inference, live sessions, installation, deployment or push.

Exact next bounded source input: trusted interactive configuration gesture
wiring, capturing private action before selector/registry awaits, binding the
selection callback to that original scope and awaiting guarded mutation before
UI success/publication. Do not lend raw setters latest ownership. Then complete
remaining effects/publication, lost-begin/cold recovery and authorized reviewer/
host conformance. Safe manual implementation remains; goal is active, neither
complete nor blocked. Source milestone completion cannot narrow that objective.

Frozen source d09fcb2f899f3b27a93f308f210a1bdfca990ec5 at
/tmp/statewright-native-cancellation.fbIvBx passes serial Node308/308, Pi277
passed/one existing live skip, native2/2, fail-fast Claude parity/3mjs syntax0.
Mandatory read-only reviewer is assessing that source, not implementation.
Root adjacent primary-source check: SDK InteractiveMode.setupExtensionShortcuts
1223-1277 synthesizes ctx.abort from native mode session and invokes project
shortcut outside prompt ALS. Existing frontend registerShortcut was unwrapped.
New actual SDK shortcut regression distinguishes possible new capability exposure.
If established, this is a product callback-boundary repair within no-project-
native-input-authority acceptance, not full hotkey/configuration implementation.
Actual SDK shortcut regression fails: synthesized ctx.abort resolves instead of
denial and can cancel parked input. Root finding P2 established; prior source
gates/review cannot approve this boundary. Repair1 additionally owns
plugins/pi/src/project-effects.mjs (one wrapper): wrap/seal shortcut registration,
mask unbound project callbacks with a private no-reference scope. No latest
request/admission is lent to extension hotkeys. Add captured registration seal
regression; retain original cancellation/no-effect assertions. A new frozen
export/integration gate and fresh finding-only independent recheck are required.

Initial clean-context Astra/high /root/pi_native_cancellation_review returned no
established defect in its bounded pass:8 diagnostics/1 focused invocation,6 tests
pass/85 unselected (actual Escape/new-input/model/callback/current-error controls),
scoped diff-check0 and task process terminal. Root's later actual shortcut proof
supersedes that no-finding disposition; it is not final approval of repaired
source. Source exports/resources are validation fixtures, not live sessions.
Root repaired-boundary focused gate6/6 passes (87 unselected), covering the actual
synthesized shortcut denial, captured registration seal, native Escape, two late
handoffs and unchanged genuine-current-error control. Added project-effects mjs
syntax/diff-check0. Freeze the eight owned paths and rerun the declared exact-
source integration; optional breadth remains stopped, validation/review/recording
reserve protected. This is the second source export, not another discovery loop.

### Slice 17 final source, review and handoff

Final tested/reviewed tree431411cd309b63efcfac166ed5a11e24b7f7f2ed, exact export
/tmp/statewright-native-cancellation-repaired.7B3Fbq. Serial Node308/308 (zero
failures/skips/cancellations); Pi279 passed/one existing opt-in live-canary skip
(eight files passed/one skipped); native2/2 (zero failures/skips/cancellations).
Fail-fast Claude managed-client parity and four changed mjs syntax exit0;
staged diff-check0. No source/ADR delta after this export; final recording is
receipt-only before the scoped eight-path local Git milestone. Initial red,
failed-fixture and superseded source/review evidence remain above. Serial gate
does not assert the prior parallel Codex shutdown-fixture race is fixed.

Fresh clean-context Astra/high /root/pi_native_cancellation_recheck reports no
established defect within shortcut repair against this exact tree. Independent
focused test4 passed/89 unselected, exit0,1.32seconds: actual SDK synthesized
shortcut ctx.abort denial, captured registration seal, original native Escape
and genuine-current-error control. Four diagnostic commands/one completion poll
across four tool submissions, one focused invocation; task test process exited
and fixtures cleaned. Inherited shortcut async denial is supported by ALS but
not separately exercised in that recheck; root inherited-capability/callback
tests and full integration are distinct evidence, not an inferred reviewer run.
Root alone implemented. Initial mandatory reviewer plus fresh finding-only
recheck matches the declared worst route; no implementation delegation.

Actual SDK/Agent and task-owned CLI fixtures use inert HTTP/synthetic authority;
Pi client connection diagnostics are mocks. No Rust/workspace typecheck/lint/
build, headed TUI/rendering, actual reviewer/gateway/native/website canary,
hosted CI/100-iteration races/24-hour soak or staging/production promotion.
No Statewright query/load/use, real approval/decision/inference, live sessions/
panes/process signals, installed SDK patch, installation, deployment or push.
All nine-row/012/111/116 obligations and exact next input in the full-objective
audit above stay controlling; native cancellation progress is not complete
P0/P1 delivery. Goal remains active; safe manual source work remains available.

Manual source/evidence/Git profile stays root-owned; no new production runtime
control/authority/schema. Main route inherited, independent frontier high;
observed-only normal100/contraction135calls,30/45-minute thresholds and protected
validation/review/recording reserve. Two source exports, one bounded repair for
each distinct late-handoff/shortcut finding; one mandatory review plus one fresh
finding recheck. Approximately12minutes from source preflight to recheck receipt;
no wall-time threshold crossed. Aggregate root provider/tool-byte/call totals and
controller enforcement were not instrumented: do not imply measured hard quota
compliance or invent pricing/workflow identity. Optional breadth stopped for
required repair/validation/review. No memory write or production-control baseline.

User-dirty seven-path hash remains
55c81137fb1ab1c4ce10632d5ac5c62c46c050a3a766a38ab8b9b995512f0270;
Auldwyrm diff hash remains
94f585de57d915f93623de690dca8ebad3ffec018fbdf85e24617da4510547aa,
HEAD65025b50952e27b38b215b18905ba1c4770fbdb4. User untracked artifacts preserved.
Rollback: scoped local source commit revert, preserving all native/owner/journal
evidence; no installed runtime or schema migration to roll back. Durable source/
receipts remain in canonical Statewright Git, not temporary validation exports.

## Slice 16 entry: owning native RPC configuration input

Base9c0dc2a; previous turn verified progress, not wait/no-progress. Root freshly
verified main, tracked/untracked ownership and unchanged user/Auldwyrm diff
hashes. Full006/012/spec111/116 objective stays active. User expressly prohibits
Statewright workflow query/load/use; apply manual source/evidence/Git controls.
No actual authority/decision/inference, existing live sessions/panes, install,
deployment or push. Root sole implementation owner; independent read-only
review is the skill-required exception, not implementation delegation.

Installed public SDK0.73.0 runRpcMode accepts only runtimeHost, owns process
stdin/stdout, and invokes thinking/name mutators synchronously (rpc-mode.js
378-389/481). Session-only async wrappers would report success before a parked
mutation completes. This cut adds an explicit native RPC input boundary for
set/cycle model, set/cycle thinking and session name: capture private input
before registry await, checkpoint before native mutation, response only after
completion. Never lend latest request to raw SDK/project setters. Other protocol
records continue to SDK, whose normal startup/readiness/output remain owning.
Task-owned RPC mode temporarily substitutes its process stdin with the filtered
inlet and captures raw stdout before SDK takeover; restore on return/failure.
No SDK/vendor patch, private SDK import or copied full RPC dispatcher. LF-only
UTF8/CRLF and end-without-LF preserve installed SDK framing. Disconnect cancels
instead of draining pending authority indefinitely. Interactive selectors and
other configuration/effect/publication/native restart/host acceptance stay open;
this experimental source cut is not activation or full native gesture coverage.

Planned owned scope: request-operations/frontend/mode, new RPC inlet/helper tests,
actual SDK frontend/main tests, ADR008 and this receipt. Focused red/green SDK
and inlet tests precede one exact-source integration gate: serial Node308 baseline,
full Pi235 baseline/one existing live skip, native2, Claude parity/mjs syntax.
Freeze/export before mandatory bounded clean-context Astra/high read-only review.
Observed-only envelope:100 normal/135 contraction root calls;30-minute warning/
45-minute contraction;16KiB output target, final-third validation/review reserve.
Review10 calls/12minutes/two focused checks; fresh repair recheck4 calls/5minutes/
two checks. Max2 distinct repairs/finding; two exports plus regression-justified
third. Stop optional breadth at thresholds. No provider/controller enforcement,
catalog probe, quota-price claim or invented workflow identity. Scoped local
commit/revert preserves native/journal evidence and all unrelated dirty files.

Retained characterized baseline: two initial actual SDK tests fail because
9c0dc2a has no native configuration-input capability. First two new SDK checks
then pass,14 focused SDK/inlet cases pass, and all five actual native RPC actions
pass in task-owned children both active and approval-pending (10 cases, no
inference). For a discriminating old-path run restore only the previous direct
SDK RPC dispatcher: thinking and session-name CLI cases both fail success=true
assertions with actual native denial responses. Restore inlet without changing
those assertions. Expanded three-file SDK/CLI/inlet gate116/116 then passes,
including pending approval arising after model lookup, immutable payloads,
superseded selections and rejected project inheritance. A final explicit
close-without-EOF and actual SDK parked-inlet disconnect proof follows, before
exact-source freeze/review. This is not durable config-only native history proof:
SDK first history flush can remain deferred until an assistant exists; RPC state
audits, private durable epoch/journal and settings/model writes are the scoped
evidence. No native gestural or full original-scope completion claim added.
Final root focused SDK/inlet93/93 (frontend82/inlet11), including actual SDK
disconnect retaining durable approval and denying metadata/output; source freeze
and independent review follow. Broader acceptance remains open.

Initial frozen treebec6fa0c8eee8adcb4326c25af639b3aa991afbe at
/tmp/statewright-native-rpc-input.FYNdtq: Node308/308 serial, Pi264 passed/one
existing live skip, native2/2, Claude parity/four changed mjs syntax0. Green
source receipts are superseded: clean-context Astra/high read-only
/root/pi_native_rpc_input_review found P2 at inlet75-80: error/close listeners
are delayed until first filtered read, while actual SDK awaits native bind first.
Close before reader invokes disconnect0 versus1 after reader; isolated startup
error child exits1 with unhandled error/no cleanup. Eight diagnostics/two focused
checks, no edits/full-suite duplication/live authority or sessions. Mixed prompt/
config ordering passes prebuffered and flowing probes; no other scoped finding.

Root startup close/error regressions both fail against that source (callback0
and thrown synthetic error). Product-defect repair attempt1 registers terminal
listeners at inlet construction, preserving deferred command/data consumption,
exactly-once cancellation and listener cleanup. Fresh repaired-source full gates
and independent finding-only recheck follow. Installed SDK rpc.md documents abort
as aborting the current Agent operation; AgentSession.abort stops Agent/retry and
waits idle, not unrelated configuration. This cut proves replacement/disconnect;
full native approval cancellation/controls remain open, not inferred from abort.

### Slice 16 final source, review and full-objective audit

Final tested/reviewed tree4a30812cc95337b18bb7d8779fa66b136bf0da1c, exact export
/tmp/statewright-native-rpc-repaired.RwD8jA: serial Node308/308 (zero failures/
skips/cancellations), Pi266 passed/one existing opt-in live-canary skip, native2/2
(zero failures/skips/cancellations), Claude managed-client parity and four changed
mjs syntax exit0. Staged diff-check0. Pi client diagnostics are mocked; actual
SDK/CLI children use inert task-owned HTTP/synthetic authority, not real model,
reviewer or workflow calls. Initial failed and superseded receipts remain above.
Unchanged parallel Codex shutdown-fixture race remains unproved fixed; serial
gate is explicit. No full Rust/typecheck/lint/build, headed interactive UI,
actual gateway/website/native approval canary, hosted CI/soak or promotion.

Fresh clean-context Astra/high read-only /root/pi_native_rpc_input_recheck
closes the P2 in that exact repaired export: static owning-close/bind review and
direct Node inlet fault probe,3/3 startup variants (close, destroy(Error), error
queued before router construction). Each disconnect1, configuration0, replies0,
forwarded0 after late reader attachment; listeners detach, all task streams
destroyed, Node exits0. Four diagnostics/two focused checks; incorrect initial
path reads consumed budget, no independent native integration suite rerun.
Root full exact-source gates above provide that evidence, not an inferred pass.
No remaining finding in repair scope; no broader activation/cleanup approval.
Future review packets must list full export-relative paths at initial dispatch
to avoid repeating wrong-path work; do not enlarge a review merely to absorb it.
Root alone implemented; one independent decision pass plus required fresh
finding recheck, no implementation delegation. Final recording is receipt-only
delta from tested/reviewed source before the narrow nine-path local commit.

Root re-read current006 nine-row contract/012 numbered plan and Auldwyrm111
native/reviewer/evidence acceptance plus116 cross-host conformance. Historical
staging statements are source context, not current live verification. Controlling
Slice15 full nine-row audit stays intact, with these explicit dispositions:

- Rows1/4/6/8/9 remain open/partial: full ticket/artifact/policy/reviewer/expiry/
  revocation, entitled native/website decision control, real once-only delivery,
  human-strength authentication/provenance and shared evidence/retention/hosts.
- Row2 gains privately captured native RPC action/payload identity before lookup;
  full branch/replacement/cross-host lineage still open beyond local epochs.
- Row3 gains five reachable native RPC configuration commands, no false success
  during pending approval, fresh post-lookup checkpoint and no inference in the
  tested configuration journey. Interactive selectors/settings/hotkeys, other
  native settings/registry/queue mutations, filesystem/spawn/branch, publication/
  rendering and all internal transport/retry/summary continuations remain open.
- Row5 gains startup terminal-input cleanup and parked RPC disconnect retaining
  approval; complete native cold restart/crash-lock/legacy/permanent SDK teardown
  failure and unified native approval-cancel control remain open.
- Row7 gains native RPC selection/payload/new-input ownership and late-response
  suppression on disconnect, not every old native effect/final publication.

012 A/1 user-dirty Rust pending pre-tool denial remains unchanged/uncommitted and
unvalidated here;2 hosts never resolve, real authorized decision path untested.
C/3 experimental parent journal/deferred-clear/close and synthetic reopen remain
partial, not complete production native restart. B/4 native RPC prerequisite
now reachable in the experimental owning CLI, but full effect/transport activation
open. D actual gateway/native approval/restart/host-parity canary not run under
no-workflow/no-real-decision authority. Spec111 combined native/website/reviewer/
cold/new-input journey and116 clean release packaging, native Windows versus WSL,
desktop/protocol branches,100 race iterations/24-hour staging soak and production
promotion remain gates. No goal-complete or blocked status is justified; further
safe manual implementation is available. Original objective is not narrowed to
the five commands or inactive experimental path.

Next bounded source cut: trusted interactive configuration gesture wiring and
unified owning native input/control cancellation, capturing before selector/
registry awaits and awaiting guarded mutation before UI publication. Preserve
the private-capability/project distinction rather than relaxing raw SDK guards.
Then finish remaining effects/publication, native cold recovery and actual
reviewer/host acceptance. Supervision/workflow use remains explicitly disabled.

Manual source/evidence/Git profile stays root-owned; no new production-control
baseline or runtime authority. Normal one independent Astra/high review, worst
one fresh finding-only recheck/at most two distinct repairs per finding; observed
one required repair, two exact-source exports, review8/recheck4 diagnostics, no
extra full gate beyond superseded-source revalidation. Root inherited route,
provider-specific token/aggregate tool-byte counting and controller enforcement
unavailable; numeric call/time/output limits remain observed_only, not quota
guarantees. Optional breadth stopped once frozen; validation/repair/full audit
reserve retained, recording reached at about11 minutes after checkout preflight.

Seven tracked user files retain diff hash
55c81137fb1ab1c4ce10632d5ac5c62c46c050a3a766a38ab8b9b995512f0270;
Auldwyrm retains94f585de57d915f93623de690dca8ebad3ffec018fbdf85e24617da4510547aa.
User untracked inventory/other worktrees/existing live sessions unchanged.
Scoped commit revert preserves journals/native records; no migration or installed
runtime/live rollback needed. No workflow query/load/use, actual authority/
approval/real inference, existing native session access, install, deploy or push.

## Slice 15 entry: native configuration mutation ownership

Base83ac255; root reverified current main, seven tracked user changes, untracked
inventory and both checkout diff hashes. Prior turn is verified progress, not
wait/no-progress. Continue manual source/evidence/Git controls without any
Statewright query/load/use. This cut privately checkpoints project configuration
setters and native model-cycle registry handoff, blocks obsolete native state/
metadata mutations before write, and grants only revocable fixed SDK bootstrap
permission hidden from project callbacks. Preserve sync public registry reads
outside the particular SDK cycle handoff; no SDK/vendor edits or copied cycle
implementation. Real native SDK/task-owned files/loopback, synthetic authority.
Native model/thinking UI/RPC gesture admission, other filesystem/spawn/branch/
render/transport/retry effects and all006/012/spec111/116 full acceptance remain
open; default stock frontend behavior unchanged, no production activation.

Observed-only envelope:100 normal/135 contraction root calls; 30-minute warning/
45-minute contraction;16KiB output targets; final-third validation/review reserve.
Root is sole implementation owner. Skill-required clean-context Astra/high
read-only review10 calls/12minutes/two checks, fresh finding-only recheck4 calls/
5minutes/two checks, max2 distinct repairs per finding. Two exact-source exports
plus one regression-justified export. No controller/provider budget enforcement,
catalog probe or invented workflow identity; user prohibits workflow use.
Stop optional breadth at thresholds, preserve required validation/repair/audit.
Scoped local commit/revert preserves journals. No real authority/decisions/
inference, existing live sessions, install, deployment or push permitted.

Retained baseline: three new actual SDK tests fail on original83ac255: model
setter does not park, a superseded registry-awaited cycle resolves with obsolete
model, and unbound metadata append does not throw. Native write guard then
correctly denied the stale cycle, but fixture replaced getAvailable after guard
installation, testing only mutation guard rather than handoff checkpoint.
Move deferred registry behavior into pre-construction fixture options; retain
original await/stale assertions. Four critical tests then pass, including a
pending gate arising during registry await, before model/history changes.

Expanded fixture gate70 initially failed2: bootstrap-continuation probe spied
on setActiveTools (not called during late bind), and label probe used missing
entry ID. Native SDK source1608-1663 shows late bind emits startup then calls
extendResourcesFromExtensions; a subsequent bindCore spy also was not called
(core binding already occurred during construction). Correct probe to that
actual native continuation, not grant project bootstrap permission; create
valid label target through already-admitted project appendEntry. No mutation
or stale assertion weakened. Frozen-model compatibility probe then fails1:
proxying frozen native model directly violates nested non-configurable cost
property invariants. Read-only snapshot facade repair supports immutable SDK
records and blocks model/tools aliases. Full frontend73/73 now green, including
runtime provider registration/unregistration checkpointing and bootstrap lease
masking/revocation. A final inert SDK provider-turn compatibility check and
exact-source gates/review follow. No production, whole-native-config or real
authorization claim added; no SDK/vendor edit or cycle implementation copied.

Initial exact tree385b91d598668443e368aa91770b3aaf2a56f714 exported to
/tmp/statewright-native-config.qQGeIe: serial Node308/308, native2/2, Claude
managed-client parity/three mjs syntax0. Pi197 passed/37 failed/1 existing opt-in
live skip: every failure was the older actual-Agent fixture missing the required
public getAvailable method before installation. Correct its inert registry
schema, not production capability checks or assertions. This source is superseded.

Independent clean-context Astra/high read-only /root/pi_native_config_review
confirmed P1: Object.getOwnPropertyDescriptor exposes raw Agent model data,
native tools accessor setter and nested cost records through the guarded views;
ordinary assignment denial did not prevent actual native mutation via these
aliases. Root actual SDK descriptor regression fails against that source.
Repair attempt1 adds recursive guarded descriptor values/accessors and denies
configuration-field redefinition/deletion, retaining normal SDK assignments.
Capability preflight now rejects a missing public configuration method before
partially installing guards. No vendor edit or malicious-code isolation claim.

Wider corrected SDK gate110 passed/1 failed: the older same-text prompt is now
correctly denied before its post-await systemPrompt write, but propagates the
new configuration denial instead of ending as obsolete input. Preserve only
that contract: privately tag native-configuration denial and handle it only
when the originating prompt is authoritatively superseded. Current/unrelated
errors remain visible; no mutation or stale-output assertion weakened. Fresh
exact-source gates and finding-only independent recheck are required below.

### Slice 15 final source, review and full-objective audit

Corrected root actual SDK gate111/111 (frontend74 and Agent37). Final tested
tree a7b1570e662d0117eceff308e4cef2adba3f3969, exact export
/tmp/statewright-native-config-repaired.CMwGJA: serial Node308/308, Pi235 passed/
1 existing opt-in live-canary skip, native2/2, Claude managed-client parity and
three mjs syntax exit0. Zero Node/native failures, skips or cancellations.
Staged diff-check0. No full Rust/typecheck/lint/build, headed native UI, real
model/approval/workflow journey, hosted CI, production promotion or installation.
Retained unchanged parallel shutdown-fixture race is not claimed fixed by the
serial gate. Initial failed and superseded receipts remain above.

Fresh clean-context Astra/high read-only /root/pi_native_config_recheck reviewed
that exact repaired export: P1 closed, no remaining finding in requested repair
scope. Two focused checks: descriptor/frozen-model2 and same-text stale prompt1,
3 passed/108 excluded by filter. Four diagnostics, including an incorrect-path
lookup; no edits, install, actual authority/controller/workflow or live-session
interaction. Reviewed recursive descriptor values, guarded tools setter,
redefinition/deletion denial and private superseded-only error handling. Root
owns all implementation; review is the skill-required independent exception.
Final evidence recording is a receipt-only delta from tested/reviewed source.

Root reread current006 required nine-row contract,012 numbered plan/A-D and
Auldwyrm specs111 native approval and116 cross-host conformance. Historical
staging receipts in those documents were read, not revalidated or acted upon.
The complete original goal stays active, not redefined around configuration
APIs, synthetic authority, the inactive flag or this scoped reviewer result:

1. Immutable full ticket/artifact digest/policy/reviewer/expiry/revocation remains
   open beyond existing partial shared journal/identity validation.
2. Durable local UUID/request epoch and experimental parent lifetime remain
   partial; complete branch/replacement/cross-host lineage remains open.
3. Pending/no-declared-effect/no-inference coverage gains private project
   model/thinking/tools/metadata/provider registration and registry-awaited
   native cycle mutation guards. Owning native UI/RPC configuration gestures,
   remaining SettingsManager/ModelRegistry setters, filesystem/spawn/branch,
   rendering/provider publication and every internal transport/retry/summary
   continuation remain open. No universal interception or activation claim.
4. Full entitled native/website reviewer controls and authenticated decision
   authority remain unproved here; no resolver/decision surface added.
5. Durable cancellation/journal retention and synthetic reopen proofs remain
   partial, not full native cold restart, crash-lock/legacy recovery or permanent
   SDK teardown-failure cleanup acceptance.
6. Private once-only nonce/tombstone and fresh applied-edge consumption are
   synthetic proofs, not full real entitlement/artifact/policy rechecks or
   exactly-once native delivery under crash/transport loss.
7. Old request HTTP/message/native text/bash and configuration mutations are
   guarded in the tested paths. Every old final publication/rendering and other
   awaited native effect remains open; a late decision cannot reown old input.
8. Private managed key routing remains insufficient proof of a human click or
   isolation from malicious code under the same OS identity; provenance open.
9. Shared client-neutral reviewer/evidence/retention and all advertised host
   acceptance remain open. No mandatory website UX or certification asserted.

012 A/1 Rust pending pre-tool denial remains unchanged user-dirty/uncommitted
and unvalidated here;2 hosts remain unprivileged, actual authorized decision
journey untested. C/3 experimental parent mirror/deferred-clear/close and synthetic
native reopen remain partial rather than complete production restart acceptance.
B/4 full effect/transport activation remains open. D actual gateway/native
approval/restart/host-parity canary is not run under no-workflow/no-real-decision
authority. Spec111 full native/website/reviewer/cold/new-input journey and116
clean packaging/Windows versus WSL/desktop/protocol races/100 race iterations/
24-hour staging soak/promotion remain gates, not implied by these tests.

Next bounded source cut: an owning native configuration gesture adapter that
distinguishes trusted explicit user action from project/inherited SDK calls,
captures its private identity before waits and checkpoints before mutation.
Do not grant unbound SDK setters the latest reference or leave bootstrap alive;
the current experimental denial is not the accepted user journey. Follow with
remaining full effects/native publication and restart/authority/host acceptance.
User prohibition on workflow use remains controlling. More safe manual source
work is available; no goal-complete or blocked status is justified.

Seven tracked user-dirty files hash remains
55c81137fb1ab1c4ce10632d5ac5c62c46c050a3a766a38ab8b9b995512f0270;
Auldwyrm tracked diff remains
94f585de57d915f93623de690dca8ebad3ffec018fbdf85e24617da4510547aa.
Preserve user untracked inventory and existing sessions; owned commit is eight
paths only. Scoped commit revert preserves journals/native records and requires
no installed/live rollback. Manual profile/root ownership, observed-only numeric
envelope and required validation/review reserve retained; no enforced aggregate
provider-token budget or quota claim. Optional breadth stopped for repairs and
full audit. No Statewright workflow query/load/use, real decision/inference,
existing live session access, deployment, push or installation occurred.

## Slice 14 entry: secondary project HTTP ownership

Base 765ae8b; full original goal active. Manual source/evidence/Git controls;
no Statewright workflow query/load/use, real decisions/inference or live session
inspection. Root owns implementation. This bounded cut captures each secondary
project HTTP call's private immutable request, gates dispatch and subsequent
body reads, combines cancellation, and rejects stale results. Actual SDK/index
docs-tool tests use synthetic authority and intercepted inert responses only.
Gateway/bootstrap transport retains its separate designated observation path;
standalone extension HTTP behavior is preserved. Native configuration writes,
filesystem/process/branch effects, provider event publication and all original
006/012/spec111/116 obligations remain open; this is not production activation.

Observed-only envelope: 100 normal/135 contraction root calls, 30-minute warning/
45-minute contraction, 16KiB output targets, final-third validation/review reserve.
Skill-required clean-context Astra/high read-only review: 10 calls/12 minutes/
two checks; fresh finding-only recheck: four calls/five minutes/two checks; at
most two distinct repairs per finding. Two exact-source exports plus one
regression-justified export. No provider/controller budget enforcement available.
Serial Node gate retains the previous unchanged parallel shutdown-fixture
failure rather than claiming it fixed. Scoped local revert; preserve journals,
all seven tracked user changes and Auldwyrm; no installation/deploy/push.

Initial three docs fixtures failed before reaching HTTP: no workflow fixture
environment meant lazy-mode tools were not registered. Correct only task-owned
environment to fixture workflow/executor identity and exact loopback bridge;
fake client rejects every call except synthetic state observation. No actual
workflow/controller tool invoked. With original raw docs fetch restored for a
discriminating regression run, all three corrected tests failed: pending did
not park, stale body returned synthetic data, old callback borrowed unrestricted
HTTP. Restore owned helper: all three pass. Six focused tests subsequently
passed; initial provider-scope fixture failed because its fake ModelRegistry
lacked the SDK's pre-bind registerProvider method. Add inert registry spy at
construction, not relax frontend diagnostics. Expanded frontend gate56/56
passes: seven new cases and all49 prior SDK boundary cases. Cancellation races
cover ignored signals; late promises remain handled. No SDK/vendor file edit.

Initial frozen tree36dd3083d30a20868c22ae88f22ad38464247140, export
/tmp/statewright-project-http.vIbmuX: serial Node308/308; Pi218 passed/1 existing
opt-in live skip; native2/2; Claude parity/two mjs syntax and staged diff-check0.
Root expanded fixture gate57/57 before this freeze. These green source receipts
are now superseded, not final: independent Astra/high read-only reviewer
/root/pi_project_http_review found two P2 lifecycle defects in bounded probes.
R1 caller abort only raced the return, leaving the parked checkpoint polling
and able to consume a release (real gate probe: consume1/fetch0 after abort).
R2 natural body-iteration EOF did not release its reader lock (native comparison
unlocked; helper locked). No additional scoped finding; no edits by reviewer.

Root added actual SDK regressions: both fail against frozen implementation
(parked phase instead of cancelled; EOF body locked). Repair attempt1 each:
private operations.dispatch accepts a constraining caller signal, combines it
before checkpoint, and the HTTP capture passes cancellation through initial
dispatch and every body read. A parked cancellation durably cancels only its
captured request; no later release consumption/fetch. Iterator releases once
on EOF/error/return and becomes terminal after release. Focused repair2/2 green;
full source gates and fresh clean-context two-finding recheck required. Seventh
owned path request-operations.mjs now included; no implementation delegation,
SDK edits, authority fallback or native identity adoption.

### Slice 14 final source, review and original-objective audit

Final tested/rechecked tree0083169f4ec893a9c6497269059a543dc530e0c3, exact export
/tmp/statewright-project-http-repaired.mvbpzR: frontend59/59; serial Node308/308
(zero failures/skips/cancellations); Pi220 passed/1 existing opt-in live-canary
skip; native2/2; Claude generated managed-client parity, three mjs syntax and
staged diff check exit0. Both exports used existing dependency symlinks, not a
clean install. Pi cloud-URL diagnostics are mocked clients; new HTTP tests
intercept inert responses and otherwise use task-owned loopback/native files.
No Rust/workspace-wide typecheck/lint/build/security scan, headed/native UI,
real authorized decision/inference, actual workflow/main attachment, release
packaging, staging or production acceptance claimed. No migration/schema or
provider-controller envelope enforcement introduced. Previous parallel Node
shutdown-fixture failure remains an unchanged retained limitation; serial
success here does not relabel it fixed or prove concurrency acceptance.

Fresh clean-context Astra/high read-only /root/pi_project_http_recheck ran only
the two actual SDK repair tests in that final export:2 passed/57 filtered, exit0.
R1 closed: caller cancellation reaches the captured checkpoint, durable cancel
precedes simulated release, zero consumption/fetch; immutable reference remains
copied, no cancellation lookup against replacement input. R2 closed: EOF and
read failure unlock the captured body, subsequent return is idempotent. No
remaining issue within these two repairs. Replacement safety was independently
inspected structurally, not separately exercised by selected recheck tests.
Root alone implemented, one distinct repair per finding, two exact exports,
all root handles terminal. Final recording is receipt-only delta from the
tested/rechecked code, not a new code revision or whole-objective sign-off.

Current original006 nine-row audit (all full requirements remain controlling):

| Requirement | Evidence and still-open obligation |
| --- | --- |
| 1 Immutable tenant/client/session/run/edge/artifact/policy/reviewer/expiry ticket | Exact local journal/session/request checks retained; complete artifact/policy/reviewer/expiry/revocation semantics and real authority remain open. |
| 2 Native thread/lineage/request ID/epoch, never model identity | Parent/SDK/main experimental composition and copied HTTP origins retained; complete branch/replacement/cross-host lineage acceptance remains open. |
| 3 Pending means no declared effect/inference; human work parked outside inference | Secondary HTTP dispatch/body consumption now privately checkpointed; native configuration, filesystem/process/branch effects, provider publication, all transport/retry/summary boundaries and default activation remain open. |
| 4 Authority before controls; unauthorized dismissal only | No host decision surface or new authority inference; full entitled native/website reviewer journey remains open. |
| 5 Cancel/dismiss/disconnect preserves pending; cold resume reconciles | Durable journal/cold synthetic-parent proofs retained; canceled HTTP cannot consume a later release. Full crash-lock/legacy/native cold restart and permanent SDK failure cleanup remain open. |
| 6 Private resolution with freshness checks; consume once; duplicate/late harmless | Existing nonce/tombstone/applied-edge tests retained; caller cancellation reaches checkpoint before consumption. Real entitlement/artifact/policy freshness and complete native acceptance remain open. |
| 7 New input invalidates old continuation AND final response | HTTP headers/body/default reads cannot borrow replacement ownership or publish late data; native configuration, every declared effect and asynchronous interactive rendering remain open. |
| 8 Decision provenance/authentication strength; agent key is not human/isolation proof | Owned child credential separation retained; synthetic authority only, no new strong-human or malicious-agent/OS-isolation claim. |
| 9 Shared client-neutral reviewer/evidence/retention, no forced website | Shared P0 journal/service remains; complete retention/evidence/reviewer/cross-client/advertised-host acceptance remains open. |

P1 012 audit: A/1 Rust pending pre-tool denial is still unrelated user-dirty and
unvalidated/uncommitted here; 2 hosts remain unprivileged, real trusted decision
journey untested; C/3 previous exact experimental parent/deferred-clear/readiness/
synthetic cold resume proofs are retained by current Node suite, not production
or complete restart acceptance; B/4 gains secondary HTTP ownership only, not
whole effect/transport safety; D workflow-loading actual gateway/fake-Pi canary
not run under no-workflow/no-real-decisions authority. Specs111/116 combined
native+website reviewer/cold/new-input, packaging/Windows/WSL/desktop/soak and
promotion gates remain open; proposed114 enterprise requirements not asserted
implemented. Native fixture success cannot replace those accepted boundaries.

Exact next bounded source milestone: privately checkpoint project setters and
native metadata/configuration mutations before effect. Installed SDK cycleModel
awaits ModelRegistry.getAvailable then writes agent.state.model before appending
history; append-only guarding is too late. Capture original request across that
await, protect mutation before it changes model/history/settings, preserve only
explicitly trusted fixed bootstrap behavior and prove no foreign abort/latest
ownership borrowing. Then close remaining filesystem/spawn/branch/render and
transport/internal-retry gaps and authorized full acceptance. Do not narrow the
original objective to protected APIs or the experimental flag.

Canonical seven user-dirty tracked files unchanged SHA256
55c81137fb1ab1c4ce10632d5ac5c62c46c050a3a766a38ab8b9b995512f0270;
Auldwyrm untouched tracked diff SHA256
94f585de57d915f93623de690dca8ebad3ffec018fbdf85e24617da4510547aa;
untracked user artifacts preserved. Manual profile owner root; no invented
workflow/run identity. Scoped local revert preserves journals and owner records;
no installed/live artifact to roll back. Full goal active, not complete or
blocked; no workflow query/load/use, live session access/signals, actual resolver/
decisions/inference, installation, push or deployment. Local Git milestone only.

## Slice 13 entry: parent-owned Pi composition

Base ee8ceb2; authoritative goal active. Root reverified the unchanged seven
tracked user changes and both checkout hashes. Manual agentic-engineering
controls continue without any Statewright query/load/use or workflow identity.
This cut connects executor main, descriptor-first bridge construction, deferred
journal consumption, exact child readiness and the fixed owning SDK CLI. It is
an explicit experimental --pi-request-frontend path, not a replacement objective
or default activation: all original 006/012/spec111/116 requirements remain.
No stock-Pi fallback after an owned launch failure. Other hosts and the default
legacy hold-only path retain their existing behavior.

Acceptance uses real durable ownership/journals and task-owned native files,
loopback IPC and inert children, synthetic authority only: pending cold resume
can launch but cannot dispatch before exact readiness/consumption; observed
pending does not terminate the owning parked frontend; exit/startup failure
revokes its controller; a fast acknowledged print child is not misclassified;
launch cannot override native selection/module/model through stock host flags.
Remaining project effects, asynchronous interactive rendering, real entitlement/
resolver/artifact freshness, native restart canaries and cross-host acceptance
are not discharged by this composition. No live/native session inspection,
real decisions/inference, installation, push or deployment authorized.

Observed-only envelope: 100 normal/135 contraction root calls, 30-minute warning/
45-minute contraction, 16KiB output targets, final-third validation/review reserve.
Root is serial implementation owner; skill-required clean-context Astra/high
read-only review: 10 calls/12 minutes/two bounded checks; fresh finding-only
recheck: four calls/five minutes/two checks, at most two repairs per finding.
Two exact-source exports plus one regression-justified export; no provider or
controller enforcement claims. Thresholds stop optional breadth, not required
repair or full-objective audit. Scoped local revert preserves journals; no
migration, production-control expansion or implementation delegation.

Retained red: two host-adapter tests proved owned=true still launched stock Pi
and accepted an arbitrary executable. Initial actual parent/CLI checks failed
2/2 before readiness: fixture omitted executorId, falsely taking the standalone
workflow-load path. After supplying the exact fixture identity, both checks
still failed zero-response/zero-HTTP: fake request accepted an object instead
of the bridge's actual request(method, params), causing read-only state failure
and correct input hold. Correct only these fake-client identities/signatures;
no input/provider assertion, denial or production authority boundary weakened.
Existing root CLI entrypoint was found outside src and reused; no duplicate
entrypoint retained. Temporary synthetic-only diagnostic removed before freeze.

Separate parent credential boundary: owned project getApiKey returns null before
environment/file access; private bridge initialization/lazy commands do not
require a privileged key. Unit proof retains a supplied fixture key and verifies
zero key-file reads or telemetry requests. Ordinary standalone behavior remains.
Focused public SDK parent+index gate58/58; actual old CLI gate15/15 preserved.
Initial focused Node49/49; expanded cleanup proof verifies controller failure
cannot skip stopping/reaping an unacknowledged owned child. Parent shutdown
invalidates readiness before SIGINT and cleanup releases ownership despite
revocation/bridge failure. Exact-source gates and mandatory review follow.

First frozen tree e290845e98528339fe26fcc9cf6264ad2f2467ca, export
/tmp/statewright-parent-composition.NzDNIt: Node306 passed/1 failed of307;
native2/2, Claude parity/four mjs syntax exit0. The new success fixture's 20ms
readiness timer expired during parallel filesystem ownership verification.
Correct success setup to the actual unchanged production 5,000ms contract;
retain explicit20ms timeout/cancellation-failure scenarios. No production wait,
SDK/authority gate or success assertion weakened. Initial Node source receipt
remains failed/superseded; fresh exact-source export required after correction.

Corrected exact tree bc229e49ba0532f68d13742759848fa34dd9976b, export
/tmp/statewright-parent-verified.VCmz8n: fresh Node307/307 (zero skips/failures/
cancellations), Pi210 passed/1 existing opt-in live-canary skip, native2/2,
generated Claude parity/four mjs syntax exit0. Node command: unchanged17 executor
suites plus executor-pi-parent, Pi session-owner and Claude managed-client bundle;
Pi npm test -- --reporter=dot and npm run test:native; parity via sync-managed-client
--check; syntax main/native-readiness/pi-runtime/host-adapters. All root handles
terminal. Installed dependencies reused without install or vendor edits; fake
network/gateway diagnostics are not live-service proof. Rust/workspace-wide lint/
typecheck/build, real main attachment/load, actual reviewer/resolver/provider,
headed TUI, staging/production/native Windows/WSL/desktop gates not run/claimed.

Full original scope audit, not redefined around this flag: 006 row2 now includes
main's descriptor-first owned composition, exact spawned-child ACK and lifetime
revocation, but full branch lineage/replacement/host acceptance remain open.
Row3 gains private parent launch/park/consume evidence, not direct project
filesystem/spawn/configuration/provider/telemetry, global writes, later provider
transport/internal retries/summary subrequests or every consequential effect.
Row5 gains actual fixed-CLI cold parked reopen with same native ID/file and newer
epoch under synthetic authority; cancellation retains the journal. Crash/lock/
legacy recovery, real entitled decision and complete native restart canaries
remain. Row7 keeps native message/latest-text protection; asynchronous interactive
rendering/buffered output leases still open. Rows1/4/6/8/9 retain ticket/artifact/
policy/expiry/entitlement/reviewer/provenance/retention/client-neutral obligations.
Removing key-file fallback is narrower than hostile-code/OS isolation or proof
of a human click. No immutable ticket/real resolver/UI authorization claim added.

012 A/1 Rust pending pre-tool denial is still user-dirty, not validated/committed
here; A/2 no host decision surface preserved, real reviewer path untested. C/3
parent request-controller/deferred-clear/observer/close integration now exists
only through the explicit experimental flag, with actual synthetic cold native
fixture evidence; default remains legacy. B/4 real owning frontend launcher now
connected, but all effects/render/transport guards precede production activation;
projection-only clearance still cannot release. D local-gateway/fake-Pi trusted
decision denial/re-admit/restart canary not run. Spec111's combined real native/
website journey and116's packaging/native Windows/WSL/desktop/soak promotion
requirements remain unfulfilled. Full goal active; no changed definition of done.

Next bounded implementation: protect remaining project effect/configuration/
native mutation paths with originating private ownership, then asynchronous
interactive output/transport continuations; retain parent/cold-resume/replacement
regressions. Only after these and authorized full native acceptance should the
default move off ADR007 hold-only. Safe local work remains, so not blocked or
complete. Original authority exclusions and both dirty-tree hashes unchanged.

Mandatory clean-context Astra/high /root/pi_parent_composition_review used10
read-only calls/two bounded checks. Original export's parent8/8 passed; held
controller.close on corrected export reproduced P2: after20ms startup timeout,
120ms later the unacknowledged fake child was alive with zero signals. Releasing
cancellation then signalled/reaped it. Readiness was revoked, so this is a child
lifecycle/drain defect, not a demonstrated authorization bypass. Root adds the
discriminating held-cancellation regression before one repair: revoke/start
cancellation, signal immediately, then await both cancellation and reaping while
preserving cancellation errors. Prior green integration export is superseded
for this runtime defect. One regression-justified third exact export and fresh
finding-only clean-context recheck required; full scope/default boundaries stay.

Root held-cancellation regression failed1/1 with zero child signals before the
repair. After moving stop ahead of the await and joining cancellation/child
completion with allSettled, fresh parent suite9/9 and main syntax exit0.
No cancellation error is suppressed and completion still waits for cancellation;
signal/reaping proceeds while it is held. Final source validation follows.

Final repaired tree2710401fe3da6683f9825a4037244951e428e28b, export
/tmp/statewright-parent-repaired.KsX9zc: Pi210 passed/1 existing opt-in live skip,
native2/2, Claude parity/four syntax exit0; Node307 passed/1 failed of308.
Failed unchanged Codex app-server child-shutdown fixture uses20ms shutdown grace
and timed out confirming its task PID70582 after SIGKILL during parallel load.
Both Codex runtime/test are byte-unchanged from ee8ceb2 (Git tree diff empty).
Exact failed task PID no longer exists (signal0 ESRCH, no termination signal
sent); isolated same-export/same20ms test passed1/1. These observations support
a load-sensitive exit-confirmation race; they do not prove a general production
shutdown fix. No source/assertion/grace weakened or unrelated Codex fix made.
One justified full Node execution with --test-concurrency=1 characterizes the
unchanged-source integration separately; retain the concurrent failure and its
validation limitation regardless of the serial result. No additional export.

Fresh clean-context Astra/high /root/pi_parent_composition_recheck used4 calls/
two bounded checks within5minutes. P2 closed: existing held-cancellation case
signals/exits child while cancellation is held and parent remains pending;
independent memory challenge holds child exit while cancellation rejects,
readiness stays revoked/late ACK denied, parent stays pending and reports the
cancellation failure only after child exit. Existing prompt cancellation-failure
case also passed. No remaining finding in P2 repair, no broader verdict. No
implementation delegation or reviewer source edits; full original audit above
remains controlling. Third export justified by that one product repair.

Final same-export serial Node gate308/308, zero skips/failures/cancellations,
exit0; unchanged20ms Codex shutdown case included. Parallel307/308 remains a
recorded load-sensitive validation limitation, not overwritten by serial green.
All root test handles terminal; no live/user process inspected or signalled,
only exact failed task PID existence checked. Production source/ADR/tests match
the reviewed/tested tree exactly; final delta is this receipt only. Seven user
tracked diffs retain55c81137fb1ab1c4ce10632d5ac5c62c46c050a3a766a38ab8b9b995512f0270;
Auldwyrm retains94f585de57d915f93623de690dca8ebad3ffec018fbdf85e24617da4510547aa.
Manual profile owner/root and rollback via scoped local commit revert unchanged;
no durable schema migration, journal deletion, live activation or production
control claim. Optional breadth stopped; additional validation was limited to
retained red/P2 repair/recheck and the characterized unchanged Codex fixture.
Numeric envelopes are observations/routing thresholds, not enforced provider
usage. Full objective active with useful safe source work remaining, not complete
or blocked; no Statewright workflow/query/use, real decision/inference, installed
runtime change, dependency installation, push or deployment occurred.

## Slice 12 entry: native command admission and late output

Base faa8c58, canonical Statewright main; authoritative goal remains active.
The same seven tracked user changes and untracked plans/canaries are preserved;
Statewright user diff55c81137fb1ab1c4ce10632d5ac5c62c46c050a3a766a38ab8b9b995512f0270,
Auldwyrm94f585de57d915f93623de690dca8ebad3ffec018fbdf85e24617da4510547aa.
Manual implementation only: no Statewright query/load/use/workflow, real
decision/inference, existing native sessions, push/install/deploy. The combined
agentic-engineering controls apply without its workflow activation, overridden
by the user's explicit manual instruction. Root owns the existing manual
source/evidence/Git control profile; one clean-context Astra/high read-only
review after source freeze, no implementation delegation.

Installed public SDK0.73.0 executes extension commands before input interception,
executes native bash without that input path, and persists/emits a message after
awaiting its project message_end hook. Stock text mode reads the last shared
Agent state even when its latest command/input produced no response. This cut
owns private admission for registered commands and native bash, cancellation/
late chunks/results/recording, public SDK event subscriptions and message writes,
and latest-owned text response selection. No SDK dependency source edits or
global stdout interception. Scope: request operations/frontend/project-effects/
mode plus focused actual SDK/CLI fixtures, ADR008 and this receipt. Direct
filesystem/spawn/configuration/provider/telemetry and asynchronous interactive
render continuations remain explicit open requirements, as does parent main/
observer/host adapter production integration and full original acceptance.

Acceptance: a pending command/bash cannot invoke its handler/exec; a private
release is consumed once before execution; replacement drops old chunks,
results, SDK listener delivery and native message writes; inherited callbacks
cannot mint a user epoch; command-only/handled input cannot print an old final
response. Use actual SDK sessions/Agent, task-owned native files/loopback SSE
and inert synthetic parent authority. Retain red checks before implementation.
Same observed-only envelope:85 normal/120 contraction root calls,30-minute
warning/45-minute contraction,16KiB output targets/final-third reserve. No
provider counters/controller-interruption capability probe authorized. One
review10 calls/12minutes/2 challenges; finding-only recheck4 calls/5minutes,
<=2 distinct repairs/finding; two full exports plus one justified regression.
Thresholds stop optional breadth and record a compact verified handoff, never
declare full-goal success. Scoped local revert is rollback; no journal deletion
or legacy fallback. Entire006 nine-item/012 A-D/spec111/116 obligations retained;
items3/7 are strengthened locally, not a production acceptance claim.

Retained red: three actual SDK tests failed (41 filtered): slash handler bypassed
park, bash resolved code0/current+obsolete output after replacement, and two
late assistant message_end events published instead of one. First repair:
frontend44/44 passed. Expanded focused58 passed/1 failed: a new assertion
incorrectly expected first-session bash to flush native history immediately;
installed SDK SessionManager._persist defers until an assistant exists. Fixture
now proves public in-memory recording then the actual JSONL after a later
authorized synthetic response, retaining the bash-only zero-inference check.
No SDK persistence boundary/deadline/assertion weakened to force durability.
Fresh focused90/90: frontend47, private gate28, CLI15 (three new actual-child
scenarios: command-only text and native RPC bash active/parked). Added one
negative race for older bash finally vs newer status/cancel and static public
run ownership; root avoids the SDK's single mutable bash controller for control.
Full source gates/review/audit/local commit remain before acceptance.

First frozen tree799f6a785f43f549de1217d9f24e7cad70567ca1,
export/tmp/statewright-native-output.j97C4Z: Node297/297, native2/2, Claude parity
and four mjs syntax exit0; Pi203 passed/3 failed/1 existing opt-in skip. Three
older actual-Agent compaction fixtures seeded unbound public appendMessage after
installation; denial is correct. Scope adds request-agent-native.spec.ts fixture
preparation, not unbound runtime write authorization. Moving all history before
construction gave36 passed/1 failed: manual compaction now made3 HTTP calls vs
the original2 because its session ordering changed. Manual fixtures now capture
a private bind at before_agent_start and seed after the admitted prompt, retaining
the original ordering/two-call assertion; threshold setup is before construction.
Agent37/37 passed. No compaction implementation/provider/assertion was mocked or
weakened. Initial full gate remains failed/superseded, not reported green.

Mandatory clean-context Astra/high /root/pi_native_output_review used10/10
read-only calls and one memory-only SDK challenge. Confirmed P1 circular wait:
message_end hook waits for idle then awaits triggerTurn custom message; both core
turns finish but their Agent wrappers wait for public delivery behind that hook.
Observed streams2/coreEnds2/deliveredEnds0/hookReturnedfalse/settledfalse;
cancellation releases it. Root actual frontend/Agent/loopback regression failed
with returnedfalse/settledfalse (48 filtered), then one distinct repair moves
output draining to external prompt completion. Private output tokens distinguish
each Agent run within a request, bounded queue256, settled on delivery/error/
cancellation/close. Nested core completion never waits on its enclosing hook.
Expanded regression holds the second assistant's message hook: first delivered
agent_end cannot settle external prompt while nested output is still pending;
release yields both deliveries under epoch1. Finding-only fresh review4 calls/
5minutes, no new broad discovery. Final exact source export still required.

Final repaired tested tree3ba2b90c9a00ef9b4279cf88c98dd04b2300cfbf,
export/tmp/statewright-native-repaired.VBUIZ5. Fresh exact-export gates:
Node297/297, Pi207 passed/1 existing opt-in live skip (6 files passed/1 skipped),
native2/2; Claude generated parity and four mjs syntax exit0. Commands:
unchanged17 executor Node suites plus Pi session-owner/Claude bundle; npm test
-- --reporter=dot and npm run test:native in plugins/pi; node
plugins/claude-code/scripts/sync-managed-client.mjs --check; node --check on
project-effects/request-frontend/request-mode/request-operations. Focused129/129
and final held-nested-delivery1/1 retained. All root test handles terminal,
no widened timeout/restarted validation or changed dependencies/SDK install.
Mocked remote diagnostics are not network/live-gateway proof. Workspace Rust/
lint/typecheck/build/clean install/migrations/headed TUI/real reviewer/gateway/
provider/staging/production gates not run or claimed. Native first bash history
durability and async interactive/sink ownership remain explicitly open.

Fresh clean-context Astra/high /root/pi_native_output_recheck used4/4 read-only
calls,2/2 memory-only checks within5minutes, no writes/network/children/real
Statewright or existing-session interaction/full-suite repetition. Original
actual-SDK challenge now streams2/coreEnds2/deliveredEnds2/hookReturnedtrue/
settledtrue. Held second delivery: streams2/coreEnds2/deliveredEnds1/
hookReturnedtrue/settledfalse; releasing yields deliveredEnds2/settledtrue.
Original P1 closed; no remaining finding within recheck scope. Root owns the
final actual SDK/HTTP/native/CLI/full-suite gates and entire original acceptance.
One distinct product repair for the finding; fixture changes retained the
existing manual compaction HTTP2/threshold HTTP3 assertions and fresh private
runtime-write denial. First failed full export remains superseded evidence.

Manual accounting approximately110 root calls including source reads/failed
fixtures/repair/review artifact handoff/final recording, reviewer10 plus fresh
recheck4; roughly12minutes.85 normal target exceeded by fixture reconciliation
and mandatory finding repair, below120 contraction/30-minute warning/45-minute
contraction. No optional breadth after freeze; final work only source gates,
review closure/audit/receipt/scoped commit. Two full exports, no third; one
product repair and two distinct fixture ordering preparations, no reset.
Instruction/diff read targets occasionally exceeded16KiB; full selected skill
instructions read and owned source regions inspected. No provider counters,
output-byte ledger or controller hard enforcement claim. Only this receipt
differs from final tested source for reporting. Tracked user hashes unchanged
at Statewright55c81137fb1ab1c4ce10632d5ac5c62c46c050a3a766a38ab8b9b995512f0270
and Auldwyrm94f585de57d915f93623de690dca8ebad3ffec018fbdf85e24617da4510547aa;
same untracked inventory. Narrow nine-path local commit, no push/deploy or
production activation. Authoritative current goal active; full006/012/spec111/
116 audit/next exact integration input below retained. Final source inspection
confirms parent bridge still created without sessionOwner/controller/readiness
before native descriptor; host launcher still stock extension. Not completion.

Current original-scope audit:006 item1 immutable ticket/artifact/policy/reviewer/
expiry remains open;2 private command/bash references bind locally, parent main/
host launcher/complete lineage open;3 native command/bash entry added to guarded
project effects, other native/direct project/provider effects remain open;4
authorized/unauthorized controls and real entitlement open;5 journal retains
park/cancel, full cold restart/drain/recovery open;6 once-only private consumption
covered synthetically, real resolver/artifact/policy freshness open;7 late public
message delivery/native append/text selection guarded, async interactive render/
buffered sink/global state races open;8 no new decision API/human-strength claim,
full provenance/isolation open;9 client-neutral reviewer/evidence/retention and
cross-host acceptance open.012 A/1 user-dirty Rust gate remains unvalidated;
2 hosts still observe, never decide;C/3 main/observer deferred-clear/controller/
readiness integration open;B/4 native park/re-admit strengthened, not all effects;
D local gateway trusted/unprivileged release/restart/host canary not run.
Spec111 real resolver/dialog/native combined journey and116 cross-host/native/
soak/promotion remain unproved. No live workflow state has been queried.
Next integration input: remaining direct project filesystem/spawn/configuration/
provider/telemetry and async native output/state mutations, then descriptor-first
parent main/observer/host adapter with deferred mirror/controller/readiness and
owned child (no stock fallback), full authorized/new-input/cold-restart/host
acceptance using preserved gateway work. Goal active, not blocked or complete.

## Slice 11 entry: project exec and bridge effect ownership

Base627d7b0, canonical Statewright main; previous turn is verified progress.
Current status retains the same seven user-modified tracked paths and untracked
plans/canaries; Auldwyrm remains untouched. No supervising Statewright query,
load/use/workflow, real decision/inference, existing native sessions, install,
push or deploy. Manual root implementation; one mandatory clean-context
Astra/high read-only adversarial review. Existing manual source/evidence/Git
control profile retained, root owns controls; no release/compliance claim.

Current code exposes project pi.exec without request correlation and sends
project MCP/adapter bodies without the private outer request_reference expected
by the already-owned parent bridge. Scope: Pi project-effect context module,
request operations/gate/frontend, project index transports, focused SDK/bridge
fixtures, ADR008 and this receipt. Acceptance: current project exec succeeds;
outside/stale/closed calls never invoke it; a parked effect waits outside
inference; replacement during an awaited effect suppresses its result/later
effect; bridge effects carry the immutable host reference outside tool arguments.
Legacy transports keep their explicit unmanaged behavior. Managed context never
falls back to direct gateway dispatch. Read-only bootstrap state observation is
separate from effect authority and cannot authorize a mutation. API message
effects are similarly checked; delayed project correctives must not borrow the
latest call. Native bare commands/final rendering, direct filesystem/spawn,
other project configuration/provider/telemetry boundaries remain explicit open
requirements, not silently covered by this cut. Parent production activation
and full original authorized/new-input/cold-restart/host journey remain the
single later integration acceptance gate; no full-goal completion here.

Observed-only budget:85 normal/120 contraction root tool calls;30-minute warning,
45-minute contraction; chunks target16KiB; final third reserved for validation,
review/repair/audit/local commit. Root provider counters/controller interruption
unavailable; no control-plane capability probe authorized. One root turn plus
one Astra/high reviewer decision pass10 calls/12minutes and <=2 focused checks;
finding-only recheck4 calls/5minutes, <=2 distinct repairs/finding. Two full
source exports normally, one justified regression export. Warning stops optional
discovery; contraction records verified progress and preserves full goal active.
No reset of cumulative accounting. Rollback is a scoped local revert, never
delete journal/native sessions or activate a legacy fallback.

Retained baseline: real SDK inherited pi.exec after replacement returned
task-owned-effect/code0 instead of denial (1 failed/34 filtered). Root integrated
project dispatch ownership/cancellation, scoped registration/hooks/tools/commands
and top-level bridge helpers; first focused70/70 passed. Expanded frontend
36 passed/2 failed: one fixture tried nonexistent mirror.service rather than
the public loadCheckpoint; the other proved inherited binding carried private
call scope but lost project-effect scope, so bridge traffic lacked its outer
reference. Root repaired the binding to carry both contexts, retaining the
real parent enforcement. Fresh frontend38/38 passed. Actual project pre/post
fixture then38 passed/1 failed: it emitted tools after Agent completion when
the native operation signal is aborted. Fixture now holds an actual inert SSE
Agent active, proves both current policy calls before replacement, and awaits
both owned Agent prompts/close; no admission assertion or deadline weakened.
Frontend39/39 passed. Captured-bridge followup73 passed/1 failed because test
configured env after construction and a patch mistakenly placed setup in the
exec case. Setup now precedes the correct fixture's construction. Focused75/75
passed: frontend40, legacy/owned admission23, CLI12. All failed runs terminal;
task-owned fixtures clean up their resources, no user session signalled.

Root source also denies stale cached-hold lazy abort and project callback entry,
corrective/permission effects; a stale timer may clear only its own handle.
Private denial cannot force cached final state in either FAIL fallback. Scoped
bridge traffic captures the endpoint/token, rejects redirects, owns Connection:
close and combines existing deadlines with private request cancellation. Fresh
native identity guards and an immutable cancellation signal belong to the
original request; neither reference nor authority comes from model arguments.
Bare SDK commands/rendering and direct filesystem/spawn remain unguarded gaps.

Original-scope audit, current source:006 items1 artifact/policy/reviewer/expiry
ticket enforcement open;2 project outer references now bound, but parent
main/host-adapter activation/full lineage open;3 exec/API-message/MCP/adapter
effect dispatch guarded, all other native/project/provider effects open;4 real
authorized/unauthorized reviewer controls/entitlement journey open;5 journal
retained through park, complete cold restart/legacy recovery/drain open;6 current
matching-ID consumption proof retained, real private artifact/policy/entitlement
resolver journey open;7 stale project dispatch/result/SDK error regressions now
covered, all final rendering/recording/global mutable callback races open;8 no
new decision API/human-strength claim, provenance/isolation acceptance open;9
shared reviewer/evidence/retention/host acceptance open, no mandatory website.
012 A/1 gateway changes still user-dirty/unvalidated;2 no host decisions added;
C/3 main/observer deferred-clear mirror/controller/readiness integration open;
B/4 owning park/re-admit strengthened, not all project effects;D local gateway
park/unprivileged deny/trusted release/restart/host canary not run. Spec111's
full authoritative resolver and isolated combined-native journey and116's
cross-host/native/soak/promotion obligations remain unproved. Full goal active.

Next exact integration work: guard direct project filesystem/spawn and captured
configuration/provider/telemetry callbacks, bare SDK commands and final-output
recording/rendering; then descriptor-first parent main/observer/host adapter
construct the deferred-clear mirror/controller/readiness and this owned child
without legacy fallback. Complete original authorized/new-input/cold-restart/
host acceptance with preserved gateway work. Only this receipt may differ from
the final frozen source export when validation/review reporting is appended.

### Slice 11 independent findings and repaired acceptance

First frozen tree37e5310e47556f3a998a90b4e2a4a882bd95983d, export
/tmp/statewright-project-effects.VDc46E: Node297/297, Pi195 passed/1 existing
opt-in live skip, native2/2, generated Claude parity/four mjs syntax exit0.
Source acceptance is superseded by the following repair, not silently green.
SDK0.73.0/install and dependency links unchanged. No workspace Rust/typecheck/
lint/build/clean-install/migration/headed TUI/real gateway/reviewer/provider/
staging or production gate claimed. Mock diagnostics are not external evidence.

Mandatory clean-context Astra/high /root/pi_project_effects_review used7
read-only shell calls/2 memory-only challenges, no writes/network/children/live
sessions/agents. Two confirmed P1 findings on actual extracted/transpiled source
callbacks: deleting env URL changed parent-private pre-tool deny into undefined/
allow while parent policyCalls stayed1; stale awaited post-tool rejection still
notified1 and lazy-aborted1 after ownership became false. These are actual
declared-boundary defects, not the deferred parent activation/native gaps.
Root repairs select pre/post/interrupt routing from immutable ownership mode,
and recheck ownership before post-tool failure notification/abort. Existing
actual SDK/Agent/project/local-bridge case now deletes URL/changes token while
active and proves four policy calls over the captured endpoint, then exercises
a delayed sixth pre/post call: the fixture deliberately ignores its transport
cancellation so the final result/error check must protect the actual newer SSE
Agent. No additional abort/notification, replacement stays streaming, stale
event denies and cannot add policy calls. Both Agent prompts/close are awaited.
Product transport cancellation/deadlines remain unchanged; no retry/fallback.

Root disconfirming SDK regression found a third error-classification defect:
current parked callback error retained readiness (1 failed/40 filtered). The
listener mistook non-active phase for obsolete identity. Gate now distinguishes
an actually different reference or superseded arrival, including the new-input
preflight gap; parked/current/disconnected/native-drift faults are not hidden as
obsolete. Genuine current parked error revokes readiness, cancels the pending
effect and preserves the journal; older callback errors cannot close newer
ownership. Fresh focused76/76: frontend41, admission23, CLI12. One distinct
repair per finding; bounded finding-only reviewer recheck4 calls/5minutes.
Only these repairs and source gates/recheck/audit/commit remain in this cut.

Final repaired tested tree14eba1068241f3f8e94811504cfc0cba59295ec8,
export /tmp/statewright-project-repaired.eZztH5. Fresh exact-export gates:
Node297/297 (zero failures/skips/cancellations), Pi196 passed/1 existing opt-in
live skip (6 files passed/1 skipped), native2/2, Claude generated parity and
project-effects/request-frontend/request-operations/request-gate syntax exit0.
Commands: npm test -- --reporter=dot; npm run test:native in plugins/pi;
node plugins/claude-code/scripts/sync-managed-client.mjs --check; node --check
on the four named mjs sources; unchanged17 executor Node suites plus Pi native
session-owner and Claude managed-client bundle. Focused76/76 is preserved.
All root validation handles are terminal; no restarted observation or widened
deadline. Dependency symlinks/install unchanged. Only this receipt differs
from the exact tested source for final reporting; owned staged diff check0.

Finding-only independent recheck used3/4 read-only calls and the original two
memory challenges. Actual pre-tool callback denies before and after URL deletion,
parent policyCalls2; superseded post-tool rejection now abort0/notify0. Both
original P1 findings closed. Source inspection found classification repair
consistent: same-reference parked errors actionable, changed references/explicit
supersession cover preflight, native identity failure does not hide an error.
No remaining finding within that recheck; SDK regressions inspected, not rerun
by reviewer. Root owns exact-export suites and full original-scope acceptance.

Manual accounting is approximately85 root tool calls including failed checks/
one failed patch verification and final recording, plus reviewer7+recheck3;
roughly15 minutes, below30-minute warning/45-minute contraction. No optional
discovery after source freeze. Two full exports used, one repair per finding,
no third export. Instruction/owned-diff reads sometimes exceeded16KiB target;
selected instructions were fully reread and changed regions inspected. No
provider token/output-byte/controller enforcement claim or cumulative reset.
Tracked user-dirty diff hashes unchanged:
Statewright55c81137fb1ab1c4ce10632d5ac5c62c46c050a3a766a38ab8b9b995512f0270;
Auldwyrm94f585de57d915f93623de690dca8ebad3ffec018fbdf85e24617da4510547aa.
Same untracked inventory preserved.
Narrow eight-path local commit only; full goal remains active, no live approval,
workflow, deployment or original-scope completion claim. Rollback/next exact
integration inputs above remain unchanged, with source audit confirming parent
main still lacks bound bridge/controller/readiness and host launcher uses stock
Pi extension rather than this owned entrypoint.

## Slice 10 entry: private admission before project hold-only hooks

Base5373ca7, canonical Statewright main, preserved user-dirty inventory unchanged.
Previous turn was verified progress. No Statewright query/load/use, workflow,
real approval/resolver/provider inference, deploy/push/install or existing native
session inspection/signals. User manual instruction overrides skill activation;
root implements serially with mandatory one clean-context Astra/high read-only
review. Root owns manual source/evidence/Git controls, not a live controller.

Current inspected sources show parent main lacks request/readiness construction
and its bridge lacks sessionOwner; those integration gaps remain full scope.
Discriminating blocker in the already-owned CLI: project input is registered
before private input, so its monotonic hold returns handled before the parent
can park/consume/re-admit. This cut integrates the private SDK input first and
allows only its trusted per-call ownership capability to replace the project
hold after private consumption of its exact held approval ID for that request.
Legacy unmanaged/hold-only behavior stays closed.
Fresh project admission reads/cleanup/abort must not act for superseded calls.

Owned files: Pi request-frontend.mjs, request-operations.mjs, request-main.mjs,
request-gate.mjs, approval-hold.mjs,
index.ts, focused
CLI/ownership admission fixtures, ADR008 and this receipt. Acceptance: actual
owned text/JSON/RPC subprocesses remain parked outside synthetic HTTP inference,
retain journal despite cleared projection alone, consume one authoritative fake
receipt/tombstone before one response, and cannot reset legacy hold with missing
or stale private ownership. No production parent activation or claim that every
project callback/native effect/final response is guarded. One later integration
gate remains full approval/new-input/cold-restart/host parity, including parent
main/observer wiring and preserved gateway work. Do not redefine full acceptance.

Observed-only envelope:70 normal/100 contraction tool calls, returned chunks
target16KiB,30-minute warning/45-minute contraction, protected final third for
validation/review/repair/audit/commit. Root provider counters/hard token or
controller enforcement unavailable; no control-plane probe permitted. Reviewer
10 calls/12minutes, <=2 focused challenges, finding recheck4 calls/5minutes;
at most2 distinct repairs/finding,2 full source exports normally+1 justified
regression export. Warning stops optional discovery; contraction finishes a
verified integration cut and keeps full goal active. Scoped local revert is
rollback, no journal/session deletion or fallback activation.

Retained Slice10 baseline: new actual text pending-approval fixture failed1,
epoch0 (9 filtered); private-first integration advanced to epoch1+durable
journal but CLI suite7 passed/3 failed because no second pending receipt read.
Diagnostic stages proved ready/begin received, request parked, status fetch
queued but no server request. No gateway or provider inference escaped; owned
children were terminated/awaited. Separate raw transport child probe with100ms
delay passed;500ms delay failed (3-second owned deadline). Paired500ms probe:
default server keepalive failed, only ready received; server Connection:close
passed. This isolates delayed pooled-connection reuse, not hook loading or
gate schema. Exact upstream fetch internals remain unproven; no Node-wide fix
or SDK provider behavior is claimed. Private IPC now requests Connection:close
on every action, owning the connection lifetime rather than relying on shared
SDK-process fetch pooling. No retry/deadline enlargement/authority fallback.
Both server policies remain regression cases; parent endpoint/token, redirect
rejection, cancellation/time/response-byte limits unchanged. Root owns this
transport decision; revisit only when a request-owned IPC dispatcher proves
the same delayed/subprocess/close limits without global-pool reliance.

Fresh admission-read supersession fixture initially timed out1 (combined55
passed): its barrier blocked constructor refresh, not prompt admission. Barrier
now arms only after construction; focused stale-read case passed1, retaining
zero-abort/notification/inference/authentication assertions. This is fixture
ordering repair, not a larger deadline or authorization change. Optional broad
discovery stopped after the discriminating connection-lifetime challenge;
remaining envelope is reserved for gates, review, repair and recording.

### Slice 10 independent finding and bounded matching-release repair

Mandatory clean-context Astra/high /root/pi_admission_integration_review used
9 read-only calls and2 memory-only challenges on e71e6d52. It confirmed P1:
unconditionally replacing project approvalHold for ownsCurrent allowed inherited
extension input under the same epoch to discard a project-only pending hold
after projection clearance. Real exported index+operations+gate, synthetic
parent active replies: first handled, second continue; actions begin,status;
same reference, no consume/new begin. No provider/gateway/files/live sessions
or real authority involved. This is a genuine admission defect, not a broader
parent-activation limitation or a successful release. Source/evidence retained.

Repair binds reset to the exact held approval ID consumed by the private gate
for this current call/reference. Hold exposes its first valid ID read-only;
ready status must supply an ID; only checked ready->consume->active records it
in the gate's ephemeral per-request set. The immutable ownership capability
queries that proof only in an owned call. Old/new/closed/outside scopes, missing
proof and foreign ticket cannot borrow durable historic tombstones. Continued
ownership/new projection alone is insufficient; malformed/read-failure holds
have no consumable ID and still require explicit recovery. No model argument
or hold-helper release API added. Scope expands only gate/hold proof binding,
not main/observer activation. Negative project projection-only case remains
handled even when ownership returns true; foreign consume cannot reset; matching
proof can. Actual SDK proof is true only after its parent consumed the ticket,
false outside its call and after replacement/close. Recheck is finding-only
4 calls/5minutes, no full-suite duplication. At most one repair so far.

Finding-only recheck completed on repaired tree6c71c82 with2/4 read-only calls.
The original real exported index+operations+gate reproduction now returns
first handled/second handled, actions begin,status, same reference and no
consume. Independent synthetic challenges also observed wrong approval ID
consumed remains held; matching ID consumed continues; new reference with
historic consumed ID remains held/proof false; stale inherited callback is
suppressed. The reported P1 is closed after one distinct repair. No writes or
live access by reviewer; no claim that parent activation, all project effects,
final rendering or restart have been reviewed/validated by this recheck.

Normal70-call envelope was exceeded during discriminating transport diagnosis
and review reconciliation. Contraction100 is approached; reserve-only exception
allows10 further root calls for final source gates/recheck/audit/local commit,
not optional discovery or implementation breadth. Counters are not reset; root
limits remain observed-only, no provider/controller enforcement claimed.

### Slice 10 isolated gates and current original-scope audit

Initial tested tree e71e6d52f30aaf87324f6cd811bb76602377fb48, source export
/tmp/statewright-admission-reviewed.9wqIrn. Fresh focused3 files68/68: CLI12,
legacy/owned admission22, public SDK frontend34. Fresh wider Node297/297,
zero failures/skips/cancellations; Pi188 passed/1 existing opt-in live skip
(6 files passed/1 skipped); native2/2; generated Claude parity and syntax
for request-frontend/request-operations/request-main exit0; staged diff check0.
SDK0.73.0/dependency installation unchanged and symlinked into the export.
No package install, whole-workspace Rust/typecheck/lint/build/clean-install,
migration, headed TUI, real gateway/reviewer/provider or staging/production
gate claimed. Mocked index gateway diagnostics are not external verification.
Commands: npm test -- --reporter=dot; npm run test:native in plugins/pi;
node plugins/claude-code/scripts/sync-managed-client.mjs --check; node --check
plugins/pi/src/{request-frontend,request-operations,request-main}.mjs; Node
integration command is the unchanged Slice9 17-suite executor set plus Pi
session-owner and Claude managed-client bundle. Full source acceptance still
requires the original integration journey, not these gates alone.

Final repaired tested tree6c71c82aa602e43d644c3f5f050b08ac388efcc1, isolated
source export /tmp/statewright-admission-repaired.nRD36F supersedes e71e6d52
for product acceptance. Fresh focused3 files69/69: CLI12, legacy/owned
admission23, public SDK frontend34. Fresh full exported gates: Node297/297,
zero failures/skips/cancellations; Pi189 passed/1 existing opt-in live skip
(6 files passed/1 skipped); native2/2; Claude generated parity plus syntax
for request-frontend/request-operations/request-main/request-gate/approval-hold
exit0. Same dependency symlinks, no reinstall or widened gate claims. Every
root validation handle terminated successfully; task-owned fixtures clean up
their children/HTTP servers/native temporary resources. Staged owned diff
check0. Source is frozen; only this receipt changes after export for final
reporting. Final gates/recheck/audit/commit use the explicit100+10 reserve-only
exception; optional discovery and implementation breadth remain stopped.
Root counters/envelopes are manual observations, not provider-enforced limits.

| Original006 requirement | Current evidence | Still required before completion |
| --- | --- | --- |
| 1 immutable ticket tenant/client/gateway/run/edge/artifact/policy/reviewer/expiry | Exact journal/run/session/edge and strict native launch checks retained | Complete artifact-digest/policy/expiry/reviewer ticket enforcement and journey |
| 2 host-owned native thread/lineage/request ID/epoch | Real SDK subprocess binds exact file/UUID and fresh lifetime challenge; opaque per-call capability denies outside/stale/closed borrowing | Parent main/host adapter wiring, authoritative replacements and complete cross-process lineage; no kernel-peer claim |
| 3 pending has no declared effects/inference; wait outside model | Text/JSON/RPC pending children park before provider; cleared projection alone keeps journal and HTTP0, consumed fake receipt permits HTTP1 | All project/native exec/commands/effects and later provider retry/summary/compaction boundaries; whole park journey |
| 4 query authority before controls; unauthorized dismiss only | Existing shared entitlement tests retained; no resolver/UI introduced | Real authorized/unauthorized reviewer flow and required-reviewer projection |
| 5 cancel/dismiss/disconnect leaves journal; cold gate reconciles | Journal/controller/native-readiness tests retained; SDK child teardown observed; project admission stale read cannot abort/notify newer input | Full native cold restart/crash-lock/legacy recovery and parent inflight cancellation/drain/broken SDK cleanup |
| 6 fresh private authorization/artifact/policy; consume once | Actual owned CLI observes one durable tombstone and one journal clear before one synthetic response; project hold replacement additionally requires this current request's matching private consumption proof; transport has no resolve action | Real entitlement/artifact/policy resolver recheck and authorized once-consumed continuation |
| 7 newer input invalidates old continuation/final response | Current/stale/outside/closed capability checks, admission read pre/post guards, zero stale abort/notification regression | Every project callback/retry, native stale rendering/recording and complete cross-process newer-input races |
| 8 decision source/authentication strength | Fake receipt/local bearer/launch challenge explicitly not human proof or hostile-agent isolation | Complete recorded decision provenance/authentication-strength semantics and isolation acceptance |
| 9 shared reviewer/evidence/retention without mandatory website | Shared parent protocol retained; no new website requirement | Complete shared reviewer/evidence/retention and cross-client/host acceptance |

P1 012: A/1 preserved gateway Rust pending-pre-tool denial remains user-dirty,
uncommitted and unvalidated here; plan2 no host decision API added, real private
reviewer credential/entitlement journey open; C/3 durability exists but main's
bridge does not yet receive sessionOwner and main/observer do not construct
deferred-clear mirror+requestController+readiness; B/4 actual owning CLI now
integrates private-first park/re-admit with the fixed project module, while
legacy hold-only behavior remains monotonic and project holds require matching
consumption proof, not projection clearance; all native/project effects must
still be guarded before parent activation. D local gateway/native canary park,
unprivileged deny, trusted release, restart and host parity is not run. Spec114
proposed obligations are not accepted from these fixture results. Full goal is
active; no Statewright query/load/use or real decisions/inference authorized.

Next exact cut: project gateway/adapter/exec/message effects and correctives/
retry/timer callbacks capture the immutable private call and recheck around
waits; forward its outer reference to request-owned bridge dispatch, not model
arguments/current cache. Guard bare SDK command/final-output boundaries, then
wire descriptor-first parent main/observer/host adapter to this entrypoint,
deferred-clear mirror/controller/readiness and newly bound owned child without
legacy adoption. Prove full authorized/new-input/cold-restart/host acceptance
including preserved gateway work. Source/gates/review must precede local commit;
only this receipt may differ from the tested source tree for final reporting.

## Slice 9 entry: owning public-SDK modes and managed CLI

Base `6a08434`, canonical Statewright main; preserved dirty inventory unchanged.
Previous turn is verified progress (committed handshake, retained red and review
repair). User no-workflow instruction overrides skill activation: no supervising
Statewright calls/load/run, no real workflow/decision/inference/deploy/install or
existing native sessions. Root implements serially; one mandatory clean-context
Astra/high read-only review. Portable manual evidence controls remain root-owned.

Owned scope: additive Pi managed mode/CLI entrypoints, focused task-owned CLI/
SDK tests, explicit TypeScript loader dependency metadata if needed, ADR008 and
this receipt. Require exact private launch challenge and existing descriptor,
bounded loopback request transport, sealed owned SDK construction and private
acknowledgement before any prompt; dispatch public text/json/RPC/interactive
modes, never stock main, arbitrary extensions or automatic native adoption.
Reject conflicting/unknown launch arguments/configuration before native mutation.
Task-owned inert HTTP/SSE/native files and synthetic authority only. Shipped
launcher/main/index remain unactivated; project async effects and final output,
later provider boundaries/full cold restart/authority/host journeys remain in
the original goal, not excluded from final acceptance by this slice.

Observed-only envelope:60 normal/95 contraction tool calls, bounded result
chunks (target16KiB),30-minute warning/45-minute contraction; protected final
third for source gates/review/repair/handoff. One reviewer10 calls/12minutes,
at most two distinct repairs/finding, two isolated full exports normally plus
one justified regression export. No controller/provider-token enforcement.
At warning stop optional discovery; contraction finishes a coherent verified
milestone and leaves the full goal active. Exact later integration gate remains
the complete authorized native approval/new-input/restart/host-parity journey.
Rollback is a scoped local revert, preserving journals/session records; no
production launcher fallback or deployment is authorized by this prerequisite.

Slice9 characterized baseline: HEAD has no plugins/pi/request-main.mjs (git
cat-file -e fails explicitly); installed SDK main MainOptions accepts only
extensionFactories, while public modes accept AgentSessionRuntime. No stock
CLI was executed or native config weakened. Initial new fixture suite3 passed/
2 failed at8-second child deadlines; fixture environment was tightened to
synthetic API key, local endpoints and actual telemetry-off controls, fresh
suite again3 passed/2 failed. Diagnostic fixed-module import307ms disproved a
loader delay. Discriminating text challenge then observed epoch1, HTTP1,
synthetic final stdout and received private acknowledgement, but child remained
alive. Source index had a60-second owned inactivity timer and no shutdown hook.
Root added monotonic shutdown/disarm; same actual text child passed in687ms.
Fresh text/JSON suite5/5. No deadline enlarged, no force-exit/unref fallback.
Failed runs retain their synthetic authority classification; neither is a
real approval or successful full pause/resume proof. Timed-out children were
task-owned and terminated/awaited by fixtures; no user session signalled.
Root source scope includes the necessary index timer-shutdown repair, not its
pending/retry/effect activation. New modes/CLI require their own strict config;
SDK0.73.0 and upstream jiti loader are primary installed source, unchanged.

The first staged export b45a7f9529066e645dc63fba7f45a261fe083555,
/tmp/statewright-cli-reviewed.qkSv0F, was superseded before review/full gates:
RPC fixture ended stdin after native prompt ACK (preflight success), obtaining
exit0 but no terminal synthetic response. Result5 passed/1 failed; not accepted
as completed inference. SDK rpc-mode.js:prompt confirms ACK is preflight, not
agent completion. Fixture now awaits agent_end before EOF, retaining strict
HTTP1/epoch1/response/output/native-file assertions. This is a fixture lifecycle
repair, not a weaker RPC criterion. Final source/gates/review recorded below.

First full isolated gates on35f57caf6dd3f5bb9f358479b4566488e435c753,
/tmp/statewright-cli-verified.HfAVHm: Node297/297,native2/2,parity/four syntax0;
Pi178 passed/1 failed/1 opt-in skip. Failure was original index.spec's exact
8-hook registration count after adding the required ninth session_shutdown
hook. Fixture assertion now expects9 and explicitly verifies session_shutdown,
retaining all prior hook/tool assertions. No product or approval policy relaxed.
This justified third export is only stale fixture/evidence reconciliation;
source review remains on the same product implementation. Final fresh gates
must pass before any commit. Every original requirement remains controlling.

Third export eab1755063fa9fa030e3fdf94b6507612d9bd09d,
/tmp/statewright-cli-final.RfhPl7, passed Node297/297, Pi179/1 existing opt-in
live skip, native2/2, parity/four syntax0. Independent Astra/high review then
confirmed a medium strict-schema defect: RegExp.test coerced singleton UUID
arrays into strings for readiness IDs. Parent comparison still rejects them;
no authorization bypass or actual malformed-launch durable mutation was
demonstrated. SDK setup has append calls before handshake, so early strict
rejection matters. Root also identified fixed registration reading process.env
while an injected alternate env could configure its private transport
differently. Added regression tests first:2 failed/5 filtered skips. Repair
requires strings for all four UUIDs and the actual process environment for
fixed registration; caller-injected trusted registration remains explicit.
This is one bounded schema repair plus adjacent environment-consistency guard,
not new production activation. A fourth exact source export is justified by the
confirmed review finding; optional discovery stopped and final reserve is used
for fresh gates, one finding-only recheck (4 calls/5 minutes), audit and commit.
All superseded exports and failures remain recorded, never accepted as final.

### Slice 9 final isolated gates, review and full-scope audit

Final tested tree a3362a3a9d251a6f09bb3f9f0bb1f9e1df9d78ac, source export
/tmp/statewright-cli-repaired.MASbbE: Node297 passed, zero failed/skipped/
cancelled; Pi180 passed/1 existing opt-in live-canary skip (6 files passed/
1 skipped); native2/2; generated Claude parity and four CLI/module/mode/
publisher syntax checks exit0. Focused managed CLI7/7 includes actual owned
text/JSON/RPC subprocesses. Gate commands: the Slice8 explicit Node integration
set (17 executor suites plus Pi session-owner and Claude managed-client bundle),
npm test -- --reporter=dot and npm run test:native in plugins/pi, and node
plugins/claude-code/scripts/sync-managed-client.mjs --check plus node --check
for plugins/pi/request-main.mjs and src/{request-main,request-mode,
request-readiness}.mjs. Existing SDK0.73.0/dependencies were linked unchanged
into the export; no dependency install or whole-workspace Rust/typecheck/lint/
build/clean-install/migration/headed-TUI/staging/production validation claimed.
Final committed source must match this tree except receipt-only reporting.

Clean-context mandatory Astra/high /root/pi_managed_cli_review used8 read-only
calls and two focused challenges in its first pass; reviewed all11 scoped paths
and relevant imported ownership/SDK code. Confirmed the one medium UUID-coercion
finding above, no other scoped defect. Transport challenges rejected unknown
action,65537-byte response and stalled response at100ms. It independently notes
SDK RPC explicitly exits0 after disposal: natural event-loop exit is evidenced
only by print modes, not RPC. Finding-only recheck used2 calls on the final tree;
valid config accepted and all16 malformed ID/value combinations rejected;
alternate env rejected before configuration access/SDK setup, explicit trusted
registration still reached ordinary validation. No outstanding scoped defect
found, not a full approval/restart acceptance verdict. Reviewer made no edits,
full-suite reruns, live/native inspection or external endpoint calls.

Full original006 nine-row contract and012 numbered P1 acceptance remain the
objective. This current-state audit carries every row, not just the new CLI:

| Original requirement | Current evidence | Still required before full acceptance |
| --- | --- | --- |
| 1 immutable tenant/client/gateway/run/edge/artifact/policy/reviewer/expiry | Durable exact run/session/edge journal checks retained; CLI configuration strictly typed | Complete ticket artifact-digest/policy/expiry/reviewer enforcement and journey |
| 2 host-owned native thread/lineage/request ID/epoch | Actual SDK text/JSON/RPC child binds exact native file/UUID and fresh parent/child/executor challenge; one owned epoch and private acknowledgement | Parent main/host adapter activation, authorized replacements and full cross-process lineage; no kernel-peer attestation claim |
| 3 pending has no declared effects or inference; parked outside model | Existing journal/hold/controller/SDK boundary fixtures retained; new CLI awaits private readiness before prompt | All project/native commands and exec effects, later provider retry/summary/compaction boundaries and full park proof; current hold-only project hooks do not re-admit approval |
| 4 authority before controls; unauthorized dismiss only | Shared entitlement fixtures retained; CLI adds no reviewer/decision UI | Real authorized/unauthorized reviewer flow and required-reviewer projection |
| 5 cancel/dismiss/disconnect retains journal; cold resume starts gated | Durable journal/controller fixtures retained; actual owned child exits revoke readiness; shutdown disarms its owned timer without forced print exit | Full native cold restart, crash-lock/legacy recovery, parent inflight cancellation/drain and permanently broken SDK cleanup |
| 6 private fresh entitlement/artifact/policy recheck; consume once | Approval consume/tombstone tests retained; CLI transport has no resolve action; readiness remains distinct from approval | Real resolver recheck and authorized once-consumed native continuation |
| 7 new input invalidates old continuation and final output | Private input claims/callback guards retained; RPC fixture now waits for actual terminal response rather than ACK | Reject stale native rendering/recording, all project asynchronous callbacks/retries and cross-process newer-input races; terminal fixture is not stale-output proof |
| 8 decision source and authentication strength | Synthetic authority, local bearer and launch challenge explicitly not human proof or hostile-agent isolation | Complete recorded decision provenance/authentication-strength semantics and isolation acceptance |
| 9 shared client-neutral reviewer/evidence/retention | Parent protocol remains client-neutral, no mandatory website imposed | Complete shared reviewer/evidence/retention and authorized cross-client/host acceptance |

P1 012 A/1: pending-pre-tool gateway Rust changes remain user-dirty, uncommitted
and not validated here. Plan2: no host decision API introduced; real authenticated
private reviewer credentials/entitlement journey remains unverified. C/3: journal
durability exists, but executor main/observer deferred-clear mirror, request
controller and readiness construction remain inactive. B/4: owning public-SDK
CLI now exists and is subprocess-tested; project pending hold still blocks
authorized re-admit, and every native/project effect must be guarded before
activation. D: local gateway/native approval canary covering park, unprivileged
deny, trusted re-admit, restart and host parity remains unrun; no real workflow,
approval/resolver or provider inference under this manual authority. Spec114
proposed enterprise obligations are not accepted merely from local fixtures.

Next integration cut is parent main/host adapter wiring to this owned entrypoint
with descriptor-first construction, deferred-clear mirror, requestController,
native-readiness challenge and bound owned child; never adopt legacy readiness.
Do not enable that path before exact private ownership is captured by project
effects/correctives/retries, pending approval can safely readmit only the exact
once-consumed request, and native bare effects/final responses are guarded.
Then prove full authorized approval/new-input/cold-restart/host-parity journey,
including the preserved gateway work, rather than counting more prerequisites
as full acceptance. Synthetic main/observer fixtures remain authorized; live
authority is not inferred. Local commit/revert only; no deploy/install/push,
Statewright query/load/use, user-session signalling or user-dirty staging.
Full goal stays active; no release, production readiness or compliance claim.

## Slice 8 entry: private parent/native readiness negotiation

Base `607bdc8`; canonical Statewright main, same preserved dirty inventory as
Slice 7. Root implements serially; no supervising workflow or implementation
delegation. Mandatory clean-context Astra/high read-only review is a separate
bounded decision pass. No production CLI/index/main activation in this cut.

Owned scope: additive executor native-readiness module and its fixture suite;
AdapterBridge readiness binding; additive Pi readiness publisher, actual public
SDK frontend handshake fixtures; ADR008 and this receipt. Acceptance: exact
existing native UUID/file, executor ID and newly minted parent/child lifetime
challenge; bound owned child required; acknowledgement once only; old/replayed/
malformed/foreign receipts denied; startup/close/child-exit overlap cannot admit
requests or declared bridge effects. Legacy adapter identity is not native
readiness. Actual SDK startup must await private acknowledgement before gate
enable. Synthetic authority/task-owned HTTP/child/native files only.

Observed-only envelope: 60 normal/95 contraction tool calls, 16 KiB returned
output per call, 30-minute warning/45-minute contraction; final third reserved
for review/repair/source validation and handoff. One independent reviewer,
10 read-only calls/12 minutes, at most two distinct repairs per finding, two
isolated full exports normally plus one regression repair export. Limits are
root-observed, not provider-token/runtime-enforced. At warning stop optional
discovery; at contraction finish a coherent verified prerequisite and retain
the full goal active. No budget changes to a Statewright controller.

Full original nine-row/P1 acceptance is unchanged. This cut excludes owning
CLI/modes, executor main/observer activation, project effects/final output,
later provider transport leases, real reviewer resolution, host canaries,
deploy/push and existing live/native sessions. Rollback: scoped local revert;
ephemeral readiness cannot alter or migrate durable journals/session schemas.
Later integration gate remains the original authorized native approval/
restart/new-input/host-parity journey, not this readiness prerequisite alone.

Slice 8 scope expansion before validation: frontend/gate capture the SDK's
original native file as well as UUID. Private handshake-only checks would
otherwise permit UUID-preserving file drift after acknowledgement; this is the
same exact-descriptor requirement, not activation or identity adoption.

Retained evidence: initial one-test baseline failed (HTTP200 vs expected502)
on previous bridge. First combined run passed18, failed1 cleanup hook and was
interrupted after32.8s with one cancellation: fixture released owner before
readiness controller cancellation, leaving server open. Correction puts bridge
close before owner release and makes HTTP shutdown a finally block even when
cancellation fails; fresh focused bridge suites19/19. This was fixture ordering
plus real cleanup robustness, not a permission fallback. Actual SDK frontend
initial handshake fixtures30/30. Expanded file checks then passed32/33: one
assertion expected publisher mismatch while the frontend correctly rejected
earlier. Expectation was updated to the earlier unavailable boundary with all
zero-epoch/zero-HTTP assertions retained. Fresh parent suite14/14 includes final
admission microtask close, telemetry-overlap refusal and cancellation-error HTTP
shutdown. No interrupted command remains running. Pi focused final result and
exact isolated source/review/wider gates will be recorded below.

### Slice 8 isolated source and original-scope audit

Tested tree `754a7e66865566ff1aa6222cfed9f771bc462f57`, clean source export
`/tmp/statewright-ready-reviewed.Wwx3Xg`. Node wider integration295/295,
zero failures/skips/cancellations; Pi173 passed/1 existing opt-in live-canary
skip (5 files passed/1 skipped); native-file suite2/2; generated Claude parity
and syntax checks for bridge/parent readiness/Pi publisher/frontend/gate all
exit0; staged diff check0. Focused parent14/14, actual SDK frontend33/33.
Node gate is the Slice7 explicit command plus executor-native-readiness.test.mjs;
Pi gates are npm test -- --reporter=dot and npm run test:native in its package;
parity is node plugins/claude-code/scripts/sync-managed-client.mjs --check.
SDK0.73.0/dependency source remains the existing installation, unchanged; export
contains only the scoped staged tree, not user-dirty Rust/canary/runtime files.
Temporary exports are validation fixtures, not the durable research destination.

No whole-workspace Rust/typecheck/lint/build, migration, headed interactive/RPC
CLI or staging/production gates run. No real workflow query/load/approval/
resolution/provider inference, installed-runtime edit, or existing session
inspection/signalling. Actual Node child test proves owned exit observation;
actual SDK frontend tests use a fake lifecycle handle in the same process, not
cross-process native CLI launch. Local inert SSE is HTTP boundary evidence,
not a real model or reviewer approval journey. Mocked Pi index clients can print
gateway URLs; those diagnostics are not external gateway verification.

The original 006 nine-row contract and 012 numbered plan were reread, not
redefined around this handshake. Current requirement-by-requirement audit:

| Original requirement | Current evidence | Still required |
| --- | --- | --- |
| 1 immutable ticket/scope/artifact/policy/reviewer/expiry | Exact durable run/session/edge journal checks retained; handshake adds no ticket fields | Full tenant/client/artifact digest/policy/expiry/reviewer enforcement and acceptance |
| 2 native thread/lineage/request ID/epoch | Exact UUID/file, fresh parent/child launch challenges, same owner/controller and explicitly bound child; private request epochs retained | Real owning CLI/parent IPC wiring and authorized replacement/full cross-process lineage; no kernel peer attestation claim |
| 3 pending has no declared effects/inference; wait outside model | Configured bridge holds before acknowledgement; SDK startup holds; local revocation checked at dispatch and after awaits; existing parked fixtures retained | Every project command/exec/native effect, later provider transport/retry/summary boundaries and full live park proof |
| 4 authority before controls; unauthorized dismiss only | Existing shared reviewer entitlement fixtures retained; no UI or resolver added | Real unauthorized/authorized reviewer journey and required-reviewer projection |
| 5 cancel/dismiss/disconnect keeps journal and cold gate | Durable journal/controller fixtures retained; child exit/close cancels request; fresh lifetime challenge after explicit same-native reopen | Full native cold restart/crash-lock/legacy recovery and parent inflight cancellation/drain, permanently broken SDK cleanup |
| 6 private fresh authorization/artifact/policy; consume once | No resolve route; strict once-only readiness is separate from approval; original approval consume/tombstones retained | Real resolver entitlement/artifact/policy recheck and authorized consumed native continuation |
| 7 new input invalidates old continuation/final output | Existing private input claims and callback guards retained; UUID-preserving file drift revokes frontend monotonically | Native rendering/recording of every stale final response, full project callback/retry and cross-process new-input races |
| 8 decision source/authentication strength | Local bearer/challenge explicitly not human proof or malicious-agent isolation; no stronger provenance claim | Full recorded decision-source/authentication-strength semantics and isolation acceptance |
| 9 shared reviewer/evidence/retention | Additive client-neutral parent readiness and existing gate semantics retained; no website UX imposed | Complete shared reviewer/evidence/retention implementation and cross-client/host acceptance |

P1 012: A/1 user-dirty Rust pending pre-tool denial remains uncommitted/not
validated by this cut; 2 no host decision API added, real credential/entitlement
path still untested; C/3 journal durability exists but main requestController/
deferred-clear/close/readiness construction is not activated; B/4 actual SDK
prerequisites gain the private handshake but shipped launcher/index stay ADR007
hold-only; D approval/restart/unprivileged/trusted re-admit native/host-parity
canary not run under the no-workflow authority. None is accepted merely from
this prerequisite passing. Spec114 proposed enterprise obligations remain open.

Next exact integration inputs: own a public-SDK mode/CLI entrypoint (stock main
cannot inject the guarded runtime); parent main creates deferred-clear mirror,
request controller and native-readiness mode, binds its newly owned child and
forwards its own challenge over private launch configuration, never adopts old
readiness; project effects/timers/correctives/retries capture private ownership;
finish final-response/later-inference/restart/new-input/authority/host acceptance.
Activation must require the private handshake, not a legacy identity fallback.
Full goal remains active; no production readiness/release/compliance claim.

### Slice 8 independent finding and repair

Mandatory clean-context Astra/high `/root/pi_private_readiness_review` inspected
the ten-path exact staged diff/export and narrowly read imported controller;
seven read-only calls, one synthetic no-file/no-HTTP challenge, no edits or
full-suite duplication. P2 at bridge waitForReady: final await could return true
after close had revoked readiness. Reviewer queued three nested microtasks from
owner.assertOwner; observed waitForReady:true, actualReady:false, closeCalls:1.
This proves false startup success, not unauthorized effects; dispatch guards
still held. No other concrete blocking finding in its bounded pass. Wider
results were root-reported, not independently rerun.

Root preserved two discriminating reds, each1 failed: minimal final-await
revocation and actual readiness module with the reviewer's three-microtask
schedule plus real fixture owner checks. One-line repair synchronously returns
the current readiness after assertReady rather than unconditional true. Fresh
parent focused16/16. No earlier failed evidence deleted or tests skipped.
Repaired-source isolated gates and bounded finding-only re-review follow.
SDK public session-manager.js provenance:0.73.0, SHA256
`99f172e1d93ade315be3b5ed1cdb5b578ae83f6d9bc73817be845b00bdb2cf8b`.
Publisher currently accepts POSIX absolute native paths; Windows behavior is
not validated or advertised by this local prerequisite.

### Slice 8 final evidence and handoff

Final tested staged tree `3b75ed609891bd43b3b5d008eb12747319da5869`, isolated
export `/tmp/statewright-ready-verified.3W2OKj`: Node297/297, no failures/skips/
cancellations; Pi173 passed/1 existing opt-in canary skip; native2/2; generated
Claude parity plus five owned-module syntax checks exit0; staged diff check0.
Only source delta from initially reviewed/tested tree is the one-line startup
repair and two regression tests. The mandatory reviewer finding-only recheck
used two read-only calls in this exact export: both waitForReady regressions
passed, zero failures/skips/cancellations, exit0; P2 closed. It did not rerun
wider suites or certify production. No other implementation agent, no edits
by reviewer and no running validation/child fixture left behind.

Original-scope audit above remains current after this repair: startup result
no longer reports success after locally observed final-microtask close. It
does not close production CLI/main/observer/index activation, pending stop's
private request correlation, all async callback/final-response/new-input
boundaries, later provider transport leases, authorized reviewer journey,
full cold native restart/crash recovery or cross-client/host acceptance.
Unconfigured production continues ADR007 hold. Owner/path/lifetime challenges
are not cryptographic measurement or human authority. Original full goal is
active, not complete or blocked.

Manual portable-control owner is root; operating evidence is local source,
exact exports, retained reds, scoped independent review and this durable receipt.
No deployment/migration/install/rollback action taken. Rollback is the coherent
local additive-prerequisite commit revert with all journals/ownership records
preserved. Observed-only envelope used two isolated exports and one focused
finding repair/recheck; protected reserve served validation/review/handoff.
Provider-token/runtime/controller enforcement remains unavailable, not implied.
Final recording is receipt-only delta from tested/reviewed source; local commit
identity and post-commit preservation are verified in the handoff.

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

## Slice 6: immutable private SDK call-context ownership

Previous turn is verified progress: local `1f346d283df71125609d332a2f4498dbfde086a1`;
current status confirms it and the same unrelated dirty inventory. Goal stays
active, full original scope retained. User manual/no-workflow authority overrides
skill workflow guidance; no Statewright tool or live session is queried.

Accepted original contracts remain 006 required approval/request ownership and
012 P1 numbered host-unprivileged/journal/restart/effect hold contract. Current
SDK 0.73.0 prompt source shows input before expansion and pre-start await; text
is not immutable operation identity. Use a private AsyncLocalStorage call-context
carrier at owned SDK session entry instead of injecting tokens into text,
adopting a current cache, or patching installed SDK sources. Native operation
callbacks/automatic retry/compaction must retain the captured parent reference.
Explicit interactive/RPC input may begin a new epoch; extension-source follow-ups
must inherit a captured reference or be held. Replacement clears owned queues
and old pre-start/retry calls must never start a new agent over replacement work.

Owned scope: additive Pi request operation carrier, existing gate/hooks only
for private binding/lifecycle contract, actual-agent fixture and ADR 008/receipt.
No executor/index activation, provider auth/real inference/workflow/resolver,
installed runtime or user dirty artifacts. Characterize template expansion,
same-text overlapping pre-start calls and unbound extension input first; then
actual automatic compaction/inherited follow-up and replacement queue races.
Full remaining main/observer/index/effect/native/restart/host parity acceptance
is unchanged. No claim completion from a carrier alone.

Provisional observed-only envelope: one serial root implementation and one final
clean-context Astra/high read-only review; 50 normal/80 worst tool calls,
<=16KiB later tool results, 30-minute discovery warning/45-minute contraction,
one package integration export plus one repair re-export if required, at most
two distinct repair attempts per finding. Protect final third for validation,
review, durable record and local commit. Stop optional discovery at warning;
hand off exact missing original requirements, never activate weaker semantics.
No workflow/cumulative quota/model-token/interrupt enforcement is claimed.

Characterized red baseline: actual-agent fixture 19 passed/3 failed. Template
expansion dispatched zero HTTP instead of one (missing correlation evidence);
overlapping identical-text pre-start prompt dispatched two instead of only the
replacement's one (real obsolete-operation borrowing); unbound extension input
minted epoch 1 and dispatched one instead of epoch 0/zero (source classification
gap). All use public SDK with inert loopback responses, not native user sessions.

Carrier implementation: private AsyncLocalStorage scope at owned public SDK
prompt entry, immutable once-only reference bound by the gate's synchronous
onAdmit callback. Explicit input invalidates before SDK commands/preflight and
clears owned SDK queues; inherited extension input checkpoints its captured
reference without begin. Agent prompt/continue wrappers recheck after pre-start
awaits before actual Agent start; real primary provider/tool/compaction hooks
consume the originating scope. Raw prompt text contains no private marker/token.
Next-turn custom asides stay in a bounded private reference-owned queue, not
SDK's shared unowned pending queue. Close retains installed guards and aborts
only the exact-owned SDK session, so late timers cannot begin new work.

First carrier gate: 47 passed/3 failed (50). All three original red defects
closed. New pre-Agent checkpoint correctly parked earlier than old tests expected;
two old provider-cancellation tests therefore lacked a started Agent signal.
Move their pending injection into actual before_provider_request to preserve
the deeper HTTP/signal proof, not weaken the assertions. Likewise the async
helper identity-drift challenge must inject only at the streaming checkpoint
to continue testing actual denied-payload handling; pre-start identity denial
is an additional earlier guard, not an error-output requirement. No failure
reclassified as pass; fresh inherited queue/automatic-compaction gates follow.

Next focused gate: 54 passed/1 failed (55). Actual automatic threshold
compaction parked, consumed and completed, but SDK split-turn compaction produced
both conversation summary and turn-prefix summary while fixture expected a
single exact summary. Primary installed compaction.js confirms Promise.all of
both calls and combined turn-context section. Correct the exact content and
HTTP count expectations to that real SDK behavior (three total HTTP requests:
original model response plus two inert compaction responses), not suppress the
native result. All initial defects/inherited follow-ups/queue replacements and
the original deeper provider cancellation assertions passed this gate.

Root additionally identified that an unbound existing command context must not
fall back to a newer manual-compaction reference: only a truly external manual
action may capture the current reference. Add overlapping-command regression,
private-aside delivery/replacement isolation and owned streaming close/late
callback proof. This is an explicit owning-SDK frontend boundary; shipping CLI
launch/extension entry and arbitrary project command effects remain unwired.

Fresh focused gate: 59/59 passed, including actual threshold split-turn
compaction, inherited follow-ups without epoch mint, delayed old follow-up/native
continue holds, owned steering/follow-up queue removal, overlapping unbound
command compaction denial, private-aside positive/replacement isolation and
owned real streaming close/late callback hold. Added RPC/immutable private-copy
capture checks; final source gate follows. Earlier incomplete and red evidence
remains above. Installed compaction primary source SHA256:
`dfffd30e71b1ebb933aa165030a4a8abad8c9ef987e1a909bd3702a724ad95e3`
for pi-coding-agent0.73.0 dist/core/compaction/compaction.js.

Owning-SDK frontend is required, not an imaginary extension context method.
Installed SDK exports public AgentSessionRuntime, InteractiveMode and RPC/print
mode APIs; stock CLI builds them internally, while the shipped extension has
no public AgentSession handle for installing these entry guards. Do not access
an installed live session or infer that importing the extension activates this
module. Future managed launcher must own public SDK construction and guard
registration/readiness/runtime replacement. No installed dependency edit,
provider transport replacement, custom user consent channel or prompt marker.

Full requirement audit: source-bound carrier now strengthens actual template,
pre-start overlap, extension follow-up/queue, automatic compaction and SDK-close
ownership evidence. Main/observer/index production wiring, owner frontend/native
command/project async effects, runtime replacement/restart, internal HTTP retries/
later transport awaits/summary subrequests, native final responses, broader
host parity and complete authorized P0/P1 acceptance remain open. ADR007 hold
remains shipped. No universal/malicious-agent/process-isolation/real human-proof
claim, no workflow/resolver/live canary/native approval/inference/deploy/push.

Final pre-review focused gate 61/61 passed. Isolated staged snapshot
`4d25542d673184c29e786c44ca921c8ab8b8c5ef`, export
`/tmp/statewright-operation-carrier.PkMhca`: Node integration 281/281 no
skips/failures/cancellations; Pi 136 passed/1 existing opt-in live-canary skip;
native 2/2; generated managed-client parity and two syntax checks exit 0.
These gates are superseded by the review repair, not final repaired-source proof.

Clean-context Astra/high reviewer `/root/pi_operation_carrier_review` found R1
(high): SDK awaits slash-command/template lookup before emitting input, while
carrier only begins a parent request on input-hook arrival. Older slash/template
call followed immediately by newer plain input can therefore supersede it.
The single non-mutating actual SDK input-path challenge (synthetic authority,
terminal Agent-entry counter, no provider) produced only expanded old input at
epoch 1; newer input was suppressed. The existing same-text before_agent_start
case covered a later await and did not discriminate this boundary. No other
finding in the bounded five-path review; no broad tests or source writes.

R1 repair attempt 1: assign an opaque private entry claim synchronously on every
external interactive/RPC invocation, including command-only input. Reject old
claims before gate.input and after its helper return/onAdmit. No marker in text
or caller-chosen epoch. Add actual-Agent older-template/newer-interactive/RPC
regressions. Root's adjacent source-origin hardening rejects explicit-source
claims from an already inherited private call: a delayed model callback cannot
mint a human epoch by setting source=interactive. Genuine owning user frontends
must enter outside the inherited scope; final native UI proof is still open.
Retain failed review challenge and superseded gates; focused recheck then
fresh isolated repaired-source integration/review required. No broader build.

Root also closed the adjacent command-only interruption gap: invalidating the
parent reference alone does not abort an already streaming Agent when the SDK
command returns without input. Track the private exact signal/reference of an
actually started owned Agent and interrupt it at explicit entry after synchronous
request invalidation; do not scan or abort unknown/foreign SDK sessions. Add
real streaming command-only input proof (old signal aborted, no extra HTTP,
superseded epoch retained). Native command project effects still require their
own captured reference checks and final-response ownership remains open.

Entry-claim repair focused gate passed 63/63. After adding the adjacent actual
streaming command-only case, next gate was 63 passed/1 failed (64): owned signal
was aborted and Agent idle with no extra HTTP, but a direct parent-journal read
observed reason null before the asynchronous private cancellation had settled.
Require bounded polling for exact authoritative phase cancelled AND reason
superseded before cleanup; do not weaken the reason assertion or use a sleep.
The intermediate staged export `fc8bfd3ba1e44bcdbecf78391d49dff811097a4c`
at `/tmp/statewright-operation-final.Pt0mFo` is superseded, not green evidence.
A further mechanical fixture/evidence-only export is justified by that retained
failure; fresh focused, integration and independent R1 recheck follow. Public
command return is not claimed to acknowledge durable parent cancellation; its
asynchronous close/drain contract still needs production-lifecycle proof.

Fresh export `de3f4a0c28753b14ed5843fd7fcf208d425a1d6e` at
`/tmp/statewright-operation-verified.yFhKbE` passed focused 64/64, wider Node
281/281, Pi 139 passed/1 opt-in live-canary skip, native 2/2, generated parity and
both syntax checks exit 0. Independent R1 repetition confirmed exactly one begin
and one terminal Agent entry: newer explicit input, epoch 1. R1 is closed.

That recheck found adjacent R2 from source: abort ownership was captured before
SDK clearQueue emits synchronous public queue_update listeners. A listener can
change native identity, making the cached abort authorization foreign. Actual
SDK regression reproduced one unwanted native abort (1 failed/36 unrelated
tests skipped), so the preceding green export is superseded, not final proof.
R2 repair attempt 1 captures/rechecks native context, explicit-entry claim and
exact active signal/reference after clearQueue, immediately before abort/SDK
entry. No foreign abort or stale reentrant SDK entry is authorized. Retain
failed evidence and require fresh gates plus bounded independent R2 recheck.
Additional mechanical repair exports exceed the provisional two-export plan;
this is explicit regression-driven contraction, not an enforced quota claim.
Optional discovery is closed; only repair, source-bound validation and receipt
remain for this slice. Full production close/drain and acceptance remain open.

### Slice 6 final gates and full-objective audit

Final tested staged tree `de5689e1df6fbf72bde9e5a9b1f8b9bc6102d97d`, isolated
export `/tmp/statewright-operation-r2.M3SrX2`: focused Agent/gate 65/65; wider
Node integration 281/281 (zero skips/failures/cancellations); Pi 140 passed/1
existing opt-in live-canary skip; native session suite 2/2; generated Claude
managed-client parity and request-gate/request-operations syntax exit 0. No
workspace-wide Rust/typecheck/lint/build, internal provider retry, installed
runtime, real authorized approval or full native acceptance claim. URLs in Pi
unit-test diagnostics are mocked clients, not live gateway evidence.

Independent clean-context Astra/high read-only reviewer
`/root/pi_operation_carrier_review` rechecked R2 against that exact final tree:
actual SDK queue-listener regression 1 passed/36 unrelated skipped, exit 0;
native/entry ownership is rechecked after callbacks and captured signal/reference
immediately before abort. No remaining issue within that repair boundary. R1's
earlier one-begin/newer-only terminal-entry recheck is retained, not claimed
rerun by the independent R2 recheck; fresh full final suite includes both actual
interactive/RPC pre-input regressions. Root alone implemented; one mandatory
independent reviewer, bounded per-finding repair rechecks, no implementation
delegation. Earlier failed/superseded gates remain above. Final receipt-only
addition is the sole allowed delta from tested source before commit.

Re-audit all nine original 006 approval/request requirements, not just this
carrier's local success. Status is partial unless stated as retained constraint:

| Original requirement | Verified local evidence / remaining obligation |
| --- | --- |
| Immutable tenant/client/session/run/edge/artifact/policy/reviewer/expiry ticket | Exact client/thread/run/session/ticket/edge journal/service/request checks retained and integration passes; complete artifact/policy/expiry/revocation enterprise semantics are not established. Spec 114 remains proposed, not implemented-by-assertion. |
| Native thread/lineage/request ID/epoch, not model arguments | Durable parent IDs/epochs and exact native/session ownership retained; private call/entry/reference guards now cover tested SDK async inputs. Main/frontend/runtime-replacement and full child/parent/restart lineage acceptance remain open. |
| Pending: no declared effect or inference; park outside costly model turns | Shipped ADR007 hold stays in force; additive SDK primary HTTP/tool/retry/compaction holds pass inert fixtures. Every project async effect, later transport await/internal retry/summary subrequest and production activation remain unproved. |
| Query authority before controls; unauthorized reviewer dismissal only | Private read-only authority architecture retained; no resolver added to Pi carrier/bridge. Complete authenticated reviewer-control/entitlement journey remains unverified, not replaced by synthetic authority. |
| Cancel/dismiss/disconnect keeps pending journal; cold resume reconciles | Durable journal preservation and exact resume fixtures pass. This slice proves eventual authoritative superseded cancellation for a known streaming command; public command return is not a durable ack. Production close/drain, crash-lock/legacy recovery and complete cold native resume remain open. |
| Private resolve/recheck/consume once; duplicate/late harmless | Parent once-only nonce/tombstone, fresh approved applied-edge and stale-response fixtures remain green; no host resolver introduced. Complete artifact/policy/entitlement and native delivery acceptance remain unproved; at-most-once is not exactly-once native acceptance. |
| New user input invalidates older continuation AND final response | Entry-claim/pre-start/template/queue/native signal/late callback fixtures pass; foreign callback cannot abort replacement. Final-response rendering/recording and every declared production effect still need captured ownership checks. |
| Decision source/authentication strength; accessible API key not human proof | No stronger human/malicious-agent isolation claim. Fixtures use synthetic authority; complete decision provenance/strong-human authentication acceptance remains open. |
| Shared client-neutral reviewer/evidence/retention semantics | Shared P0 journal/service/request ledger retained, Pi has no decision surface or mandatory website UX. Cross-client/advertised host semantics and full retention/evidence acceptance remain open. |

P1 012 numbered/slice audit: (1/A) Rust pre-tool pending denial remains an
unrelated user-dirty gateway change, not committed or revalidated by this slice;
authoritative gateway/transition behavior is not claimed from a mocked client.
(2) Hosts stay unprivileged, private begin/status/consume/cancel cannot resolve;
actual trusted decision path remains untested. (3/C) durable journal/session
identity and request restart fixtures pass, but main requestController and
observer deferred-clear/owner close/readiness are not wired. (4/B) additive
owned-SDK admission/release prerequisites are tested, shipped extension remains
hold-only; it does not automatically activate this carrier. (D) workflow-loading
local gateway/fake-Pi canary and complete authorized native Pi/Codex/advertised
host journey are not run under the user's no-workflow authority.

Exact next bounded prerequisite: owning public SDK frontend/runtime construction
and exclusive final guard registration with native readiness, before enabling
parent request delivery. Then wire main requestController/observer deferred
journal clear/close and shipped index's correctives/timeouts/retries/embedded
tools to private captured binds. Audit every asynchronous effect/final response
and later inference transport boundary, restart/new-input/parent-child races,
and host parity; only separately authorized complete native approval acceptance
can satisfy the original end condition. Current main AdapterBridge has no
requestController; index still uses approvalHold and uncorrelated sendUserMessage.
No weaker pending-cache release, workflow load, resolver, real inference,
installed runtime/live-session change, deployment or push is substituted.

Goal remains active, not complete or blocked. Source progress is a reversible
local milestone only; all unrelated dirty user artifacts and Auldwyrm are
preserved. Provisional usage limits were observed-only, with extra exports
explicitly justified above; no controller quota/token/time enforcement claim.

## Slice 7: owned public SDK construction and readiness

Previous turn is verified progress: current HEAD is
`702840737c0dca051e21ca61ee48d76d226d3924`, no owned paths dirty, unrelated
inventory unchanged. Manual/no-workflow authority remains controlling; no
Statewright tools, installed runtime or live/native session are queried.

Next original prerequisite is actual owning public SDK frontend construction,
not another current-reference cache or extension-context handle that does not
exist. Installed 0.73.0 exports createAgentSessionServices,
createAgentSessionFromServices, createAgentSessionRuntime/AgentSessionRuntime.
The factory must create exclusive managed extension registration, install final
input/provider/tool/compaction guards, install private operation entry guards,
and publish exact native readiness only after successful SDK startup binding.
SDK loadExtensionFactories catches setup errors into getExtensions().errors;
bindExtensions awaits session_start and resources_discover; reload rebuilds the
runner and runtime replacement tears down/recreates sessions. These boundaries
must never silently enable unguarded delivery.

Owned file scope: new request-frontend.mjs and actual SDK fixture, ADR008 and
this receipt only. Do not activate executor/index, alter user-dirty Rust/canary/
supervisor paths, installed SDK, or dependency resolution. Create task-owned
memory SDK settings/auth/session + loopback inert SSE and real durable parent
fixtures. Characterize no existing owner frontend, then prove readiness/startup
failures, late hook registration, native drift and lifecycle invalidation.
The parent currently binds one exact native UUID: /new,/fork,/resume/import and
reload require a fresh authorized parent/frontend binding; deny before SDK
replacement rather than auto-adopting a foreign UUID or dropping guards. Full
replacement/restart protocol remains a required later milestone, not removed
from the full objective. Arbitrary project command effects, native final output,
transport awaits and main/observer/index wiring remain open as audited above.

Provisional observed-only envelope: serial root implementation, one mandatory
clean-context Astra/high final read-only review; 55 normal/85 worst tool calls,
<=16KiB later output per call, 30-minute discovery warning/45-minute contraction,
one isolated integration export plus regression-driven repair exports, at most
two distinct repairs per cited finding. Protect final third for validation,
review and scoped local commit. No Statewright/model-price/provider-token/usage
enforcement or workflow identity is invented; user no-workflow override is
explicit. Passed prior source/dependency evidence is context, not a substitute
for frontend-specific actual runtime proof.

Characterized baseline: new frontend fixture collection failed because owning
frontend module does not exist; this is absence evidence, not an existing
behavioral reproduction. Initial public SDK frontend implementation passed
10/10 real services/runtime/Agent + durable parent/loopback fixtures. Added
startup/readiness/late-hook/close diagnostics: 14 passed/1 failed (15), normal
session_start exception was swallowed by runner and readiness incorrectly
completed. Product defect, not an assertion mismatch: add an independent public
ExtensionRunner.onError listener before binding, synchronously revoke frontend
ownership and begin owned close. It cannot be replaced by UI onError bindings.
No error payload is persisted; fresh focused and source-bound gates follow.

Fresh frontend focused gate passed 15/15 after that startup-error repair;
18/18 after awaited resource discovery, failed publication and once-only UI
binding cases; final focused 19/19 adds an earlier trusted provider hook that
introduces pending authority, proving the last-installed guard parks before
actual HTTP and consumes synthetic approval once. Real public SDK services,
runtime, Agent and primary transport are used; no InteractiveMode UI, production
CLI launch, private parent readiness IPC or authorized workflow journey is
claimed. Frontend emits immutable statewright/pi-native-readiness/v1 native ID
only; parent consumer/close/drain and full effects are still prerequisites.

Primary installed SDK 0.73.0 core source SHA256 provenance:

- agent-session-runtime.js: `ee75a600ffa3cdf37772b4f1a4380e01d647143f3789a335d2f57183ce9d5d44`
- agent-session-services.js: `7d5af36def75db66dcdb83308acb7b381748c96e0432714fde5c7047a7b91910`
- resource-loader.js: `9a64314925734e69716e1da9d69dea48bec178778708cf4cfa6d7e0c4f3daf65`
- extensions/runner.js: `dab1eadccdd73b6bb50bbd22b464461c65eca77f368d2b44e5e9af4cbcc18d4d`
Source-bound evidence, not a dependency version pin or future compatibility
promise. Earlier Slice6 provenance remains valid for unchanged operation/gate
sources; final frontend-specific integration/review is required below.

Root registration integrity diagnostic reproduced a second product defect:
setup assigning pi.on to a no-op was accepted (1 failed/19 unrelated skipped),
so the final guard calls could silently do nothing while registered=true.
Reject mutable managed API namespaces and use privately captured original SDK
on for both managed setup and final guards. This is accidental/API mutation
protection, not malicious in-process isolation. Initial unused staged export
`5a25b223e96dda4728bf7f9a0bc3c682189416af` at
`/tmp/statewright-frontend.xnG3Ti` is superseded; no integration/review claimed
against it. One regression-driven repair export follows before the single
integration gate. Keep failures; no weaker registration success flag is accepted.

Frontend focused 20/20 and exact staged tree
`fc6b410736a449504fc63416eab914d2e5afb287` at
`/tmp/statewright-frontend-final.Ij0ta2` passed Node281/281, Pi160 passed/1
opt-in live-canary skip, native2/2, generated parity and frontend syntax exit0.
Mandatory clean-context Astra/high `/root/pi_frontend_readiness_review` used
seven read-only diagnostics and one actual memory SDK/no-provider challenge.
Found P2: after successful bind, native SessionManager.newSession changes UUID;
prompt is held with zero transport but readiness getter returns stale old ID.
Product defect against native-drift readiness contract, not fixture repair.

P2 repair attempt1: fail-closed native identity checks (including throwing
identity), revoke readiness and begin owned close when getter/prompt/bind
observes drift. Revocation is monotonic even if UUID is later restored; no
foreign abort. Add both actual public SDK regressions. Prior green export is
superseded; fresh focused/source gates and bounded independent P2 recheck are
required. No parent IPC or complete drift/replacement protocol is claimed.

First P2 repair focused gate was 21 passed/1 failed (22): readiness/null/no-abort
assertions passed, but the identity getter remained poisoned into SDK dispose,
which itself reads sessionId and rejected owned cleanup. This fixture probes
unavailable identity at guard observation, not permanently broken SDK disposal;
restore only that injection synchronously AFTER exact denial/no-abort checks,
before awaited teardown, and assert restored identity still cannot reactivate
readiness/input. Permanent native SDK teardown failure is not proved clean or
suppressed; production recovery/close-drain remains an open requirement.

Adjacent root close diagnostic with actual streaming Agent and a synchronous
abort listener calling close reproduced TWO SDK session_shutdown events
(1 failed/22 unrelated skipped). Product defect: closing promise was assigned
after operations.close could synchronously invoke abort listeners. Claim its
completion promise before any close work, retain synchronous invalidation and
one owned abort/cancellation/disposal sequence, then drain through that promise.
Add real signal-abort/one-shutdown/durable disconnected cancellation proof.
No reentrant shutdown handler awaiting its own completion is advertised.
Extra focused gate/export work is regression-driven; optional discovery remains
closed and original full-objective/production acceptance unchanged.

### Slice 7 final source, review and audit

Final tested staged tree `31499045b8a071e44d19ea7f6f49e31ee9f2d710`, export
`/tmp/statewright-frontend-verified.tj2gyQ`: frontend focused23/23; Node wider
integration281/281 (zero skips/failures/cancellations); Pi163 passed/1 existing
opt-in live-canary skip; native session suite2/2; generated Claude managed-client
parity and frontend syntax exit0; staged diff check0. No Rust/workspace-wide
typecheck/lint/build, headed native mode or actual workflow/decision/real-model
proof. Pi unit diagnostics use mocked clients. Temporary exports are validation
fixtures; durable source/evidence is this scoped local Git milestone/receipt.

Independent Astra/high `/root/pi_frontend_readiness_review` final bounded repair
recheck inspected that exact tree and ran only three cited actual SDK tests:
3 passed/20 excluded by filter, exit0. P2 closed: getter/prompt/bind observes
foreign/unavailable identity, readiness revoked monotonically, no foreign or
unverified abort; old UUID restoration cannot reactivate. Adjacent close repair
claims completion before synchronous abort listeners and proves one shutdown
plus durable disconnected cancellation for the tested streaming request.
No remaining finding within repair boundary; permanently broken SDK disposal
and full parent close/drain remain unproved. One mandatory independent reviewer,
no implementation delegation; failed and superseded evidence retained above.
Final recording is receipt-only delta from tested/reviewed source before commit.

Full original 006 nine-row audit above remains controlling, not redefined around
frontend success. Rechecked current 006 required contract and 012 numbered plan:
rows1/4/6/8/9 retain their partial ticket/artifact/policy/authority/reviewer/
provenance/retention/cross-client obligations; no resolver/human-strength claim
added. Row2 gains actual owning SDK/native-readiness construction but lacks
parent IPC delivery, full lineage and authorized replacement/restart. Row3
gains protected startup/error/registration/last-provider-hook evidence, not all
project commands/exec/native effects or later transport/internal retry/summary
subrequests. Row5 retains durable journal/cold-resume fixtures and gains one
owned streaming close proof, not complete cold native restart/crash-lock/legacy
recovery or permanent SDK failure cleanup. Row7 gains monotonic frontend
invalidation; rendering/recording every old native final response is still open.

P1 012: A/1 Rust pending pre-tool denial remains user-dirty/uncommitted and not
validated here; 2 host-unprivileged/no-decision surface retained, real authorized
decision path untested; C/3 parent main requestController/deferred-clear/close
and exact cold native resume remain open; B/4 owning SDK prerequisite now
implemented/tested but actual launcher/index remains ADR007 hold-only; D native
approval/restart/host-parity canary and full authorized journey are not run under
no-workflow authority. Initial frontend readiness is not production activation.

Exact next bounded source milestone: owning SDK mode/CLI entrypoint and private
parent readiness negotiation, binding the exact existing native descriptor and
owned child/parent lifetime before delivery. Public SDK main.d.ts MainOptions
accepts extensionFactories ONLY, not a runtime/session construction injection;
use public SDK services/runtime and modes, not assume stock main exposes the
owned handle. Then integrate main requestController/observer deferred-clear/
close and index's project async effects/correctives/retries with private captures;
prove native final output, later inference transport boundaries, restart/
new-input/parent-child races, original reviewer authority and advertised host
acceptance. No weaker cache/automatic UUID adoption is an activation shortcut.

Rollback is a scoped local commit revert of this additive inactive frontend,
preserving existing journals/request/owner records; no durable schema change,
installed runtime or live session to roll back. Manual profile owner is root;
validation source is exact staged SDK/Node fixtures, independent review is the
named read-only agent. Initial constructor/registration/readiness controls have
local operating evidence; production/recovery controls remain gaps. No migration,
website UX/compliance certification, deployment or push is claimed.
Observed-only envelope retained with extra exports/gates explicitly justified
by product regressions; optional discovery stopped, reserve used for repair/
review/source validation/recording. Provider-token/aggregate budget enforcement
unavailable; no quota-price claim or invented workflow identity. All unrelated
dirty artifacts/Auldwyrm preserved; full original goal active, not complete or
blocked. No workflow load/use, live native session access, resolver, actual
approval, real inference, installation, deployment or push occurred.
