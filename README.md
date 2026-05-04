# statewright

State machine guardrails for AI agents. Controls which tools your agent can use in each phase — enforced at the protocol layer, not via prompts.

## Install

In Claude Code:
```
/plugin marketplace add statewright/statewright
/plugin install statewright
```

Your browser opens. Sign up at [statewright.ai](https://statewright.ai). Generate a key. Paste it. Done.

## What it does

Every prompt, statewright checks your workflow state and tells the agent which tools are allowed. The agent reads first, edits second, tests third. No skipping phases.

```
❯ fix the failing tests in calc.py

◆ statewright — statewright_get_state (MCP)

◆ Current phase: planning. Let me read the code first.

  Read 2 files

  [statewright] planning => implementing

◆ statewright — statewright_transition (READY)

  Edit calc.py: 1 line changed

  [statewright] implementing => testing

◆ statewright — statewright_transition (DONE)

  Bash: pytest -x — 7 passed

  [statewright] testing => completed
◆ [statewright] Workflow complete. 46 seconds.
```

## Guardrails enforced over MCP

| Guardrail | What it does |
|-----------|-------------|
| Per-state tool enforcement | Tools invisible to agent when not in allowed_tools |
| Decision checkpoints | max_iterations per state forces transition or fail |
| Edit guard | Rejects diffs exceeding max_edit_lines |
| Command guard | Whitelist shell commands per state |
| Edit scope limits | Cap files edited per state |
| Read dedup | Detects repeated reads, warns agent |
| Context budget | Track tool result bytes, warn at threshold |
| Approval gates | Human approval before high-risk transitions |
| Transition audit log | Every state change recorded with context |

## Workflow format

```json
{
  "id": "bugfix",
  "initial": "planning",
  "states": {
    "planning": {
      "allowed_tools": ["Read", "Grep", "Glob"],
      "max_iterations": 8,
      "on": { "READY": "implementing" }
    },
    "implementing": {
      "allowed_tools": ["Read", "Edit", "Write"],
      "max_edit_lines": 20,
      "max_files_per_state": 3,
      "on": { "DONE": "testing" }
    },
    "testing": {
      "allowed_tools": ["Read", "Bash"],
      "allowed_commands": ["pytest", "cargo test", "npm test"],
      "on": { "PASS": "completed", "FAIL_TEST": "implementing" }
    },
    "completed": { "type": "final" }
  }
}
```

Build custom workflows at [statewright.ai/workflows](https://statewright.ai/workflows).

## Plugins

| Agent | Plugin |
|-------|--------|
| [Claude Code](plugins/claude-code/) | Hooks + MCP |
| [Codex](plugins/codex/) | Hooks |
| [opencode](plugins/opencode/) | TypeScript plugin |
| [Pi](plugins/pi/) | Skills extension |
| [Cursor](plugins/cursor/) | MCP + rules |

## Engine

The core engine is a pure Rust library. No runtime dependencies.

```rust
use statewright_engine::{MachineDefinition, resolve_transition, validate_definition};
```

## Experimental results

| Model | Size | Bug fix | SWE-bench | TDD |
|-------|------|---------|-----------|-----|
| gemma4:e2b | 7.2GB | PASS | - | Partial |
| gpt-oss | 13.8GB | PASS | - | - |
| gemma4:31b | 19.9GB | - | PASS | PASS |
| llama3.3 | 42.5GB | PASS | PASS | - |

With statewright: 10/10. Without: 2/10. Same models, same tasks. [Research brief](https://statewright.ai/research).

## License

Apache 2.0 — portions [FSL-1.1-Apache-2.0](https://fsl.software) (see `LICENSE.md` in subdirectories). Managed cloud at [statewright.ai](https://statewright.ai).
