# statewright

> Agents are suggestions, states are laws.

One hook, one JSON file, every agent. State machine guardrails that control which tools your AI agent can use in each phase. Define the workflow once, enforce it across Claude Code, Codex, Cursor, opencode, and Pi.

![Statewright workflow editor](docs/images/workflow-editor.png)

## The problem

AI agents are powerful but brittle. Give a model 40+ tools and an open-ended problem and it barely gets out of the gate. Most people brute-force reliability with bigger models and longer prompts, with mixed results. Observability tells you what went wrong after the fact — it doesn't prevent it.

## The approach

Instead of making the model bigger, make the problem smaller. Formal state machines constrain the tool and solution spaces so the model reasons in a focused context at each step. A planning state gets read-only tools. An implementation state gets edit tools with limited shell — write-via-redirect and destructive ops are blocked even when Bash is allowed. A testing state gets bash but only for test commands. Call a tool that's not in the current phase and you get rejected with a message telling you what IS available and how to transition.

Works the same way on frontier models (fewer tokens, fewer debug spirals) and local models (13B+ models solving tasks they'd otherwise fail). Model-agnostic.

## Research results

| Model | Size | Bug Fix (26 lines) | SWE-bench (5 tasks) |
|-------|------|--------------------|---------------------|
| gemma3 | 3.3GB | FAIL | FAIL |
| gemma4:e2b | 7.2GB | PASS* | FAIL |
| gpt-oss:20b | 13.8GB | PASS | PASS (5/5) |
| gemma4:31b | 19.9GB | PASS | PASS (5/5) |
| llama3.3 | 42.5GB | PASS | PASS (2/2) |

*\*with specialized edit_line tool adaptation*

We validated on local models where the effect is most measurable. In our 5-task SWE-bench subset, **models above 13GB went from 2/10 to 10/10** with statewright constraints. Same tasks, same hardware. Below 13GB, models can't maintain valid tool call JSON through complex arguments — that's the floor, not a statewright limitation. Model age didn't predict success; VRAM threshold did.

Frontier models benefit too: fewer tokens, fewer debug spirals, higher first-attempt success. [Research brief →](https://statewright.ai/research)

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

You can also use the slash command directly: `/statewright start bugfix`. The agent picks up natural language cues or explicit commands.

## How it works

The core is a **Rust engine** that evaluates state machine definitions — states, transitions, guards, tool restrictions. It's deterministic: the engine doesn't use an LLM, it enforces the machine.

On top of that sits a **plugin layer** that integrates with your coding agent via MCP. When you activate a workflow, hooks enforce the tool restrictions per state automatically. The model sees 5 tools instead of 30, gets clear instructions for the current phase, and transitions when conditions are met.

### Guardrails enforced over MCP

| Guardrail | What it does |
|-----------|-------------|
| Per-state tool enforcement | Tools invisible to agent when not in allowed_tools |
| Decision checkpoints | max_iterations per state forces transition or fail |
| Edit guard | Rejects diffs exceeding max_edit_lines |
| Command guard | Prefix-matched command allow list per state |
| Bash discernment | Redirects (`>>`) and destructive ops (`rm`, `shred`) blocked in non-write states |
| Edit scope limits | Cap files edited per state |
| Guards | Conditional transitions — programmatic predicates (eq, gt, exists, etc.) on context data |
| Approval gates | `requires_approval` pauses for human review before high-risk transitions |
| Environment scoping | `blocked_env` + `env_overrides` — no prod credentials in test phases |
| Context budget | Track tool result bytes, warn at threshold |
| Session isolation | Per-session state via `CLAUDE_SESSION_ID` — parallel sessions don't interfere |
| Run history | Full observability: every tool call, transition rationale, per-phase grouping |

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
      "on": {
        "PASS": { "target": "completed", "guard": "tests_passed" },
        "FAIL_TEST": "implementing"
      }
    },
    "completed": { "type": "final" }
  },
  "guards": {
    "tests_passed": { "field": "test_result", "op": "eq", "value": "pass" }
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

## What's new (May 2026)

- **Observability dashboard** — run history with per-phase tool logs, transition rationale, smart rendering for Read/Edit/Bash/Glob output
- **Guards** — conditional transitions with declarative predicates (eq, neq, gt, exists, contains). XState-style branched transitions.
- **Agent-generated workflows** — `statewright_create_workflow` MCP tool. Point the agent at the [JSON schema](https://statewright.ai/workflow-schema.json), it generates and uploads a state machine.
- **Environment controls** — `blocked_env` denies access to specific env vars, `env_overrides` aliases them per state
- **Bash command discernment** — redirect detection, destructive op blocking, `allowed_commands` prefix matching
- **Approval gates** — `requires_approval` on transitions for human-in-the-loop
- **Session isolation** — per-session state scoping, parallel Claude Code sessions don't interfere
- **Docs** — [statewright.ai/docs](https://statewright.ai/docs) — schema reference, workflow patterns, MCP tool reference
- **Docs RAG** — `statewright_search_docs` MCP tool for agents to look up schema fields and patterns

## Docs

Full documentation at [statewright.ai/docs](https://statewright.ai/docs): getting started, workflow authoring, schema reference, MCP tool reference, and agent-generated workflows.

## Contributing

Workflow definitions, templates, and bug reports welcome. See the [docs](https://statewright.ai/docs/workflows/create-your-own/) for how to write workflows.

## License

Apache 2.0 — portions [FSL-1.1-Apache-2.0](https://fsl.software) (see `LICENSE.md` in subdirectories). Managed cloud at [statewright.ai](https://statewright.ai).

> One hook to rule them all.
