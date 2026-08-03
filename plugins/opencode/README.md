# Statewright Plugin for opencode

State machine guardrails for opencode. TypeScript plugin using opencode's native plugin API.

## Executor setup

Launch OpenCode through the shared executor:

```bash
node plugins/executor/statewright-exec.mjs \
  --host opencode --workflow bugfix --cwd "$PWD" -- \
  "Fix the staging credential mismatch"
```

The executor injects the plugin and a loopback Statewright MCP server through `OPENCODE_CONFIG_CONTENT`. OpenCode does not receive the remote API key. The plugin applies the state's provider/model and reasoning variant to outgoing messages, enforces tool policy, reports results to the executor, and uses `session.prompt` to continue a nonfinal workflow in the same OpenCode session.

## Standalone setup

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
- `session.idle` — stops at final/approval states or continues the active workflow in the same session
- `chat.message` — applies the current state model and reasoning variant

## Capability notes

OpenCode has no Claude-style `UserPromptSubmit` hook. Statewright therefore injects state context through the first prompt and subsequent same-session continuation prompts, while toasts provide operator visibility. Tool blocking and model routing are native and enforced; they are not advisory.
