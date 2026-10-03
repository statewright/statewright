# Classifier approval handoff: causal trace and test matrix

## Scope and evidence boundary

This packet covers the Codex 0.3.4 classifier fallback approval path. It does
not authorize installation, deployment, release, a Nomad edit, or replay of a
denied command. It distinguishes source/protocol tests from an actual native
TUI dialogue.

The current reproducer is the Nomad M1 validation command in thread
`01a0f2f3-c9d8-7fa2-a21d-830a40ba96aa`. The durable evidence is
`~/.codex/sessions/2026/09/30/rollout-2026-09-30T11-34-18-01a0f2f3-c9d8-7fa2-a21d-830a40ba96aa.jsonl`.
The older 2026-10-02 04:11Z incidents are historical and are not used as the
latest denied invocation.

## Verified recent causal trace

- 2026-10-02T22:32:36.984Z: the exact three-file Vitest invocation was issued.
- 22:32:40.413Z: the recorded decision was `deny_uncertain`, basis
  `semantic_authorization_disabled`, authority
  `complete_structural_evidence_or_separate_approval`, with reformulation
  allowed and exact replay forbidden. The recorded receipt contains no
  classifier-approval result.
- 22:32:40.418Z: the command was blocked before execution.
- 22:33:09.524Z: the workflow moved from implement to validate.
- 22:33:17.857Z through 22:33:18.548Z: the exact command was attempted again,
  received the same intent/invocation denial, and was blocked before execution.
- 22:33:34.742Z through 22:33:34.743Z: the agent explicitly transitioned the
  workflow to terminal blocked. The hook did not itself perform this
  transition.
- 2026-10-03T00:29:38.148Z: transcript approval was forwarded as a user
  message. At 00:29:46.663Z the workflow was already terminal blocked, and at
  00:29:51.832Z the agent reported that no approval endpoint was exposed.
  There is no recorded native approval-resolution event at 00:29.
- 00:32:54.256Z: the user separately authorized session-scoped recovery.
  Native deactivation succeeded at 00:32:57.372Z; inactive status followed at
  00:32:59.309Z. Only then did the test execute at 00:33:02.196Z, initially
  producing 23 passes and two genuine failures. This was recovery, not an
  approval of the earlier invocation.

## Root cause: facts and remaining unknowns

Established facts:

1. The loaded Nomad companion runtime recorded local-models revision
   `7e05b071cc34d879c04f4e8591e1e07c3f8afa30`. Its recorded provider source did
   not implement `POST /classifier-approval`; the Statewright 0.3.4 hook/helper
   already attempted that route. Therefore that runtime could not complete the
   intended hook-to-native approval handoff.
2. The first repair added the missing local endpoint and exact owning-thread,
   run, state, intent, invocation, and basis binding. It also made timeout,
   dismissal, disconnect, stale reply, concurrency, and HTTP interruption fail
   closed.
3. Coverage audit found a second architectural defect: both the companion and
   shared executor gate inferred approval eligibility from label prefixes and
   admitted `workflow_capability_*` and `classifier_policy_*`. Gateway receipts
   already mark those decisions non-reformulable. The repaired contract makes
   the gateway emit `separate_approval_allowed` and requires every adapter to
   bind the complete eligibility tuple.
4. Exact invocation replay does not consume a rework slot. Rework accounting
   advances only for distinct invocation fingerprints within the same
   thread/run/state/intent/basis scope. One native response can release only
   the exact pending invocation once.
5. A native acceptance re-reads authoritative Statewright state before it is
   consumed. Missing, inactive, terminal, changed-run, or changed-state
   snapshots deny the invocation; a delayed read keeps the single request
   pending and cannot release a concurrent call.
6. Classifier approval cannot revive terminal workflow state. Terminal recovery
   remains an explicit supported workflow/session lifecycle action, separate
   from command approval.

Unknown: the durable M1 record has no denial-specific HTTP request, response,
or native elicitation event. The source mismatch proves that the loaded
runtime lacked the route, but it does not prove whether that exact hook request
reached the missing route, failed before dispatch, or lacked the required
runtime context. No guessed exact-request cause is treated as fact.

## Decision and lifecycle matrix

| Layer | Case | Required outcome | Automated evidence |
| --- | --- | --- | --- |
| Gateway unit | Deterministic structural read/local execution | No fallback approval; ordinary capability decision | Rust risk-assessment tests |
| Gateway unit | Each supported semantic uncertainty basis | Reformulation yes, exact replay no, separate approval yes | Rust basis table |
| Gateway unit | Wrong authority with an uncertainty label | Separate approval false | Rust negative assertion |
| Gateway unit | Capability, classifier-policy, known-risk denial | Separate approval false | Rust negative assertions |
| Hook unit | Raw command/arguments in receipt | Never forwarded | Codex helper redaction test |
| Hook unit | Missing/false eligibility field or unsupported basis | Local deny, no request | Codex helper table |
| Hook unit | Any response identity field changed | Fail closed | Mutation table across schema, thread, run, state, intent, invocation, basis, authority, retry policy |
| Hook integration | Eligible uncertainty | Redacted request; rework then allow-once translation | Native gateway bridge fixture |
| Hook integration | Capability or classifier-policy denial | No native approval request | Negative bridge cases |
| Protocol unit | Same intent, different thread/run/state/basis | Isolated counters and authority | Companion controller scope test |
| Protocol unit | Exact invocation replay | Denied without consuming rework | Shared gate and companion tests |
| Protocol unit | One matching native accept | Release exact pending invocation once | Companion controller test |
| Protocol unit | Stale/duplicate reply ID | Cannot release another invocation | Companion controller and proxy tests |
| Protocol unit | Accept after run/state change or terminal state | Re-read authority and deny | Controller table and proxy integration test |
| Protocol unit | Decline/cancel/native error/unknown action | Deny and retain bounded tombstone | Companion controller/proxy tests |
| Protocol unit | Missing/delayed/timeout response | Deny | Timeout and pending tests |
| Protocol unit | HTTP abort/provider disconnect/send failure | Deny and resolve native request when presented | Companion controller/proxy tests |
| Protocol unit | Concurrent second request | Deny; one click cannot release two calls | Proxy integration test |
| Protocol unit | No owner or multiple live owners | Deny | Proxy integration tests |
| Protocol unit | Wrong method/auth or browser Origin | 404/401; no approval | HTTP surface test |
| Protocol unit | TTL expiry | Denial tombstone expires; pending request is not pruned | Controller clock test |
| Lifecycle | Interrupted/resumed provider | Pending request denied on disconnect; authority is not persisted | Proxy disconnect test |
| Lifecycle | Terminal blocked workflow | Approval path does not resume it | Architectural boundary; no automatic recovery claim |

## Coverage strata and remaining release gaps

Unit coverage proves receipt eligibility, redaction, retry accounting, identity
binding, one-use consumption, and fail-closed lifecycle behavior. Protocol
integration coverage uses real loopback HTTP and WebSocket connections with a
mock native client; it proves routing and response correlation but not the
vendor UI.

No test in this packet proves that a current Codex Desktop/TUI build visibly
renders the form, that a human click traverses the real vendor protocol, or
that the repaired source is loaded by staging. Those require a later authorized
installation/runtime refresh and an observed live dialogue on the exact built
candidate. A live cancellation, delayed response, app restart, and stale reply
should be included in that acceptance pass. Until then, actual live TUI
coverage remains unverified and the revised source supersedes the older
candidate's validation rather than inheriting it.
