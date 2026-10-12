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

This is a workflow-control foundation, not a complete native execution adapter.
The response explicitly reports native tool enforcement, human elicitation and
model routing as unavailable. It exposes no approval decision operation. Native
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
