# ADR 008: native approval release belongs to the parent request ledger

Date: 2026-09-17. Status: accepted prerequisite; production activation and full
P0/P1 acceptance remain incomplete. Base: `5862532`.

## Decision and authority

The executor owns an additive `statewright/executor-request/v1` record inside
its lifetime-locked session record. It mints a UUID and increments a durable
epoch for each explicit native input, retaining only its SHA256 digest, exact
native identity, phase, approval checkpoint, release nonce and consumed-ID
tombstones. Serialized, atomic fsynced writes precede admission responses.
Old v1 session records remain valid only with no request ledger and epoch zero.
Unclassifiable/partial/foreign records fail closed without repair or adoption.

The private Pi-only loopback protocol accepts begin/status/consume/cancel, not
decisions, checkpoints or caller-chosen authoritative epochs. Begin requires
the exact owned native session and a strictly increasing per-parent input
sequence. Its synchronous invalidation prevents old asynchronous results from
becoming authority for replacement input. The model's tool arguments cannot
substitute for the private outer request reference. Owned MCP/pre-tool/post-tool
effects check current request identity and fresh run/session identity around
awaiting work. No approval-resolution endpoint is exposed.

An approval journal remains durable while pending or rejected. Read-only private
receipt plus a fresh applied owned edge can issue a nonce for the current
request. Consume rechecks that authority, durably records its once-only
tombstone, verifies that consumption before journal clearance, then rechecks
current identity and the applied edge. A known failure after consumption
invalidates delivery and requires fresh explicit input. A restarted controller
never adopts an old native request reference; an existing tombstone can repair
the journal but cannot reissue the consumed continuation. Crash owner locks are
still recovery-required, never stolen by PID/age heuristics.

## Native SDK boundary and activation constraint

The Pi gate awaits private status outside inference and returns the SDK input
event's `continue` only for an active current parent request. It is disabled
until explicitly enabled after hook registration. Managed errors, invalid
native identity, malformed status, cancellation, rejection, timeout and obsolete
responses return `handled` or block the tool callback; exceptions do not escape
to the SDK's fail-open hook handling. Transport waits have cancellation and
timeout bounds even if an injected transport ignores its signal. An obsolete
callback must not invoke the SDK context's lazy abort against a newer agent.
Input explicitly waits for `ctx.isIdle()` after abort and before admission,
including awaited real-agent end listeners. Checkpoints require a captured
private request reference, not the current reference fetched by a late callback.
Missing or foreign references cannot authorize either continuation or abort.

Primary source: installed Pi SDK 0.73.0 `dist/core/agent-session.js` and
`dist/core/extensions/runner.js`. `ExtensionContext.abort()` discards the
underlying idle promise; it does not prove the old operation has stopped.
The original public AgentSession/ExtensionRunner + loopback bridge + durable
owner/journal fixtures retain terminal fake-agent evidence. The additive
`request-agent-native.spec.ts` uses public createAgentSession, actual Agent,
factory-installed onPayload, primary openai-completions adapter, real SDK tool
hooks, automatic AgentSession retry and manual compaction. HTTP is task-owned
loopback with inert SSE/tool-call responses; authority remains synthetic and
no model inference, real provider, workflow, user config or native session file
is used. Replacement steer/follow-up input cannot enter real SDK queues while
an awaited old agent_end listener keeps the old Agent non-idle.

`installPiRequestGuards` requires a private operation correlator; it has no
current-cache fallback. The SDK catches before_provider_request exceptions and
has no cancellation result. Guards therefore return a payload proxy that
allows the inert `then` promise-assimilation probe but rejects denied payload
use outside that catch. An admitted payload rechecks current reference, native
identity and captured Agent signal synchronously when consumed. Actual primary
adapter HTTP fixtures prove the tested holds and identity/cancellation failures
dispatch zero additional requests, including foreign-session denial without
aborting that session. Compaction uses its distinct captured event signal.
Guard registration must be last and managed extension loading exclusive; a
later handler could replace a payload. These are adapter-specific prerequisites,
not a supported universal provider cancellation API or a lease across later
SDK auth/header/routing/transport awaits or internal HTTP retries.

