# statewright-omx

State machine guardrails for [Oh My Codex (OMX)](https://github.com/Yeachan-Heo/oh-my-codex).

Enforces per-state tool restrictions, interrupts, fork/join, and approval gates via Codex native hooks. In executor mode, all hooks and MCP calls use the shared executor's authenticated loopback bridge.

## Install

```bash
# Clone or download the plugin
git clone https://github.com/statewright/statewright.git
cd statewright/plugins/omx

# Install and build
npm install
npm run build

# Register hooks in .codex/hooks.json
bash install.sh
```

## Setup

1. Get an API key at [statewright.ai/keys](https://statewright.ai/keys)
2. Save it: `echo 'sw_live_...' > ~/.statewright/api_key`
3. Start OMX — the plugin activates automatically

For executor-owned delivery, credentials, telemetry, and startup routing:

```bash
node plugins/executor/statewright-exec.mjs \
  --host omx --workflow bugfix --cwd "$PWD" -- \
  "Fix the failing tests"
```

OMX receives the state's model and reasoning effort at process startup. Its native hooks provide hard tool enforcement, but OMX does not currently expose a proven same-session route-change API. Statewright does not claim live routing for this host.

The executor launches OMX through its native Codex plugin installation. It does not pass Claude/Cursor-style `--plugin-dir`; Codex does not support that flag. The Statewright Codex hooks detect the per-run authenticated adapter connection, while the executor explicitly binds Codex's `statewright` MCP server to its loopback proxy. OMX therefore inherits the same session ownership, native tool enforcement, continuation, and telemetry path as Codex without depending on ambient plugin configuration.

## Usage

The plugin is dormant until you activate a workflow:

```
statewright_start(workflow='bugfix')
statewright_list_workflows()
```

Once active, the plugin enforces which tools are available in each phase and injects workflow context into every turn.

## How it works

Registers four Codex native hooks via `.codex/hooks.json`:

- **UserPromptSubmit** — fetches current state from gateway, injects phase context
- **PreToolUse** — blocks tools not allowed in the current phase
- **PostToolUse** — tracks statewright tool calls, detects file-edit interrupts
- **Stop** — blocks Codex from yielding while an active workflow is nonfinal,
  injects the current phase context again, and permits stopping only after a
  final state (or when no reliable state is available).

Standalone mode uses the file cache under `~/.statewright/sessions/`. Executor mode sends hook decisions through the loopback adapter and keeps the remote credential and workflow session in `statewright-exec`.

## Development

```bash
npm test          # run tests
npm run test:watch # watch mode
npm run build     # compile to dist/hook.js
```
