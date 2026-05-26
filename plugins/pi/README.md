# statewright-pi

State machine guardrails for [Pi coding agent](https://pi.dev). Per-state model routing, thinking level control, native tool restrictions, parallel fork/join, and a corrective layer for local models.

## Install

```bash
pi install /path/to/statewright/plugins/pi
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

**Tool execution recovery.** Parses JSON tool calls from text output, executes via shell. Normalizes edit parameter variants (`{file, old, new}` etc.) to Pi's schema.

**Bash discernment.** Read-only commands pass through. Writes, destructive ops, and scripting interpreters blocked when Edit/Write aren't in allowed_tools.

**Rambling watchdog.** Aborts + steers models that generate text without tool calls. Scaled by thinking level.

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
