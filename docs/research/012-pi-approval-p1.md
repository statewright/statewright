# P1 — Pi native approval ownership (design + receipt)

Milestone: "Pi.dev native approval ownership (P1) — journal/resolver shared
with P0; pending approval survives native Pi restart; unprivileged/external
reviewer cannot release; canary."

## Contract (canonical owner: the mcp-gateway Rust engine)

1. A `requires_approval` transition parks the session:
   `SessionManager::set_pending_approval` (session.rs:382). While set:
   - `statewright_transition` denies ("block transitions while an approval is
     pending", gateway.rs:1384).
   - **P1 adds**: `adapter_pre_tool` denies ALL tool traffic with
     `approval_pending: true` + approval id (previously only transitions were
     gated; tool traffic sailed through the normal allowlist).
   - `statewright_get_state` (JSON-RPC and `adapter state`) exposes the
     projection so hosts can observe; it is the resolver long-poll target.
2. Decisions enter only through the authenticated gateway surface
   (`/api/runtime-approval`, Bearer API key + client id; remote.rs) or the
   reviewer's own credential. Hosts (pi extension, bridge, executor) are
   unprivileged: they observe and never submit decisions.
3. Restart survival: the `statewright/paused-session/v1` checkpoint
   (session.rs `checkpoint()`/`from_checkpoint`) serializes
   `pending_approval` and validates it on restore; the executor mirrors P0
   journal ownership via `runtime-approval-service` park/restore/clear keyed
   by (clientId, workflow thread).
4. Host behavior parity with C1 (Claude hook `poll_approval_gate`): while
   parked, the host blocks tool calls, long-polls state, and re-admits the
   pending call only after the gateway reports the approval cleared.

## Slices

- A (Rust): `adapter_pre_tool` pending-approval deny + unit tests.
- B (TS): pi extension park/poll loop in the executor bridge path + parked
  notice on session start; tests with a fake adapter.
- C (JS): statewright-exec approval journal wiring (park/restore/clear) in
  the observer loop and resume path; tests with a fake state stream.
- D (canary): `test:pi-approval-canary` against a local gateway + fake pi
  binary: park proof, unprivileged-release denial, trusted decision re-admit,
  restart survival. Receipt appended below.
