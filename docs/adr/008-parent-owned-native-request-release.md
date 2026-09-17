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
The actual-agent fixtures correlate only untouched synthetic prompt digests to
captured signals, plus an explicit outer manual-compaction reference. That is
test-only, not a general template/recovery/follow-up binder. Automatic compaction,
extension-source follow-ups, overlapping pre-start prompts, native commands and
shutdown, recovery effects and every remaining async/SDK transport boundary
must retain the same authoritative epoch before activation. AgentSession retry
is tested with primary HTTP client retries explicitly zero; default/internal
provider retries are not proved. The SDK dependency is not pinned by this slice.
No live/native authorized approval journey, deployment or promotion is claimed.

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