This commit does NOT wire the controller into executor main or the gate into
the shipped Pi extension. Existing ADR 007 hold behavior remains in force.
The earlier text-digest fixture binder is superseded by
`createPiRequestOperations`, installed on a task-owned public SDK session before
input. Private AsyncLocalStorage scopes carry an immutable reference, bound
once by gate onAdmit inside the original explicit interactive/RPC call.
Template expansion cannot change it; overlapping same-text calls cannot adopt
the newest input's reference. Guarded Agent prompt/continue entry rechecks it
after pre-start awaits and before actual Agent start. SDK event processing,
AgentSession retry and automatic threshold compaction retain that originating
scope in the installed 0.73.0 fixtures.
An opaque claim is assigned synchronously at every external explicit entry.
SDK input hooks reject stale claims before admission, because slash/template
lookup awaits before those hooks. An inherited private call cannot claim human
origin by setting source=interactive/RPC; user frontend entries must be outside
that scope. The known exact-owned active Agent signal/reference is captured at
actual start and interrupted at explicit entry, including command-only calls
that never emit SDK input. This is not heuristic active-session discovery.

Extension sendUserMessage inherits a captured private reference and checkpoints
without minting a human-input epoch; unbound extension calls are held. Timers
and detached correctives must capture a private bind callback when armed,
not when fired. Explicit replacement invalidates before SDK commands/preflight
and clears owned steering/follow-up queues. Next-turn custom asides remain in
a bounded private reference-owned queue, appended only at an admitted actual
Agent entry for that request. They never inhabit SDK's unowned shared pending
queue. Manual compaction may capture current ownership only at a truly external
manual entry; an unbound or stale existing context cannot borrow it. Owned close
aborts the exact-owned SDK Agent, cancels parent ownership and keeps entry
guards installed for late timers. Native-session drift cannot authorize abort
of a foreign session.

This requires an owning SDK frontend. The stock shipped Pi CLI/extension does
not expose its AgentSession object for this installation; it is not activated
or silently monkey-patched through global discovery. No installed SDK sources
are edited. Future managed launch must use the public SDK frontend/runtime
contract and exclusively install these guards before readiness. Native command
effects, resource/runtime replacement and every remaining async effect/native
final-response/SDK transport boundary still need exact captured ownership before
activation. Arbitrary commands bypass SDK input; wrapper invalidation alone is
not authorization for their project effects. SDK custom/bare paths not guarded
by this owning frontend must not be advertised as supported. AgentSession retry
is tested with primary HTTP client retries explicitly zero; default/internal
provider retries and compaction's later separate summary subrequests are not
proved across authority changes. Dependency compatibility is source-bound
evidence, not a version pin. No full native acceptance is implied.
No live/native authorized approval journey, deployment or promotion is claimed.

Additive `createPiRequestFrontend` now owns public SDK services/session/runtime
construction for one exact parent-bound native UUID. One managed extension
factory registers trusted project hooks first and final admission guards last;
its namespace is read-only and hook API sealed afterward, including functions
captured before sealing. Final guard registration uses the privately captured
original SDK on function, not a setup-replaced property.
SDK-collected extension errors and an independent public runner error listener
deny readiness even when the SDK catches handler exceptions. Input stays held
through awaited session_start, resource discovery and readiness publication.
A versioned immutable native-identity receipt is produced only by this owned
construction path; parent private IPC acceptance/delivery wiring is still open.
Native drift/close/registration violations cannot enable or retain readiness.

SDK reload and runtime new/switch/fork/import are intercepted before underlying
replacement and require a fresh parent/native binding. The existing parent
record is exact-UUID-bound, so automatic SDK identity adoption would violate
ownership; a full authorized replacement protocol remains a later requirement,
not removed from scope. This frontend has no production CLI entrypoint or mode
activation yet. Its initial UI binding is once-only; failed constructor and
close paths dispose only their owned SDK object, leaving late guards installed.
Bare SDK effects, project commands/exec, async final output, provider internals
and full parent close/drain remain unproved. No readiness receipt is a claim
that these original production acceptance requirements have been satisfied.
Shipped executor/index/ADR007 hold and installed runtime remain unchanged.

## Consequences and rollback

Safety wins over replay availability: at-most-once durable consumption is
proved here, not an exactly-once native acceptance promise across process or
transport failure. Lost delivery requires explicit input. Tombstone capacity
is bounded at 256 IDs; overflow denies new consumption and requires explicit
recovery rather than eviction/replay. Raw prompts and private credentials are
not stored in the request ledger.

Rollback is a scoped commit revert with existing journals/ownership records
preserved. Once a nonzero ledger exists, the prior reader must not be used to
resume it; validate/recover explicitly, never delete its evidence. No installed
runtime or live native session is changed by this prerequisite.
