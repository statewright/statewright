# statewright-pi

State machine guardrails for [Pi coding agent](https://pi.dev). TypeScript extension that registers statewright tools and enforces per-state tool restrictions.

## Install

```bash
pi install /path/to/statewright/plugins/pi
```

Or copy to the extensions directory:

```bash
cp -r plugins/pi ~/.pi/agent/extensions/statewright
```

## Setup

1. Get an API key at [statewright.ai/keys](https://statewright.ai/keys)
2. Save it: `echo 'sw_live_...' > ~/.statewright/api_key`
3. Start Pi — the extension connects to the managed gateway automatically

## Usage

The extension is dormant until you activate a workflow:

```
statewright_load_workflow(name='bugfix')
statewright_list_workflows()
```

Once active, the extension enforces which tools are available in each phase, injects workflow context into every turn, and displays state in the status bar.

## What it does

- Registers `statewright_get_state`, `statewright_transition`, `statewright_list_workflows`, `statewright_load_workflow` as Pi tools
- **before_agent_start** — injects phase context, instructions, and autonomous mode directive
- **tool_call** — blocks unauthorized tools with case-insensitive name matching
- **tool_result** — tracks state changes, detects file-edit interrupts
- **message_end** — recovers when local models emit tool calls as JSON text instead of structured calls

## Local model support

Pi + Ollama is a first-class use case. The extension handles two common issues with local models:

**Tool name normalization**: The gateway returns Claude Code tool names (`Read`, `Edit`, `Write`). Pi uses lowercase (`read`, `edit`, `write`). The extension maps between them automatically.

**Tool-call recovery**: Some local models (especially Llama variants via Ollama) intermittently output tool calls as JSON text in the response instead of using the structured tool calling API. The `message_end` hook detects this pattern and nudges the model to retry with native tool calling.

## Development

```bash
npm test          # run tests (vitest)
npm run test:watch
```

## License

FSL-1.1-ALv2 (see plugins/LICENSE.md)
