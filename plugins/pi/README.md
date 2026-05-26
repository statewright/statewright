# statewright-pi

State machine guardrails for [Pi coding agent](https://pi.dev). Enforces which tools the model can use in each workflow phase at the API layer — the model can't see restricted tools, not just told not to use them. Routes models per state, controls reasoning effort, dispatches parallel fork branches, and includes a corrective layer for local models that struggle with structured tool calling.

## Install

```bash
cp -r plugins/pi ~/.pi/agent/extensions/statewright
```

Or add to `~/.pi/agent/settings.json`:

```json
{ "extensions": ["path/to/statewright/plugins/pi"] }
```

## Setup

1. Get an API key at [statewright.ai/keys](https://statewright.ai/keys)
2. Save it:
   ```bash
   mkdir -p ~/.statewright
   echo 'sw_live_...' > ~/.statewright/api_key
   ```
3. Start Pi — the extension connects automatically

## Features

### Per-state model routing

Switch models per workflow state. Frontier plans, commodity executes.

```json
"planning":      { "model": "openai-codex/gpt-5.5" },
"implementing":  { "model": "ollama-qwen/qwen3.6:35b" },
"testing":       { "model": "ollama/gemma4:31b" }
```

### Per-state thinking level

Control reasoning effort. `xhigh` for planning, `off` for grunt work.

```json
"planning":      { "thinking_level": "xhigh" },
"implementing":  { "thinking_level": "off" }
```

### Native tool restrictions

Tools not in `allowed_tools` are removed from the schema — the model can't see them.

### Parallel fork/join

`statewright_fork` spawns parallel Pi subprocesses, one per branch. Each gets its own gateway session, model, and tools.

### `/statewright` command

`/statewright load <name>`, `/statewright deactivate`, `/statewright list`, `/statewright status`

## Local model corrective layer

When local models dump tool calls as JSON text instead of structured calls, the plugin parses the JSON and executes the intended tool directly — the model never needs to retry. Edit parameter variants (`{file, old, new}`, `{path, old_text, new_text}`, etc.) are normalized to Pi's schema automatically.

Bash commands are classified: read-only commands (`ls`, `cat`, `pytest`) pass through even in restricted states, but writes, destructive ops, and scripting interpreters are blocked when Edit/Write aren't in allowed_tools.

If the model generates text for 30 seconds without calling a tool, the plugin aborts the stream, injects a steering message with available tools and transitions, and triggers a follow-up turn. States with thinking levels get 90 seconds instead.

## Development

```bash
cd plugins/pi
npm test           # 33 tests (vitest)
npm run test:watch
```

Debug logging: `STATEWRIGHT_DEBUG=1 pi`

Full docs: [docs/guides/pi-plugin.md](../../docs/guides/pi-plugin.md)

## License

FSL-1.1-ALv2 (see plugins/LICENSE.md)
