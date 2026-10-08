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
| Hook unit | Any response identity field changed | Fail closed | Mutation table across schema, thread, run, run session, state, state epoch, intent, invocation, basis, authority, retry policy |
| Hook integration | Eligible uncertainty | Redacted request; rework then allow-once translation | Native gateway bridge fixture |
| Hook integration | Capability or classifier-policy denial | No native approval request | Negative bridge cases |
| Protocol unit | Same intent, different thread/run/run-session/state/epoch/basis | Isolated counters and authority | Companion controller scope test |
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
| Pipeline unit | Earlier optional handler does not own/support the request | `NotHandled`; continue serially to the next handler | Ordered pipeline pass-through test |
| Pipeline unit | Earlier handler returns `ExplicitDeny` | Stop; no later handler may allow | Ordered pipeline short-circuit test |
| Pipeline unit | Handler returns `AskPending` | Stop and await the exact bound response; no later fallback runs | Ordered pipeline short-circuit plus controller pending tests |
| Pipeline unit | Applicable required handler is unavailable, times out, throws, or returns malformed output | `Error`; stop and apply the request class's fail-closed terminal policy | Ordered pipeline error tests plus classifier timeout/disconnect tests |
| Pipeline integration | All optional handlers return `NotHandled` for a pass-through protocol class | Forward the original request/reply unchanged; do not manufacture approval | Provider unclaimed-reply forwarding behavior; dedicated shared-pipeline fixture remains follow-on |
| Pipeline integration | All handlers return `NotHandled` for protected classifier approval | Deny as `unsupported_approval_request`; never infer approval from silence | Classifier endpoint integration test |
| Pipeline integration | Required durable transition handler cannot answer | Keep the goal parked and surface an error; do not fall through or resume | Provider transition-barrier behavior; dedicated shared-pipeline fixture remains follow-on |
| Codex host adapter | Classifier denial is eligible for human approval | `PreToolUse` remains a denial; presentation uses an explicit App Server elicitation request, never `permissionDecision: "ask"` | Codex executor-bridge assertion plus companion controller protocol test |
| Host conformance | Host-native policy or another plugin denies before/around Praetorian | Preserve the host denial; the internal chain cannot override it | Required per-host runtime fixture; documentation alone is not a pass |
| Host conformance | Adapter lacks a proven intercept/hold/prompt/resume path | Report the protected action as unsupported; do not advertise approval parity | Required per-host negative fixture; not implemented for unsupported modes |
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

## Praetorian boundary for the local approval pipeline

The ordered policy/evidence/human-approval middleware is conceptually
**Praetorian**: a client-neutral pre-action governance contract. In the
Statewright product, its managed enforcement surface is **The Praetorian
Gate**. This naming describes the intended boundary; it does not mean a
Praetorian package, repository, build, or generally available product has been
shipped by this repair.

The earlier Praetorian research program proposed a separate repository “from
the outset.” Ben's current product-boundary decision supersedes that sequencing
for this repair: preserve the Praetorian contract boundary now, and consider
physical extraction only as a later authorized milestone.

The responsibilities divide as follows:

| Boundary | Responsibility |
| --- | --- |
| Praetorian-aligned middleware contract | Normalized request classes; ordered handler outcomes and exhaustion semantics; evidence and approval binding; one-use decisions; adapter-neutral conformance fixtures. |
| Statewright | Supplies authoritative workflow context and workflow-specific policy inputs: workflow/run identity, gateway run session, state and state epoch, capability/transition status, classifier eligibility receipt, and lifecycle reconciliation. Praetorian middleware must consume this context, not recreate or override it. |
| Native host adapter | Proves exact thread/session ownership, transports the bounded request, renders the host-native prompt, and correlates its response. It does not evaluate workflow truth or broaden approval eligibility. |

The current narrow fix remains in the existing Statewright hook and
`codex-local-models` native host. Moving it now would create a second packaging
and deployment problem before the repaired lifecycle has live conformance
evidence. No parallel “shared approval” plugin or product identity is needed.

### Host capability envelope

Praetorian's first-handled priority chain is internal to the adapter-owned
request after that adapter has legitimately intercepted or parked it. It does
not replace the host's native policy composition and cannot promise to override
a host-native rule or another plugin that denies or short-circuits first. An
internal `Allow` means only that Praetorian has approved its exact bound request;
the host may still deny it, and an adapter must preserve that denial.

The cross-host research accepted for this design is capability-graded:

