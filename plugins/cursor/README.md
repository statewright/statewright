# Statewright Plugin for Cursor

State machine guardrails for Cursor IDE. MCP server provides the tools; `.mdc` rule provides the behavioral constraints. Tool enforcement is advisory — Cursor has no hook system to block tool calls, so the rule instructs the agent to self-enforce.

## Setup

1. Build the gateway: `cargo install statewright-gateway`

2. Copy a workflow template: `cp templates/bugfix/config.json .statewright/config.json`

   Copy the local reference-MCP companion alongside it (both files are needed):
   ```bash
   cp plugins/shared/reference-search.mjs plugins/shared/reference-mcp.mjs .statewright/
   ```

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
| `mcp.json` | Registers the local workflow engine plus `statewright_search_references`, a local-only repository search MCP |
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

`statewright_search_references(query)` indexes and searches only the active
checkout. It returns provenance and bounded excerpts; ignored, generated, and
credential-like content is excluded before results leave the local process.
