# Statewright Plugin for Codex CLI

State machine guardrails for OpenAI Codex CLI.

## Setup

1. Install the gateway: `cargo install statewright-gateway`
2. Create `.statewright/config.json` in your project
3. Add the MCP server to `~/.codex/config.toml`:
   ```toml
   [mcp.statewright]
   command = "statewright-gateway"
   args = ["--config", ".statewright/config.json", "--hook-server"]
   ```
4. Copy `hooks.json` to `~/.codex/hooks.json` or merge into existing hooks

## Limitations

Codex CLI's PreToolUse hook cannot inject `additionalContext` (issue #19385). Checkpoint prompts are injected via UserPromptSubmit instead. Tool blocking works identically to Claude Code.
