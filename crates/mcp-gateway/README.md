# statewright-mcp-gateway

MCP proxy server that enforces state machine guardrails on LLM agent tool access. Sits between your agent (Claude Code, Codex, Pi, opencode) and its tools, blocking calls that violate the current workflow phase.

Supports stdio transport (local) and HTTP+SSE transport (remote/self-hosted).

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
