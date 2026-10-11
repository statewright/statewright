# Classifier approval handoff: public contract and test matrix

## Scope and evidence boundary

This packet covers the Statewright Codex 0.3.4 classifier fallback approval
contract and public adapter code. It does not authorize installation,
deployment, release, replay of a denied command, or a workflow-policy change.
Private host implementations, incident transcripts and product-roadmap
decisions are excluded from this public summary.

This is a redacted summary of the historical investigation, not fresh runtime
verification. Source and loopback protocol tests are distinct from visible
Desktop/TUI acceptance.

## Public implementation boundary

The shared implementation lives in:

- `plugins/executor/lib/classifier-approval-controller.mjs`
- `plugins/executor/lib/approval-pipeline.mjs`
- `plugins/executor/lib/codex-app-server-route-proxy.mjs`
- The Codex hook and its generated shared-runtime bundle.

The gateway supplies authoritative workflow context and approval eligibility.
The native host adapter owns exact thread/session correlation, presentation,
and the bound response. Neither the hook nor the host may reclassify a denied
command, widen eligibility, bypass host policy, or revive terminal workflow state.

## Required invariants

1. Only an explicitly eligible uncertainty receipt can request separate human
   approval. Capability, classifier-policy and known-risk denials remain closed.
2. Bind thread, run, run session, state, state epoch, intent, invocation, denial
   basis, authority and retry policy. Changed or missing identity denies.
3. Forward redacted fingerprints, not raw command text or tool arguments.
4. Exact invocation replay does not consume another rework slot. One matching
   native accept releases only the exact pending invocation, once.
5. Re-read authoritative state before consuming acceptance. Missing, inactive,
   terminal, changed-run or changed-state snapshots deny.
6. Timeout, dismissal, disconnect, malformed response, concurrent ownership and
   transport failure never imply approval.
7. Invocation approval is separate from workflow-transition approval and
   lifecycle recovery. A classifier response cannot resume a blocked workflow.

## Ordered handler outcomes

Handlers run serially inside a legitimately intercepted adapter request.
Only `NotHandled` advances to the next handler. `Deny`, `AskPending`,
`Allow` and `Error` stop traversal. An unavailable applicable handler is
an error, not permission to try a more permissive path.

| Request class | All optional handlers decline ownership |
| --- | --- |
| Optional protocol projection | Forward unchanged; grant no new authority |
| Protected classifier invocation | Deny as unsupported; no implicit approval |
| Required workflow transition | Keep parked and report the unresolved gate |

Native host policy remains authoritative. An adapter's allow cannot override
another plugin or the host denying a call.

## Protocol compatibility

The loopback-authenticated `POST /classifier-approval` interface uses
`statewright/classifier-approval-request/v2` and
`statewright/classifier-approval/v2`. Both sides must bind the full identity
tuple. Version mismatch fails closed; a compatibility path must not strip
run-session or state-epoch fields.

The public shared App Server proxy supports standalone-resident and Desktop
ownership. Exact initialized connection and durable thread ownership select
the handler; zero or multiple owners deny. Process-scoped endpoint receipts
are local capabilities, not publicly accessible approval URLs.

## Validation matrix

| Area | Cases | Expected result |
| --- | --- | --- |
| Eligibility | Missing/false eligibility, wrong authority, unsupported basis | No human request |
| Redaction | Raw commands/arguments in upstream receipt | Never forwarded |
| Identity | Mutation of any bound field | Deny |
| Replay | Duplicate invocation or stale response ID | No extra approval or release |
| Lifecycle | State drift, terminal state, disconnect, restart | Fail closed |
| Human response | Accept, decline, cancel, malformed, timeout | Exact one-use accept only |
| Ownership | Concurrent call, foreign thread, zero/multiple owners | Deny |
| HTTP surface | Wrong auth/method, browser Origin | Reject |
| Pipeline | NotHandled, pending, explicit deny, error, exhaustion | Defined ordering above |
| Host composition | Host or another plugin denies | Preserve denial |
| UI acceptance | Real native prompt, click, cancellation, delayed response | Separately witnessed |

Historical unit coverage established receipt eligibility, redaction, retry
accounting, identity binding and lifecycle behavior. Loopback HTTP/WebSocket
fixtures with a mock native client established routing and correlation.
Neither proves the vendor rendered a prompt or that staging loaded the
candidate. Live accept/cancel/restart/stale-reply checks remain separate gates.

## Host capability limits

The historical documentation review found that hook schemas alone were not
sufficient evidence of interactive approval support. Each adapter must prove
interception, hold, native presentation, response binding and single-use
release on its supported runtime. Unsupported paths must say so; no host
inherits another host's coverage.

References consulted in the historical investigation (2026-10-02):

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Cursor hooks](https://prod.cursor.com/docs/hooks)
- [Claude hooks](https://code.claude.com/docs/en/hooks)
- [Claude Mods events](https://code.claude.com/docs/en/plugins/mods/events)

These references and the historical tests were not refreshed during the
public-document boundary scrub.
