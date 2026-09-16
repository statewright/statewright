# ADR 005: Statewright owns app-server handoff presentation

Status: Accepted for the shim-only slice; native interruption-banner replacement deferred.

2026-09-15 amendment: qualifying Sol/Astra and OpenAI/Qwen hard interruptions
receive an exact-turn-correlated `[statewright] switching from …=>…, hard interrupt required`
warning immediately before the untouched native terminal. See
[implementation, native proof and provider-compaction blocker](../research/003-hard-interrupt-preface.md).
Cross-provider protocol switching passes, but native OpenAI/Qwen compaction
compatibility remains unresolved; this amendment does not assert that path is usable.

## Scope

Statewright's executor app-server shim owns workflow presentation. The Qwen-only
`codex-local-models` plugin is not the owner and has no changes from this work.
No workflow activation, live-session restart, global installation or vendor fork
is part of this slice.

The implementation was isolated on `fix/app-server-handoff-status`, based on
`23d9372`, a snapshot of the primary checkout's existing route work. That snapshot
is not part of this change. Only the subsequent handoff diff is integrated into
the primary checkout, preserving unrelated edits.

## Decision

The shared `app-server-handoff.mjs` module is called by Statewright's native
`codex-app-server-route-proxy.mjs`. It reports a routed start only after the exact
request's successful response identifies the accepted turn and that turn has
started. A different thread, writer, stale request or rejected start cannot
receive the status. Cancellation caused by a failed request is request-scoped;
explicit operator activity supersedes the thread's pending presentation.

The native transcript receives an explicitly supervisor-authored commentary
item, for example `Statewright supervisor: intake · gpt-6-astra / high · running`.
The item has the timestamp fields required by Codex 0.153.4. If model output has
already begun before the acceptance response arrives, only structured telemetry
is emitted: inserting a commentary completion could finalize Codex's active
answer stream. No user prompt or provider history is rewritten.

The same callback feeds executor telemetry as `app_server_handoff_status`:

```json
{
  "schema": "statewright/app-server-handoff/v1",
  "source": "statewright",
  "thread_id": "thread-id",
  "turn_id": "accepted-turn-id",
  "run_id": "workflow-run-id",
  "phase": "running",
  "from_state": null,
  "state": "intake",
  "model": "gpt-6-astra",
  "effort": "high",
  "text": "intake · gpt-6-astra / high · running"
}
```

Transport telemetry adds its managed `client_id`. This is a shared event seam,
not a claim that a separate desktop UI consumer has been implemented. Presentation
callback failure cannot stop protocol delivery. Runtime provenance includes the
new module so a changed presentation implementation cannot reuse an old resident
as if its source bundle matched.

Only the exact recorded-model/resume-model advisory for an in-flight internal
provider switch is buffered. It is suppressed only after the resumed thread ID,
provider and model are verified and the same presentation scope still owns the
switch. Failed or superseded switches replay it; all unrelated warnings pass
through. Unknown future warning wording also passes through.

## Why the red interruption banner remains

The stock TUI's interrupted terminal performs lifecycle cleanup and restores
locally queued drafts. Those drafts need not produce an app-server request, so
the shim cannot establish that hiding the terminal is safe. An early coalescing
prototype rendered neutral handoffs and preserved basic Escape/failure handling,
but was removed after independent review identified this invisible-input gap.
Every original terminal now passes through unchanged, including real errors.

Replacing only that banner requires a client protocol/renderer capability that
keeps interruption cleanup while selecting supervisor-specific presentation.
No such remote control was found in the inspected Codex 0.153.4 source. Its
internal `InterruptedTurnNoticeMode::Suppress` is not exposed as an app-server
setting. This work does not claim the complete red-banner UX is delivered.

Source inspected: Codex `rust-v0.153.4`, `chatwidget/input_restore.rs`,
`chatwidget/protocol.rs`, `chatwidget/streaming.rs`, and protocol v2 item types.
Protocol reference: https://learn.chatgpt.com/docs/app-server

## Validation

- Shared presentation and WebSocket shim tests cover hosted routing, provider
  switching, rejected/foreign resume, both response orderings, another writer,
  late streaming, stale-request cancellation, native terminal/input preservation,
  exact warning replacement and failing telemetry.
- Targeted command: `node --test plugins/executor/tests/app-server-handoff*.test.mjs plugins/executor/tests/codex-app-server-transport.test.mjs plugins/executor/tests/proxy-feature-parity.test.mjs`.
  Result: 64 tests passed, zero failures.
- A real Codex 0.153.4 TUI against `tests/probe-handoff-tui.mjs` rendered the
  supervisor commentary, preserved the red interruption banner, suppressed the
  expected switch advisory, completed the successor, and accepted a follow-up
  prompt. The earlier prototype also exercised Escape and failed handoff errors.
  This uses a fresh temporary home and intercepted scripted turns: no inference,
  tool execution, existing-thread attachment or live workflow acceptance claim.
- The broad executor suite encountered an existing public-repository scrub
  failure for private-host references; the same test failed in the untouched
  primary checkout. No scrub rules or unrelated files were weakened.
- Independent review's request-attribution and late-stream concerns were fixed
  with regression tests. The queued-draft concern was resolved by removing all
  terminal coalescing, not by claiming an unobservable draft was absent.

Live processes retain their loaded code. Adoption is through the normal managed
runtime lifecycle; this change does not retire or restart a user's active session.