| Host surface | Documented behavior | Praetorian implication |
| --- | --- | --- |
| Codex `PreToolUse` | `permissionDecision: "ask"` is parsed but unsupported; Codex reports the hook failure and continues the tool call. `PermissionRequest` runs only when Codex is already about to ask for approval and may decide or decline to decide. | Never map Statewright classifier uncertainty to a magical `PreToolUse` ask. The current narrow path keeps the hook denial in place and uses the separately implemented App Server elicitation protocol owned by the local host. |
| Cursor generic `preToolUse` | `ask` is accepted by the schema but not enforced. Shell- and MCP-specific pre-execution hooks support `ask`. Cursor merges all matching hook decisions as deny over ask over allow. | A Cursor adapter must select and prove the action-specific supported surface. Praetorian cannot overrule another source's deny, and generic-hook coverage cannot be advertised as interactive approval. |
| Claude settings `PreToolUse` | Matching hooks run concurrently and decisions compose as deny over defer over ask over allow. | Praetorian may participate only within that host composition; its allow cannot erase a competing deny. Interactive versus non-interactive `defer` behavior must be tested separately. |
| Claude Mods | Mods form a `next()` middleware chain; a handler may answer without calling `next`, preventing later mods and Claude's own behavior from running. Managed-settings `PreToolUse` denial occurs before mods and is final. | A Mods adapter must record its chain position and prove that the protected call reaches it. An earlier short-circuit or managed denial is authoritative, not a Praetorian failure that may be retried through another surface. |

