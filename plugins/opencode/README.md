# Statewright Plugin for opencode

State machine guardrails for opencode. TypeScript plugin using opencode's native plugin API.

## Setup

1. Build the gateway: `cargo install statewright-gateway`

2. Create `.statewright/config.json` in your project:
   ```bash
   mkdir -p .statewright
   cp templates/nine-second-saloon/config.json .statewright/config.json
   ```

3. Add MCP server to `opencode.json`:
   ```json
   {
     "mcp": {
       "statewright": {
         "command": "statewright-gateway",
         "args": ["--config", ".statewright/config.json", "--hook-server"]
       }
     }
   }
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

## Differences from Claude Code Plugin

| Feature | Claude Code | opencode |
|---|---|---|
| State injection | UserPromptSubmit (user channel) | session.created (toast) |
| Tool blocking | PreToolUse JSON deny | tool.execute.before throw |
| Transition display | additionalContext → Claude reads | tui.toast.show |
| Checkpoint prompt | UserPromptSubmit convention | No equivalent — tool output only |
| Stop blocking | Stop hook exit 2 | session.idle (advisory) |

The main gap: opencode has no `UserPromptSubmit` equivalent, so the steering convention ("report transitions in this format") cannot be injected via the high-trust user message channel. Transition reporting relies on the model seeing the `statewright_get_state` tool response and the toast messages.
