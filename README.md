# statewright

Visual state machines that make AI agents reliable.

![Statewright workflow editor](docs/images/workflow-editor.png)

State machine guardrails for AI agents. Controls which tools your agent can use in each phase — enforced at the protocol layer, not via prompts. Agents are suggestions, states are laws.

## The problem

AI agents are powerful but brittle. Give a model 40+ tools and an open-ended problem and it barely gets out of the gate. Most people brute-force reliability with bigger models and longer prompts, with mixed results. Observability tells you what went wrong after the fact — it doesn't prevent it.

## The approach

Instead of making the model bigger, make the problem smaller. Formal state machines constrain the tool and solution spaces so the model reasons in a focused context at each step. A planning state gets read-only tools. An implementation state gets edit tools but no shell access. A testing state gets bash but only for test commands. The model physically cannot skip steps or use the wrong tool at the wrong time.

## Results

| Model | Size | With statewright | Without |
|-------|------|-----------------|---------|
| gemma4:e2b | 7.2GB | FAIL | FAIL |
| gpt-oss | 13.8GB | PASS | FAIL |
| gemma4:31b | 19.9GB | PASS | FAIL |
| llama3.3 | 42.5GB | PASS | FAIL |

The inflection point is ~13GB. Below that, models can't maintain valid tool call JSON through complex arguments — the constraint helps but doesn't overcome fundamental serialization limits. Above 13GB, **statewright takes models from 2/10 to 10/10** on the same tasks, same hardware. [Research brief →](https://statewright.ai/research)

## Quick start

Install into Claude Code in a few keystrokes:

```
/plugin marketplace add statewright/statewright
/plugin install statewright
```

Your browser opens → sign up at [statewright.ai](https://statewright.ai) → generate a key → paste it → done.

Then start a workflow:

```
❯ start the bugfix workflow — fix the failing tests in calc.py

◆ statewright — statewright_start (workflow: bugfix)
◆ [statewright] Workflow activated: bugfix

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

You can also use the slash command directly: `/statewright bugfix`. The agent picks up natural language cues or explicit commands.

## How it works

The core is a **Rust engine** that evaluates state machine definitions — states, transitions, guards, tool restrictions. It's deterministic: the engine doesn't use an LLM, it enforces the machine.

On top of that sits a **plugin layer** that integrates with your coding agent via MCP. When you activate a workflow, hooks enforce the tool restrictions per state automatically. The model sees 5 tools instead of 30, gets clear instructions for the current phase, and transitions when conditions are met.

### Guardrails enforced over MCP

| Guardrail | What it does |
|-----------|-------------|
| Per-state tool enforcement | Tools invisible to agent when not in allowed_tools |
| Decision checkpoints | max_iterations per state forces transition or fail |
| Edit guard | Rejects diffs exceeding max_edit_lines |
| Command guard | Whitelist shell commands per state |
| Edit scope limits | Cap files edited per state |
| Approval gates | Human approval before high-risk transitions |
| Environment scoping | Constrain or alias env vars per state — no prod credentials in test phases |
| Context budget | Track tool result bytes, warn at threshold |

## Define your own workflows

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

State machines aren't DAGs — they loop and retry, which is what agentic work actually needs. Build workflows visually at [statewright.ai/workflows](https://statewright.ai/workflows).

## Supported agents

| Agent | Integration | Enforcement |
|-------|------------|-------------|
| [Claude Code](plugins/claude-code/) | Hooks + MCP | Hard (protocol layer) |
| [Codex](plugins/codex/) | Hooks | Hard (alpha) |
| [opencode](plugins/opencode/) | TypeScript plugin | Hard (alpha) |
| [Pi](plugins/pi/) | Skills extension | Hard (alpha) |
| [Cursor](plugins/cursor/) | MCP + rules | Advisory (alpha) |

## Engine

The core engine is a pure Rust library with no runtime dependencies.

```rust
use statewright_engine::{MachineDefinition, resolve_transition, validate_definition};
```

## License

Apache 2.0 — portions [FSL-1.1-Apache-2.0](https://fsl.software) (see `LICENSE.md` in subdirectories). Managed cloud at [statewright.ai](https://statewright.ai).
