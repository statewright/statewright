# statewright

> Agents are suggestions, states are laws.

State machine guardrails that control which tools your AI agent can use in each phase. Define a workflow once, enforce it across Claude Code, Codex, Cursor, opencode, and Pi. [Full docs →](https://docs.statewright.ai)

![Statewright workflow editor](docs/images/workflow-editor.png)

## The problem

AI agents are powerful but brittle. Give a model 40+ tools and an open-ended problem and it barely gets out of the gate. The common fix is bigger models and longer prompts... it helps sometimes. Observability tells you what went wrong after the fact; it doesn't prevent it.

## The approach

Instead of making the model bigger, make the problem smaller. State machines aren't DAGs — they loop and retry, which is what agentic work actually needs.

State machines constrain the tool and solution spaces so the model reasons in a focused context at each step. A planning state gets read-only tools. When the agent transitions to implementation, edit tools unlock with limited shell access (write-via-redirect and destructive ops are blocked even when Bash is allowed). Testing only permits designated test commands. If you call a tool that's not in the current phase, you get rejected with a message telling you what IS available and how to transition.

Works the same way on frontier models (fewer tokens to completion) and local models where 13B+ models start solving tasks they'd otherwise fail.

## Quickstart

Install into Claude Code:

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

You can also use the slash command directly: `/statewright start bugfix`.

## Research results

| Model | Size | Bug Fix (26 lines) | SWE-bench (5 tasks) |
|-------|------|--------------------|---------------------|
| gemma3 | 3.3GB | FAIL | FAIL |
| gemma4:e2b | 7.2GB | PASS* | FAIL |
| gpt-oss:20b | 13.8GB | PASS | PASS (5/5) |
| gemma4:31b | 19.9GB | PASS | PASS (5/5) |
| llama3.3 | 42.5GB | PASS | PASS (2/2)† |

*\*with specialized edit_line tool adaptation*
*†tested on 2 of the 5 tasks (added after initial experiment run)*

We validated on local models where the effect is most measurable. In our 5-task SWE-bench subset, two models (13.8GB and 19.9GB) **went from 2/10 to 10/10** with statewright constraints. Same tasks, same hardware. Below 13GB, models can produce tool calls but can't retain enough file content to produce accurate edits — that's the floor, not a statewright limitation.

Frontier models with default system prompts handle the obvious catastrophic actions (database deletion, credential leaks)... most of the time. The structural win is bigger: breaking read-loop death spirals where models re-read the same file 5+ times without ever editing, and keeping the tool space small enough that the model actually reasons instead of flailing. [Research brief →](https://statewright.ai/research)

## How it works

The core is a Rust engine that evaluates state machine definitions: states, transitions, guards, tool restrictions. It's deterministic. No LLM in the loop.

On top of that sits a plugin layer that integrates with your coding agent via MCP. When you activate a workflow, hooks enforce tool restrictions per state automatically. The model sees 5 tools instead of 30, gets clear instructions for the current phase, and transitions when conditions are met.

### Guardrails

| Guardrail | What it does |
|-----------|-------------|
| Per-state tool enforcement | Tools invisible to agent when not in `allowed_tools` |
| Bash discernment | Redirects (`>>`), destructive ops (`rm`, `shred`), and scripting interpreters blocked in non-write states |
| Edit guards | Rejects diffs exceeding `max_edit_lines`, caps files edited per state |
| Command allow-lists | Prefix-matched `allowed_commands` per state |
| Conditional transitions | Guards with programmatic predicates (eq, gt, exists, etc.) on context data |
| Approval gates | `requires_approval` pauses for human review before high-risk transitions |
| Interrupts | File changes matching glob patterns auto-transition to validation states, then return |
| Fork/join | Branch execution (sequential or parallel) with configurable join strategies (all, any) |
| Environment scoping | `blocked_env` + `env_overrides` per state |
| Session isolation | Per-session state via `CLAUDE_SESSION_ID` |

Full guardrail reference in [the docs](https://docs.statewright.ai/tools/reference).

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

Point your agent at the [JSON schema](https://statewright.ai/workflow-schema.json) and it generates a workflow via `statewright_create_workflow`. Tweak tools, commands, and environment blocks in the [visual editor](https://statewright.ai/workflows).

## Supported agents

| Agent | Integration | Enforcement |
|-------|------------|-------------|
| [Claude Code](plugins/claude-code/) | Hooks + MCP | Hard |
| [Codex](plugins/codex/) | Hooks + MCP | Hard |
| [Oh My Codex](plugins/omx/) | Hooks + MCP | Hard |
| [Pi](plugins/pi/) | TypeScript extension | Hard* |
| [opencode](plugins/opencode/) | TypeScript plugin | Hard (alpha) |
| [Cursor](plugins/cursor/) | MCP + rules | Advisory |

**Hard**: tool calls intercepted at the hook/protocol layer. **Advisory**: rules injected into context, not enforced.

*\*Pi includes tool name normalization and tool-call recovery for local models (Ollama, LM Studio).*

## Pricing

Free for individual developers. The managed cloud at [statewright.ai](https://statewright.ai) handles workflow storage, run history, and the MCP gateway. Prices will not increase; tier grants can only increase.

| Plan | Workflows | Transitions/mo | Run History | Price |
|------|-----------|-------------|----------------|-------|
| Free | 3 | 200 | 72 hours | $0 |
| Pro | 10 | 2500 | 7 days | $29/mo |
| Team | 30 | 10000 | 90 days | $99/mo |
| Enterprise | Unlimited | Unlimited | to Specification | [Contact us](mailto:sales@statewright.ai) |

## Self-hosting

The engine (`crates/engine`) is Apache 2.0 and embeddable with no runtime dependencies. Single-developer and single-team self-hosting of the full stack is permitted under the FSL license.

```rust
use statewright_engine::{MachineDefinition, resolve_transition, validate_definition};
```

## Tradeoffs

- Requires MCP support in the agent (or hooks for non-MCP agents like Codex)
- Workflow definitions are authored by hand, though agents can generate them via `statewright_create_workflow`
- Cursor enforcement is advisory, not hard. MCP alone can't gate tool calls in Cursor's architecture
- Research results are from a 5-task SWE-bench subset, not the full 2294-instance benchmark
- If a workflow is too restrictive, the agent gets stuck. `statewright_deactivate` is the escape hatch

## Docs

[docs.statewright.ai](https://docs.statewright.ai) — install guide, workflow authoring, [schema reference](https://docs.statewright.ai/workflows/schema-reference), [MCP tool reference](https://docs.statewright.ai/tools/reference), and [agent-generated workflows](https://docs.statewright.ai/tools/agent-generated-workflows).

## Contributing

Workflow definitions, templates, and bug reports welcome. See [Create Your Own](https://docs.statewright.ai/workflows/create-your-own/) for how to write workflows.

- [Report an issue](https://github.com/statewright/statewright/issues/new)
- [Discussions & feedback](https://github.com/statewright/statewright/discussions)

## License

Apache 2.0 — portions [FSL-1.1-ALv2](https://fsl.software) (converts to Apache 2.0 on May 3, 2029). Managed cloud at [statewright.ai](https://statewright.ai).

This project includes a [patent pledge](./PATENTS.md) covering independent implementations of the techniques described in the patent. Solo developers, researchers, open source projects, and single-team self-hosted deployments are covered regardless of whether they use Statewright software.

> One hook to rule them all.

<img src="https://statewright.ai/api/px/github" width="1" height="1" alt="" />
