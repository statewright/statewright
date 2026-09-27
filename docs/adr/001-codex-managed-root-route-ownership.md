# ADR 001: Codex managed root-route ownership

Status: Accepted

## Context

A managed Codex TUI and tools it launches share environment variables, an MCP
bridge identity, and a route-control directory. A nested `codex exec`, review,
or interactive Codex can therefore present the same managed client ID as its
parent. Client identity alone cannot decide which thread the supervisor may
resume or which thread a resident App Server may route.

This caused an ephemeral review thread to replace the parent restart target.
The supervisor then attempted `codex resume` for a thread that was intentionally
not persisted.

## Decision

Each managed TUI launch owns one `codex-root-session.json` registration in its
private route-control directory. An explicit session argument may seed it. For
fresh sessions and selector forms such as `resume --last`, the root user-prompt
hook registers the actual Codex thread before agent tools can launch children.
Registration is first-writer-only until the owning supervisor explicitly resets
it for a new TUI attachment.

Codex Desktop may rebind that registration only for an original user-selected
`thread/resume`. Before forwarding, the broker prepares a versioned transfer
that proves the registered client still owns the source thread and that the
source and destination rollouts declare the same immutable `cwd`. The proxy
commits the compare-and-swap only after the matching native response returns
the requested thread. Native errors, mismatched responses, expiry, connection
close, changed registrations, missing metadata, foreign clients, and different
roots cancel or reject the transfer without replacing the existing root. The
committed version-2 root record retains the typed transfer as an audit receipt.
Internal provider replay/resume traffic does not pass through this adoption
lifecycle.

Both restart and resident App Server transports accept a route only when its
client ID, session ID, and declared root agree with that registration. Nested
one-shot hooks do not register roots or emit route requests. Managed child
launches scrub inherited root ownership along with the existing client and
control-directory identity variables.

The App Server proxy also matches the actual `turn/start` thread before it
consumes a registered route. A turn for another thread leaves the root route
pending. Every control-directory consumer distinguishes `*.route.json` from
the root-registration file.

## Consequences

- A child may still send telemetry through the shared workflow binding, but it
  cannot become the parent's restart or next-turn routing target.
- A fresh root must receive its user-prompt hook before its first route can be
  accepted. Missing or stale hook installation therefore fails closed.
- A new TUI attachment to a resident App Server replaces the prior attachment's
  root registration, preserving one active routing owner per managed client.
- A Desktop historical-thread selection can replace its prior root without
  weakening client/root isolation or stranding that root after native refusal.
- Rollback is limited to reverting the root-registration checks and hook
  registration; no remote data or Git history migration is involved.

## Rejected alternatives

- Trusting the first same-client route allowed a nested process to self-elect.
- Trusting only `STATEWRIGHT_CLIENT_ID` repeated the original collision.
- Relying only on process ancestry was platform-sensitive and did not protect
  the resident App Server consumer.
- Treating `resume --last` as a session ID confused a selector with the durable
  thread that Codex resolves at runtime.
- Rebinding inside the pre-forward ownership check stranded the prior valid root
  when native resume failed; prepare/commit/cancel preserves that rollback point.
