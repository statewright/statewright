# Human review submission status

## Superseding explicit user approval

On 2026-10-03, after the unavailable-dialog finding below, Ben explicitly instructed: "just fix the damn thing with my explicit approval and don't prompt because it's obviously busted", followed by "into staging to do a live fit with everything, not just a bounded slice because this needs to go out the door as a production candidate".

This authorizes delivery of the prepared model-restoration fix through the normal integrated staging release path, coordinated local installation and actual ascodex/TUI and Desktop acceptance. No additional conversational confirmation is required for that scope. Production promotion, new credentials/grants, security or classifier policy changes, and unrelated approval-adapter implementation remain excluded. Native platform review remains in force. The source/package bytes and prior test evidence below are unchanged; subsequent release-controller, installation, runtime and staging outcomes must be recorded separately.

The following is the historical failed submission receipt, not a currently pending approval request.

Candidate remains `41233046011498201f74b6c3b705a22df3dd9282`, package `0.3.4+codex.20261003210723`. This note is separate from the frozen candidate and does not alter its runtime bytes.

Decision scope: review that exact candidate for one coordinated local installation and normal `ascodex` model-restoration acceptance. No production, classifier, security, credential, workflow-definition, or approval-protocol change is included.

Status: **NOT SUBMITTED — native approval entrypoint unavailable for this inactive-session request.** No approval ID, request ID, or human response exists. The earlier statement that approval was pending did not describe a registered request. Neither silence nor the user's instruction to show a dialog is candidate-install approval.

Fresh checks:

- Advertised native Statewright `get_state` returns the exact no-active-workflow response.
- Available native tools expose workflow lifecycle/read operations and thread inspection, not a standalone candidate-review submission operation.
- Installed153800 `scripts/lib/desktop-runtime/runtime-approval-service.mjs:26–36` reads/resolves an existing `approval_id`, `run_id`, and `run_session_id` via `/api/runtime-approval`; it does not create a standalone candidate ticket.
- `plugins/executor/lib/human-approval.mjs:123–138` emits the native `mcpServer/elicitation/request` form only after a matching authoritative ticket is pending and permits this identity to decide. Its cancellation/rejection paths do not authorize execution.
- `plugins/executor/lib/codex-approval-gate.mjs:28–62` requires the saved/hinted approval to match authoritative workflow state.
- Installed153800 route proxy HTTP handler at419–424 exposes health/readiness and otherwise404, not an approval-enqueue control endpoint.
- Current gateway source `crates/mcp-gateway/src/remote.rs:922–929` requires `ensure_pending_approval` to succeed, otherwise404. This is source evidence, not a replayed live request.
- The session execution tool's approval policy is `never`; requesting escalation is unavailable. The clarification UI is explicitly not an authorization channel for this install gate.

No test/fake ticket, journal/marker write, alternate client, new workflow, shell UI injection, runtime restart, credential read, or installation was used to manufacture a dialog. No denied command was retried. Candidate source and its173-test result are unchanged; prior native failure remains a failure.

Required owning component: the local host approval adapter must expose a supported candidate-review submission path independent of workflow activation, bind the exact candidate/action/thread to the native approve/deny/cancel response, and retain a verifiable decision receipt. That interface is not currently advertised to this owner. Adding it is an approval-protocol scope change, not part of the frozen model candidate, and has not been implemented under this request.

Dependent work parked: installation, scoped idle reload, and real TUI/Desktop acceptance. No polling is warranted because no request was submitted. When a supported response arrives, verify its candidate identity and current hashes before consuming it; dismissal, stale identity, or ambiguity must leave installation unapproved.
