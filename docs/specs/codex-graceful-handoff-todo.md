# TODO: Codex graceful handoff and Desktop scroll continuity

Status: proposed upstream feature request; not submitted or implemented.
Created: 2026-10-10.
Owner: Statewright maintainers; native capability requires Codex support.
Release disposition: known, non-blocking auto-scroll limitation for 0.3.4,
provided the remaining functional acceptance checks pass. This is not release
approval or a claim that those checks have passed.

## Problem

Statewright Arbiter changes models and workflow phases by interrupting the
outgoing native turn and starting a successor. Desktop can stop following the
bottom of the conversation across that boundary. The user can manually jump
to the bottom, but repeated handoffs make the experience awkward.

The integration needs a supported lifecycle capability, not fabricated final
messages, suppressed terminal events, UI automation, or signed-app patches.
A hook is one possible interface; the required behavior matters more than its
name or shape.

## Proposed upstream request

**Title: Support graceful App Server turn handoffs and preserve Desktop follow intent**

External orchestrators need to finish an active turn before switching models
or workflow phases. Provide a native operation that stops admitting new tool
work, allows a genuine final summary, and emits normal completion. Associate
the successor with that handoff so Desktop can preserve bottom-follow when
the user was already following, without overriding intentional upward scroll.

These are separable capabilities: graceful completion does not by itself
prove or guarantee renderer continuity. A supported continuation relationship
could also address scrolling independently of the model's final response.

## Required behavior

- Advertise capability/version support; reject unsupported requests explicitly.
- Bind a finish request to the expected thread and active turn. Stale, foreign,
  repeated and concurrent requests must have deterministic outcomes.
- Atomically close admission for new tool work across native, MCP, hosted and
  specialized paths, including input into existing execution sessions.
- Define how already-admitted work is drained or cancelled before completion;
  do not imply that disabling future model tool calls cancels existing work.
- Permit a real tools-disabled closing response in the outgoing turn, with a
  deadline and explicit cancellation/failure behavior. Prompt text alone is
  not an enforcement boundary.
- Emit authoritative native terminal events. Start a differently routed
  successor only after completion and route/ownership revalidation.
- Preserve queued user input, approvals, usage attribution and model restoration.
- Preserve follow intent only for the matching continuation. Respect upward
  scrolling, navigation, cancellation and intervening manual turns.
- Keep the capability environment-independent: staging first for validation,
  then eligible for production/dev, without gateway-hostname special cases.

## Existing evidence and limits

Recorded in commit `645ab52`; not rerun while authoring this spec:

- Bundled `codex-cli 0.159.0-alpha.12.1` exposes no tool-choice field in the
  inspected native turn-start, turn-steer or settings-update schemas.
- Supplying both `tool_choice: "none"` and `toolChoice: "none"` together was
  acknowledged, but the downstream requests still carried `auto`. This does
  not separately characterize each spelling.
- A deterministic loopback provider caused registered harmless fixture tools
  to dispatch, including a second call from a request made after steering.
  This proves native protocol/dispatch behavior, not real-model behavior.
- Earlier isolated renderer tests supported preserving active follow through
  a genuine final answer before idle. They did not establish live UI acceptance.
- Hook-only enforcement was rejected. The user requires native enforcement
  before enabling even a bounded graceful-handoff staging canary.

References:

- [Detailed investigation and receipts](../research/0.3.4-desktop-usage-repair.md)
- [Opt-in native protocol probe](../research/fixtures/native-tool-choice-probe.mjs)
- [Native terminal presentation constraints](../adr/005-app-server-handoff-presentation.md)
- [Official App Server documentation](https://learn.chatgpt.com/docs/app-server)

## TODO and acceptance

- [ ] Prepare a sanitized upstream issue from this spec; check for duplicates
  and confirm the submission destination. Record the issue URL after submission.
- [ ] Obtain documented native support; verify effective enforcement rather
  than treating an RPC acknowledgement as evidence of support.
- [ ] Test all tool paths, already-running work, cancellation, stale ownership,
  duplicate requests, timeout and failure behavior.
- [ ] Verify final response and native completion precede successor generation;
  preserve routing, original-model restoration, telemetry and queued input.
- [ ] Run staging Desktop acceptance: bottom-pinned, deliberately scrolled up,
  cancelled/failed handoff, restored history, cross-thread and repeated phases.
- [ ] Record installed artifact identity and visible behavior. Reuse protocol
  tests as supporting evidence, not as a substitute for live scrolling proof.
- [ ] Enable outside staging only after acceptance; retain a rollback path to
  the current hard handoff.

Until then, leave the working hard handoff unchanged and document manual
jump-to-bottom as the UX workaround. This TODO authorizes no external issue
submission, runtime installation, deployment or change to approval policy.
