# ADR 016: Native queued human input, separate from approval authority

Status: accepted for the bounded source slice; deployment and native visual
acceptance pending. Date: 2026-09-27.

## Context and evidence

The user requested non-blocking questions in the Statewright app shim for both
Desktop and TUI, with visible UI and eventual chat/SMS projection. Both managed
hosts use `startCodexAppServerRuntime` and the same route proxy. Desktop ships a
generated copy; changes must pass `sync-desktop-runtime.mjs --check`.

The installed Codex `app-server generate-json-schema --experimental` contract
has `item/tool/requestUserInput` with required `isBlocking`, `threadId`,
`turnId`, `itemId` and questions, and marks `autoResolutionMs` deprecated in favor
of `isBlocking`. Native `serverRequest/resolved` identifies thread and request.
[Official App Server documentation](https://learn.chatgpt.com/docs/app-server)
(read 2026-09-27) describes request/reply/resolution and notes that resolution
can also mean cleanup, not an answered question. The installed schema is the
stronger evidence for the newer `isBlocking` field. No live model call was used.

## Decision

1. Reuse the native queue, cards and answer delivery. Do not add a parallel queue,
   synthetic reply, auto-answer, approval receipt or workflow transition.
2. Add shared policy as its own plugin `UserPromptSubmit` hook so it is additive
   to native/configured instructions and works with inactive Statewright. A
   `developerInstructions` override was rejected: it can discard configured or
   resumed instructions. Keep capability-dependent behavior explicit.
3. Preserve RPC IDs (including their numeric/string type), thread/turn/item
   identity, options/free text, `isBlocking`, replies and resolution events.
   Set the nullable, default-null legacy `autoResolutionMs` field to null only
   for an explicitly non-blocking native question. Never relabel a blocking or
   unknown request. Native timer behavior remains a fresh-session acceptance
   gate; source tests establish the forwarded contract, not renderer timing.
4. Questions gate dependent work; independent work must already be authorized.
   Answers are information, not privileged Statewright approval capabilities.
   Required unanswered decisions prevent claiming the affected work complete.
5. Persist pending decision/scope in the existing task/handoff. The native queue
   is not promised durable beyond its own lifecycle. A cleared card is not proof
   of an answer. On resume, revalidate scope and native pending state before
   applying an answer or reissuing a necessary question.

## Future remote projection boundary (not implemented)

A transport adapter may project an outstanding native question to chat/SMS only
with explicit delivery authorization. Bind it to an authenticated responder and
an opaque projection ID resolving to the native request ID, thread, turn, item,
and Statewright run/state epoch when one exists; include affected task/scope,
request fingerprint, expiry, and original channel. Never infer scope from a
phone number or free-text "yes" alone. Revalidate current ownership, pending
status, fingerprint and expiry at submission. Deduplicate channel retries and
concurrent local/remote responses; reject stale, replayed or revoked submissions.
Track pending, response-submitted, resolved/cleared, expired and cancelled
separately. The native lifecycle remains authoritative for delivery, and the
existing authenticated approval service remains authoritative for permission.

Question/answer content can contain private data. No new telemetry or raw
question ledger is added. Remote projection requires consent and a data policy,
redacted notifications by default, controlled retention and no credentials in
SMS. The projection contract needs its own schema and tests before enabling it.

## Validation, rollout and rollback

Focused tests exercise canonical TUI and packaged Desktop proxies over local
WebSockets, concurrent questions and progress, out-of-order answers, numeric
versus string IDs, a server-question/client-response ID collision, dismissal,
and blocking/approval preservation. Hook tests use
an empty environment and do not need credentials. These are transport contracts,
not proof that either native renderer displayed or persisted a card.

Source change only: do not restart active sessions, publish or deploy production.
Install only through the separately authorized local-plugin release path, then
validate in fresh Desktop and TUI sessions. Rollback the coherent commit and
regenerate the Desktop bundle before the next installation; do not edit the
generated copy alone. Revisit if native lifecycle or host hook support changes.
