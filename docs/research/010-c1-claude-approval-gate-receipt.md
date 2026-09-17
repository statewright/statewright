# C1 Claude Code Approval-Gate Receipt

Date: 2026-06-28. Local evidence cut for the Claude Code milestone slice:
Statewright approval gates now park the Claude Code plugin's hook stack
(`plugins/claude-code/hook.sh`) instead of silently auto-resolving, and a
new shell test suite proves the parked/resume contract against a fake
loopback gateway.

## What changed

- `poll_approval_gate`: while a state carries `pending_approval`, Pre-tool
  hooks poll `statewright_get_state` through the Statewright MCP gateway
  for up to `STATEWRIGHT_APPROVAL_POLL_TIMEOUT` seconds (default 15). A
  resolved approval re-enforces against the fresh state (final states deny
  further tool use); a still-pending gate denies the tool call and names
  the approval id. Managed-bridge sessions (`STATEWRIGHT_ADAPTER_URL` set)
  return without polling: the executor bridge owns their gate lifecycle.
- User-prompt hooks surface an explicit APPROVAL GATE notice naming the
  pending approval and the review surface, and keep the notice in
  autonomous-mode context.
- Gateway-unreachable handling no longer wipes the cached parked state:
  while an approval is pending the cache is kept and enforcement stays
  on; only approval-free sessions fall back to unenforced mode.
- Permission-request hooks pass pending approvals through with context
  and never auto-allow or auto-deny through the permission stack.

## Proven (this host, macOS)

- `plugins/claude-code/tests/approval-gate.test.sh` (new, 5 cases):
  pre-tool deny while pending with the approval id; user-prompt gate
  notice; permission-request pass-through; pre-tool polling that resumes
  enforcement and refreshes the session state cache once the fake
  gateway reports the approval decided; and a control case proving
  approval-free behavior is unchanged. The fake gateway is a loopback
  HTTP server returning canned JSON-RPC `statewright_get_state`
  responses (pending-autonomous, pending, approved), in compact state
  text matching the session cache contract.
- Sibling suites re-run green against the reworked hook:
  bash-discernment, client-id, setup (shell) and executor-bridge,
  managed-client-bundle, managed-routing, runtime-sync,
  transcript-telemetry, windows-launch-resolution (node:test).

## Not proven (gated, recorded per receipt convention)

- Live Claude Code vendor sessions: no interactive `claude` session was
  run against a real Statewright gateway, so end-to-end hook delivery,
  hook timeouts inside a real session, and the human approval flow in
  the Statewright dashboard remain untested here.
- Managed-bridge gate lifecycle: the early-return branch that defers to
  `STATEWRIGHT_ADAPTER_URL` is exercised only by the executor-bridge
  suite, not by this shell fixture.
- Windows: the hook is POSIX shell; no Windows Claude Code claim is made.

## Verification boundary

Claims above cover the hook stack and its fixture on this macOS host.
They do not cover vendor hook delivery, hosted CI, or any approval
decided outside the fixture.
