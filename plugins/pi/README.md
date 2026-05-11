# Statewright Extension for Pi

State machine guardrails for Pi coding agent. TypeScript extension that registers statewright tools as Pi skills and hooks into tool execution for enforcement.

## Setup

1. Build the gateway: `cargo install statewright-gateway`

2. Copy a workflow template: `cp templates/bugfix/config.json .statewright/config.json`

3. Install the extension:
   ```bash
   cp -r plugins/pi ~/.pi/agent/extensions/statewright
   # Or project-level:
   cp -r plugins/pi .pi/extensions/statewright
   ```

4. Configure MCP server in Pi's config:
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

5. Run: `pi "Fix the staging credential mismatch"`

## What It Does

- Registers `statewright_get_state` and `statewright_transition` as Pi skills
- `onToolBefore` — blocks unauthorized tools, logs transitions
- `onToolAfter` — tracks iterations, detects state changes, logs completion
- Prints state summary on extension load

## Pi-Specific Features

Pi's skill system allows statewright tools to be invoked directly by the agent without MCP. The extension registers them as native Pi skills alongside the MCP server integration, providing redundant access.
