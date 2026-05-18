# Statewright Plugin for Codex CLI

State machine guardrails for OpenAI Codex CLI. Per-state tool enforcement, interrupts, fork/join, approval gates.

## Setup (Managed Cloud)

1. Sign up at [statewright.ai](https://statewright.ai) and generate an API key
2. Save the key: `mkdir -p ~/.statewright && echo "YOUR_KEY" > ~/.statewright/api_key`
3. Add the MCP server:
   ```bash
   codex mcp add statewright -- bash /path/to/plugins/codex/mcp-proxy.sh
   ```
4. Merge `hooks.json` into `~/.codex/hooks.json`
5. Start a workflow: use `statewright_load_workflow` MCP tool

## Hook Events

- **UserPromptSubmit**: injects workflow state, tools, instructions, autonomous mode directive
- **PreToolUse**: enforces allowed_tools per state, bash discernment, command whitelisting
- **PostToolUse**: interrupt detection (file pattern matching), fork/join status, capture
- **Stop**: no-op (workflow persists across turns)

## Differences from Claude Code Plugin

- `tool_response` field instead of `tool_result` in PostToolUse
- `apply_patch` matched alongside `Edit` for interrupt detection
- `CODEX_SESSION_ID` env var for session scoping

## License

FSL-1.1-ALv2 (see plugins/LICENSE.md)