Sources checked 2026-10-02: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Cursor hooks](https://prod.cursor.com/docs/hooks), [Claude hooks](https://code.claude.com/docs/en/hooks),
and [Claude Mods events](https://code.claude.com/docs/en/plugins/mods/events).
These vendor contracts bound the design; they do not establish the cause of the
Nomad incident or prove any installed adapter's live behavior.

The on-disk Homebrew command resolved read-only to `/opt/homebrew/bin/codex`
(a link to `../lib/node_modules/@openai/codex/bin/codex.js`) and reported
`codex-cli 0.160.0`. No restart or installation occurred. This is artifact
provenance only: it does not prove the version already loaded by the running
Nomad App Server, which still requires process/runtime evidence.

For a sensitive corporate-policy effect, an adapter is eligible to claim
enforcement only after proving interception, durable hold or park, authorized
human presentation, exact response binding, and single-use resume/release on
the actual supported runtime. A surface missing any required capability must
publish that limitation as `unsupported` (or advisory where explicitly
designed), rather than inheriting another host's coverage or claiming parity.

The classifier rule remains gateway policy. The gateway alone decides whether
an uncertain invocation is eligible for separate approval and emits the
redacted intent and invocation fingerprints. Neither the Codex hook nor the
native-session host may reclassify a command or widen that eligibility.

The Codex hook is a thin synchronous transport adapter. It forwards only the
gateway receipt plus the owning thread, workflow run, gateway run session,
state, state epoch, intent, and invocation. It never renders a dialog, counts
retries, or treats transport failure as permission.

The local native-session host owns presentation and applies an ordered chain of
responsibility. Handlers run serially by explicit priority; this is not a race:

1. `workflow-transition-barrier` verifies the authoritative execution context.
   A pending workflow-transition approval, terminal or changed state, or an
   unavailable state reader returns a terminal denial/error. This priority is
   required because classifier approval is documented not to replace a
   workflow-transition approval.
2. `classifier-invocation` handles an otherwise eligible classifier request,
   including rework accounting and one exact native prompt.

Only `NotHandled` advances to the next handler. `Deny`, `Ask`, `Allow`, and
`Error` short-circuit. An explicit denial therefore cannot fall through to a
later allowing handler. `Ask` means the request has been handled and is pending;
it also stops traversal rather than inviting another handler to answer. An
unavailable applicable handler is `Error`, not `NotHandled`.

### Exhaustion policy by request class

Pipeline outcomes do not themselves define one universal fallback. The entry
adapter declares whether its request class is optional or required and applies
the terminal policy after the ordered handlers have either handled the request
or exhausted the chain:

| Condition | Meaning | Terminal behavior |
| --- | --- | --- |
| `NotHandled` | This handler does not own or support the exact request kind and execution context. It is not a policy decision. | Continue to the next handler. If the chain exhausts, apply the entry adapter's request-class policy. |
| `Unavailable` / timeout | The applicable handler owns this request but cannot complete it. | Return `Error` and stop. Never recast it as `NotHandled` to reach a more permissive handler. |
| `AskPending` | A matching handler presented or is awaiting one exact context-bound human decision. | Stop the chain and wait within the bounded lifecycle. Dismissal, timeout, disconnect, or silence resolves as non-approval according to that request class. |
| `ExplicitDeny` | An applicable handler denied the request. | Stop immediately. A denial never falls through. |
| `Allow` | An applicable handler approved the exact bound request. | Stop immediately and consume the approval at most once. |

For an optional protocol projection, exhaustion may pass the original
request/reply upstream unchanged; this grants no new authority. The current
native reply path already has this shape: classifier and workflow approval
resolvers may decline ownership, after which the reply is forwarded to the
upstream App Server.

For the protected classifier-approval class, a human answer is required before
the denied invocation can run. Exhaustion becomes
`unsupported_approval_request`; an unavailable handler, timeout, dismissal, or
other unresolved `AskPending` becomes a denial. Only a matching one-use
`allow_once` releases that invocation.

For a durable workflow-transition class, an unanswered required approval keeps
the goal parked and surfaces an error. It does not fall through to classifier
approval, resume automatically, or become an implicit denial that erases the
pending lifecycle. Unknown or unversioned security-sensitive request classes
fail closed until their adapter defines a narrower contract.

Thus “no handler answers” is context-sensitive: an optional pass-through class
falls through unchanged; a required invocation approval denies; a required
durable transition remains parked with an error. No exhaustion path converts
silence, unsupported handling, or infrastructure failure into approval.

The existing loopback-authenticated `POST /classifier-approval` endpoint is
retained as the classifier-specific adapter. Its request and response schemas
are `statewright/classifier-approval-request/v2` and
`statewright/classifier-approval/v2`. Version 2 requires `thread_id`, `run_id`,
`run_session_id`, `state`, `state_epoch`, intent fingerprint, invocation
fingerprint, denial basis, authority, and retry-policy fields to match exactly.
The invocation fingerprint is the command identity; raw command text and tool
arguments never cross this boundary.

This is a coordinated Statewright-hook and local-companion contract. A v2 hook
with a v1 host, or a v1 hook with a v2 host, fails closed. Adoption therefore
requires one full-tree staging candidate and a fresh local host process; it is
not safe to deploy either side independently. No compatibility fallback may
silently strip the run-session or state-epoch binding.

The durable workflow-transition controller remains separate because it owns a
gateway ticket, reviewer authorization, parking journal, and resume lifecycle.
Its native rendering can later become another thin pipeline adapter, but this
repair does not merge its persistence semantics into invocation approval or
create a second recovery implementation.

The pipeline was first proven in the `codex-local-models` native host, which
owned the reproduced Nomad thread. The Statewright staging candidate now keeps
the same v2 controller and ordered pipeline in the shared Codex App Server
proxy. Both the standalone resident and direct Desktop launcher publish a
private process-scoped endpoint receipt, while the direct Desktop adapter reads
authoritative state only through its selected authenticated managed bridge.
Exact initialized connection and durable thread ownership select the handler;
zero or multiple owners deny. This closes the source/package mode gap, but it
does not by itself establish visible Desktop behavior: packaged native-dialogue
accept, cancel, restart, and one-use release remain a live acceptance gate.

The smallest follow-on is to stabilize one Praetorian-aligned contract in the
existing code and give each mode a thin ownership adapter. A handler may return
`NotHandled` only when it does not own the exact thread or request kind. The
exact owning mode services the request; a second owner is an error, and an
unavailable advertised owner fails closed. Source does not justify ranking
`codex-local-models` ahead of the standalone resident (or vice versa): exact
thread ownership selects the applicable handler, while the explicit priority
orders approval kinds within that owner.

Future extraction into Praetorian is a separate, gated milestone. It becomes
reasonable only after the current Statewright repair has live native-dialogue
evidence, the standalone resident and local companion pass the same conformance
fixtures, and the protocol/package boundary can be versioned without importing
a developer checkout or coupling to Statewright hosting. That extraction may
move the generic outcomes, ordering/exhaustion rules, request/decision schemas,
and conformance vectors. Statewright-specific workflow context production,
classifier eligibility, transition reconciliation, and managed adapters remain
Statewright responsibilities. This packet neither authorizes nor implements a
new Praetorian repository, package, build, release, or deployment.
