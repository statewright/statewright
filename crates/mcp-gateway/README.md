# statewright-mcp-gateway

MCP proxy server that enforces state machine guardrails on LLM agent tool access. Sits between your agent (Claude Code, Codex, Pi, opencode) and its tools, blocking calls that violate the current workflow phase.

Supports stdio transport (local) and HTTP+SSE transport (remote/self-hosted).

### Native conversation control (experimental)

The remote transport can expose `statewright_native_request` to a registered
native OAuth client when its authorization service returns a verified native
identity. Each call carries version 1 context with the host's current conversation
UUID. Workflows are scoped to the authenticated owner, grant family, client,
resource and conversation—not the access token or HTTP connection. Token refresh
preserves that scope; a new authorization grant starts a separate scope.

`get_state` returns an opaque revision. `load_workflow`, `transition` and
`deactivate` require that revision; after an uncertain response, read state before
deciding what to do next. Discovery and deactivation remain available if the
workflow catalog becomes empty. Native clients cannot fall back to unscoped
workflow calls or legacy SSE.

Experimental `request_approval` accepts only `run_id` and `approval_id`, plus the
current conversation/revision. It requires an initialized, authenticated MCP
transport with form-elicitation support and a durable pending run. The gateway
projects the request through its existing approval service, checks reviewer
authorization, then holds an SSE request for the native human form. A tool
argument cannot approve. Replies are one-use and bound to the transport, grant,
conversation, pending transition and revision. Cancellation leaves the workflow
pending; switching it off invalidates the prompt. After an uncertain decision,
read state and request the exact pending approval again: service preflight
reconciles an already committed decision without prompting or resubmitting it.
Registered transports expire after an hour of inactivity; prompts after three
minutes. Native control's headerless v1 compatibility does not support approval.

This is not yet a complete native execution adapter. End-to-end capability flags
for native tool enforcement, human approval and model routing remain false until
the host adapter is integrated and accepted. It exposes no decision operation. Native
conversation state currently survives client reconnects while the gateway is
running; durable native recovery after gateway replacement is not implemented.
Existing API-key/Codex/web transport paths retain their existing behavior.

```bash
# Install
cargo install statewright-mcp-gateway

# Run with local config
statewright-gateway --config workflow.json --hook-server

# Run as remote transport (self-hosted)
statewright-gateway --remote --pb-url http://localhost:8090
```

FSL-1.1-ALv2 (converts to Apache 2.0 on May 3, 2029).

[docs.statewright.ai](https://docs.statewright.ai) | [GitHub](https://github.com/statewright/statewright)
