# statewright-pi

State machine guardrails for [Pi coding agent](https://pi.dev). Enforces per-state tool restrictions and includes a corrective layer that catches and executes malformed tool calls from local models.

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
2. Save it:
   ```bash
   mkdir -p ~/.statewright
   echo 'sw_live_...' > ~/.statewright/api_key
   ```
3. Start Pi — the extension connects to the managed gateway automatically

## Local model corrective layer

Local models via Ollama need more help than frontier models. The extension handles this at three levels:

**Tool execution recovery.** When models dump tool calls as JSON text instead of structured calls, the extension parses the JSON, executes the intended tool via shell commands, and feeds the result back. The model never needs to retry — its intent is captured and executed regardless of format. Five JSON formats are recognized.

**Bash discernment.** Read-only commands (`ls`, `cat`, `grep`, `git status`) pass through even when Bash isn't in `allowed_tools`. Destructive commands, writes, directory traversal, and scripting interpreters are blocked with specific reasons.

**Tool name normalization.** Maps 25+ tool name variants across Claude Code, OpenAI, Codex, and Rust harness conventions to Pi's native tools (`read`, `edit`, `write`, `bash`, `grep`, `find`, `ls`).

## What it does

- **before_agent_start** — injects phase context with tool signatures, transition hints (retry vs terminal vs advance), and autonomous mode directive
- **tool_call** — blocks unauthorized tools with case-insensitive matching. Allows safe bash through. Blocks everything on final state.
- **tool_result** — tracks state changes, detects file-edit interrupts
- **message_end** — executes malformed tool calls directly, auto-continues stalled models (30s cooldown)

## Development

```bash
npm test          # run tests (vitest, 22 tests)
npm run test:watch
```

## License

FSL-1.1-ALv2 (see plugins/LICENSE.md)
