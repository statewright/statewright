# Statewright Plugin for Cursor

State machine guardrails for Cursor IDE. MCP server provides the tools; `.mdc` rule provides the behavioral constraints. Tool enforcement is advisory — Cursor has no hook system to block tool calls, so the rule instructs the agent to self-enforce.

## Setup

1. Build the gateway: `cargo install statewright-gateway`

2. Copy a workflow template: `cp templates/bugfix/config.json .statewright/config.json`

3. Copy the MCP config into your project:
   ```bash
   # Merge into existing .cursor/mcp.json, or:
   cp plugins/cursor/mcp.json .cursor/mcp.json
   ```

4. Copy the rule file:
   ```bash
   mkdir -p .cursor/rules
   cp plugins/cursor/statewright.mdc .cursor/rules/statewright.mdc
   ```

5. Open the project in Cursor. The gateway launches automatically as an MCP server.

## What It Does

| Component | Purpose |
|-----------|---------|
| `mcp.json` | Registers gateway as MCP server, exposes `statewright_get_state` and `statewright_transition` tools |
| `statewright.mdc` | Always-on rule instructing the agent to check state, respect tool restrictions, and follow transitions |

## Limitations vs Claude Code

| Capability | Claude Code | Cursor |
|------------|-------------|--------|
| Tool blocking | Hard enforcement via PreToolUse hook | Advisory only (self-enforcement via rule) |
| Context injection | System-reminder channel (highest trust) | `.mdc` rule (always-on) |
| Stop prevention | Stop hook blocks premature exit | Advisory instruction in rule |
| Status display | Status line in TUI | None |
| Iteration tracking | Gateway-side with checkpoint prompts | Agent must self-check via `statewright_get_state` |

The MCP tools work identically — the gap is enforcement. A well-tuned frontier model follows the `.mdc` instructions reliably enough for most workflows. The state machine still prevents the failure modes; it just can't force the model to comply the way a hook can.
