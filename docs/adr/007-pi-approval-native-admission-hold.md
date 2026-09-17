# ADR 007: Pi approval admission is a native, fail-closed hold

Date: 2026-09-17. Status: accepted intermediate boundary; full P1 continuation
and live acceptance are not complete. Base: `16732d7`.

## Context and evidence

Pi SDK 0.73.0 calls `agent.prompt()` after `before_agent_start`; `ctx.abort()`
there only aborts a currently running operation. Its extension runner catches
input-hook exceptions and continues, so throwing is also not a safe gate.
The public `input` event's `{ action: "handled" }` result returns before model
authentication, automatic compaction, steering/follow-up queueing and inference.
Primary local evidence: installed SDK `dist/core/agent-session.js:690-813`,
`:1057-1060` and `dist/core/extensions/runner.js:793-835`. Actual public
`AgentSession`/`ExtensionRunner` fixtures reproduced inference admission for
pending, malformed, disconnected and UI-failure cases on the previous source.
The fixture replaces inference and compaction with counters; it is not provider
inference, native restart acceptance or a complete approval journey.

## Decision

Register the input guard before gateway initialization. Managed admission reads
fresh state, never a stale cache fallback. Pending/malformed approvals or absent
managed state consume input before the native request path. A hold is monotonic
for this extension instance: projection absence, replacement input, deactivation
or a final-state flag cannot release it. The helper exposes no resolver and no
release method; only an authorized human can decide through the existing private
gateway approval service. Notifications/cleanup failures do not escape the hook
and become fail-open continuation.

Block all model tools while held, including Statewright transitions. Abort an
active operation without awaiting its idle promise inside a tool callback;
awaiting it would wait on the very callback the agent is awaiting. Suppress
recovery and inactivity nudges once the hold has been observed.

The executor durably reconciles the shared journal before acting. It returns
`status: approval_parked` without launching parked Pi, or sends SIGTERM only to
the Pi child it spawned after a durable pending observation. SIGINT alone can
become interactive cancellation rather than process shutdown. A latched parent
hold never automatically reroutes/restarts old input, even if the final drain
reads a now-absent projection. Paused delivery is not finalized as completion.

## Alternatives and consequences

Rejected: model self-approval instructions, returning tool errors without a
native input boundary, hook exceptions, mocked abort-only evidence, raw
projection-based release and automatic old-input retry.

This intermediate slice intentionally favors safety over availability. It does
not automatically resume after approval, retain replacement input for replay,
implement private receipt long polling, persist request epochs or prove
exactly-once continuation. Fresh-process recovery remains subject to the existing
owned-session/journal checks. Parent detection has polling latency; changes
between native input admission and a later request/compaction remain a required
race-validation/transport-gate item. SDK automatic retries/compaction and
mid-await recovery must not be advertised as fully P1-conformant yet.
Unmanaged Pi has no new durable approval ledger in this slice.

No provider credentials are given to the managed Pi child. No raw prompt is
persisted by this helper or emitted in hold telemetry. Roll out from a reviewed
scoped commit only; no installed live runtime, deployment or workflow-loading
canary is part of this decision. Rollback is a coherent revert, never removal of
an existing approval journal. Replace the hold-only behavior only after private
approved receipt + applied owned edge + current persisted input epoch and
once-only continuation have discriminating restart/cancellation/race evidence.
