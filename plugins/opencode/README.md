# Statewright Plugin for opencode

State machine guardrails for opencode. TypeScript plugin using opencode's native plugin API.

## Setup

1. Build the gateway: `cargo install statewright-gateway`

2. Copy a workflow template:
   ```bash
   mkdir -p .statewright
   cp templates/bugfix/config.json .statewright/config.json
   ```

3. Add MCP server to `opencode.json`:
   ```json
   {
     "mcp": {
       "statewright": {
         "command": "statewright-gateway",
         "args": ["--config", ".statewright/config.json", "--hook-server"]
        },
        "statewright-references": {
          "command": "node",
          "args": [".statewright/reference-mcp.mjs"]
        }
     }
   }
   ```

   Also copy the two local search files into the active project:
   ```bash
   cp plugins/shared/reference-search.mjs plugins/shared/reference-mcp.mjs .statewright/
   ```

4. Install the plugin — either:
   ```bash
   # Project-level
   cp -r plugins/opencode .opencode/plugins/statewright

   # Or in opencode.json
   # "plugins": ["./plugins/opencode"]
   ```

5. Run: `opencode "Fix the staging credential mismatch"`

## How It Works

- `tool.execute.before` — queries gateway, throws to block unauthorized tools
- `tool.execute.after` — increments iteration, detects transitions, shows toast
- `session.created` — shows current state in TUI toast
- `session.idle` — shows completion status
- `statewright_search_references` — companion command MCP that searches the
  active checkout locally, returning bounded provenance-addressable excerpts

## Differences from Claude Code Plugin

| Feature | Claude Code | opencode |
|---|---|---|
| State injection | UserPromptSubmit (user channel) | session.created (toast) |
| Tool blocking | PreToolUse JSON deny | tool.execute.before throw |
| Transition display | additionalContext → Claude reads | tui.toast.show |
| Checkpoint prompt | UserPromptSubmit convention | No equivalent — tool output only |
| Stop behavior | Blocks only for a cached approval gate | `session.idle` prompts review when pending; otherwise advises continuation |

The main gap: opencode has no `UserPromptSubmit` equivalent, so the steering convention ("report transitions in this format") cannot be injected via the high-trust user message channel. Transition reporting relies on the model seeing the `statewright_get_state` tool response and the toast messages.

The reference-search companion does not call the gateway and does not expose
repository contents remotely. Its incremental index excludes ignored,
generated, secret, and credential-like material before a result is returned.
