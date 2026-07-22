# MCP session isolation

One Statewright API key can be used by several agent sessions at the same time.
Those sessions share an account and workflow catalog, but they must not share
mutable workflow state. Loading or deactivating a workflow in one terminal
must not move another terminal's state machine.

Statewright enforces two boundaries:

1. The API-key fingerprint identifies the tenant.
2. An opaque MCP client ID identifies one Codex, Claude Code, OMX, or other
   host session inside that tenant.

The plugins derive the client ID from the host's session or thread identifier,
hash it locally, and send it on every gateway request as
`X-Statewright-Client-Id`. Hooks and the MCP proxy use the same resolver, so a
hook refresh reads the workflow used by that terminal's tool calls. Raw host
session IDs are not sent to the gateway.

The gateway combines both identities into a canonical session key and returns
that key in `Mcp-Session-Id`. A repeated request from the same client reuses its
gateway and run state. A different client ID creates a separate gateway even
when the authorization key, repository, and selected workflow are identical.

## Identity resolution

The packaged clients use this order:

1. `STATEWRIGHT_CLIENT_ID`, when an operator supplies an explicit identity;
2. the host's stable session variable, such as `CODEX_THREAD_ID`,
   `CODEX_SESSION_ID`, or `CLAUDE_SESSION_ID`; and
3. a hash of the host process ancestry when the client exposes no session ID.

The fallback is intentionally not based on cwd. Two terminals often work in
the same checkout, and a directory is not a session boundary. Process ancestry
is stable only for the lifetime of that host process; wrappers that need an
identity to survive a host restart should set `STATEWRIGHT_CLIENT_ID`.

Fork subprocesses add a branch `Mcp-Session-Id` under the parent client root.
That keeps two clients' branches distinct even when both use a branch named
`validation`. Client integrations that do not start separate branch MCP
processes can still have the cooperative parallel-fork limitations described
in [Fork/join](fork-join.md).

## Run metadata is not transport identity

`statewright_load_workflow` still accepts `session_id` for compatibility, but
the value is treated as project/run metadata. It cannot rewrite the gateway's
transport session. Paused-run lookup is constrained by the canonical client
session and project metadata, so `resume=true` cannot select another
terminal's paused run.

After `statewright_deactivate`, status reports no current state, iteration, or
usage for that client. The previous in-memory machine cannot be mistaken for
an active workflow, and deactivation does not affect any sibling client.

Clients that send no client identity retain the legacy API-key-scoped session.
That compatibility path is useful for older integrations but does not provide
within-account isolation. Custom clients should send a stable, opaque
`X-Statewright-Client-Id` on every streamable HTTP request and reuse the
canonical `Mcp-Session-Id` returned by the gateway when their MCP transport
supports it.
