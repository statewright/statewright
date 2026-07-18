# statewright-omx

State machine guardrails for [Oh My Codex (OMX)](https://github.com/Yeachan-Heo/oh-my-codex).

Enforces per-state tool restrictions, interrupts, fork/join, and approval gates via Codex native hooks. Talks to the statewright managed gateway — no local engine required.

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

State cache is file-based (`~/.statewright/sessions/`) so PreToolUse enforcement requires zero network calls.

## Development

```bash
npm test          # run tests
npm run test:watch # watch mode
npm run build     # compile to dist/hook.js
```
