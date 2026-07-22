# MCP client session isolation

Status: accepted for staging implementation (2026-07-22)

## Context

The streamable HTTP gateway currently keys ordinary requests only by API-key
fingerprint. Two Codex or Claude sessions using the same account therefore
share one mutable `Gateway`: loading, transitioning, pausing, or deactivating a
workflow in one client can change the other client.

The plugins also call the gateway from two paths (the MCP stdio proxy and host
hooks) without a common transport identity. A workflow tool's optional
`session_id` argument then mutates the gateway's internal session key, which
mixes transport identity with run metadata and can compound the leak.

## Decision

1. Plugins derive one opaque client ID from the host's real session identity.
   Explicit `STATEWRIGHT_CLIENT_ID` wins; Codex uses `CODEX_THREAD_ID` then
   `CODEX_SESSION_ID`; Claude uses `CLAUDE_SESSION_ID`/hook `session_id`.
   Values are SHA-256 shortened before leaving the client. A process-ancestry
   fallback replaces the unsafe cwd/default fallback.
2. Both the MCP proxy and hooks send that ID as
   `X-Statewright-Client-Id` on every gateway request. Branch subprocesses may
   additionally send `Mcp-Session-Id: br_<name>`.
3. The gateway derives a canonical session key from the API-key fingerprint
   and client ID. The API-key fingerprint remains the tenant boundary; the
   client ID is the isolation boundary within that tenant. Clients without an
   ID retain the legacy account-scoped session for compatibility.
4. `statewright_load_workflow.session_id` remains accepted as project/run
   metadata for compatibility, but it never changes the transport session.
5. Paused-run lookup is constrained by the canonical transport session and
   project metadata. Inactive status does not expose stale state from the last
   deactivated workflow.

## Rejected alternatives

- Keying only by cwd: two clients in one checkout still collide, and one client
  changing directories can fork its own state.
- Trusting only a tool argument: hooks run outside tool calls and cannot safely
  reconstruct that mutation.
- One `Gateway` per API key with client-specific fields inside it: mutable
  workflow, run, and invocation-stack state would remain easy to cross-wire.

## Acceptance checks

- Same API key plus client A/B IDs produces distinct canonical session keys.
- Repeated calls from one client reuse its key.
- A load/transition/deactivate sequence cannot alter B's workflow or state.
- A workflow load cannot rewrite its gateway transport identity.
- Resume cannot select a paused run from another client or project.
- Codex, Claude, and OMX hook calls carry the same derived ID as their MCP path
  when the host exposes a session/thread ID.
- Staging canary proves A/B isolation and cleans up both test workflows before
  Statewright is re-enabled in an agent session.
