# Pi Plugin

AI agents ignore tool restrictions given via prompts. The Pi plugin enforces state machine constraints at the API layer — the model cannot see or call tools that aren't allowed in the current workflow phase. It also routes models per state, controls reasoning effort, and dispatches parallel fork branches.

## Installation

The plugin loads from `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["path/to/statewright/plugins/pi"]
}
```

## Per-State Model Routing

Define `model` on any state to switch the active model when entering that state:

```json
{
  "meta": { "default_model": "openai-codex/gpt-5.4" },
  "states": {
    "planning": { "model": "openai-codex/gpt-5.5" },
    "implementing": { "model": "ollama-qwen/qwen3.6:35b" },
    "testing": { "model": "ollama/gemma4:31b" }
  }
}
```

- States without `model` inherit `meta.default_model`
- If neither is set, Pi's current model is unchanged
- The original model is saved and restored when entering a state with no model
- Cross-provider switching works: openai-codex, ollama, anthropic

### Model Format

`provider/model-id` as registered in Pi's model registry or `~/.pi/agent/models.json`:

- `openai-codex/gpt-5.5` — ChatGPT subscription
- `ollama-qwen/qwen3.6:35b` — custom ollama provider
- `ollama/gemma4:31b` — custom ollama provider

### Custom Ollama Providers

Add to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "https://your-ollama-host/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{
        "id": "gemma4:31b",
        "name": "Gemma 4 31B",
        "contextWindow": 32768,
        "maxTokens": 4096,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
      }]
    }
  }
}
```

### Model Size Requirements

Models below ~7B parameters generally lack reliable tool calling. They tend to dump JSON as text instead of structured tool calls, ignore transition instructions, or spiral on multi-step tasks. The Pi plugin includes a tool call recovery layer (`message_end` handler) that parses JSON tool calls from text output and executes them, but this is best-effort.

Recommended minimums by workflow phase:

| Phase | Minimum | Why |
|---|---|---|
| Planning / analysis | 20B+ | Needs to reason about codebase, identify bugs, plan branches |
| Implementing / editing | 7B+ | Must follow edit instructions precisely, call tools correctly |
| Testing / validation | 4B+ | Mostly running commands and reading output |
| Fork branches | 7B+ | Must operate independently without human correction |

Ultra-small models (< 4B) are usable for tier 3 bash discernment classification (structured JSON output with constrained schema) but not as primary agents in workflow states.

If routing to a local model that struggles with tool calling, set `"thinking_level": "off"` on that state — thinking tokens consume context and degrade small model performance further.

## Per-State Thinking Level

Control reasoning effort per state:

```json
"planning": { "thinking_level": "xhigh" },
"implementing": { "thinking_level": "off" }
```

Valid levels depend on the model's `thinkingLevelMap`. Common: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. The plugin warns if a level is clamped by the model.

## Native Tool Restrictions

The plugin calls `setActiveTools()` to restrict Pi's tool schema per state. Tools not in `allowed_tools` are removed from the LLM's schema entirely — the model can't hallucinate calls to tools it doesn't see.

```json
"planning": { "allowed_tools": ["Read", "Grep", "Glob", "Bash"] },
"implementing": { "allowed_tools": ["Read", "Edit", "Write", "Bash"] }
```

Statewright tools (`statewright_*`) are always available regardless of `allowed_tools`.

### Bash Discernment

When `Bash` is in `allowed_tools` but `Edit`/`Write` are not, the plugin blocks:
- Output redirects (`>`, `>>`)
- Scripting interpreters (`python`, `node`, `ruby`, `perl`) — they can write files
- Destructive commands (`rm`, `rmdir`, `shred`)
- Directory traversal (`cd`, `..`)

Safe read-only commands (`ls`, `cat`, `grep`, `pytest`, `cargo test`) pass through.

## Parallel Fork/Join

The `statewright_fork` tool spawns parallel Pi subprocesses:

1. The model calls `statewright_fork` with branch tasks
2. The plugin fires the engine FORK transition
3. Spawns one Pi subprocess per branch with its own gateway session
4. Each branch gets the `implementing` state's model, tools, and instructions
5. After all branches complete, fires `BRANCH_DONE:name` for each
6. Gateway join advances to `on_complete`

### Branch Task Descriptions

The model provides tasks when calling `statewright_fork`:

```json
{
  "branches": [
    { "branch": "fix-converter", "task": "Fix fahrenheit_to_celsius formula" },
    { "branch": "fix-formatter", "task": "Add degree symbol to format_temp" }
  ]
}
```

Branch names are mapped to the workflow's fork definition by name (preferred) or position (fallback).

## /statewright Command

Pi slash command for workflow control:

- `/statewright load <name>` — load a workflow
- `/statewright deactivate` — deactivate enforcement
- `/statewright pause` — pause (resume later with `--resume`)
- `/statewright list` — list available workflows
- `/statewright status` — gateway status

## Rambling Watchdog

If the model generates text for 45 seconds without calling a tool, the plugin aborts the stream and sends a corrective prompt on the next turn. States with thinking levels set get 3x the timeout (135s) since reasoning takes time. Ultra-small models may trigger the watchdog frequently — consider increasing the timeout via `RAMBLING_TIMEOUT_MS` or routing those states to a more capable model.

## Debug Logging

Set `STATEWRIGHT_DEBUG=1` to enable mauve-colored diagnostic output:

```bash
STATEWRIGHT_DEBUG=1 pi
```

Shows model switches, tool set changes, fork branch connections, BRANCH_DONE events.
