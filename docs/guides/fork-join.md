# Fork/Join — Parallel Branch Execution

Split work into parallel branches, join when all complete.

## Workflow Definition

```json
{
  "states": {
    "planning": {
      "allowed_tools": ["Read", "Grep", "Glob", "Bash"],
      "instructions": "Plan the work, then trigger FORK.",
      "on": {
        "FORK": {
          "fork": {
            "branches": {
              "lint": { "initial": "implementing", "terminal": "branch-done" },
              "test": { "initial": "implementing", "terminal": "branch-done" },
              "docs": { "initial": "implementing", "terminal": "branch-done" }
            },
            "join": "all",
            "on_complete": "review",
            "on_fail": "failed"
          }
        }
      }
    },
    "implementing": {
      "allowed_tools": ["Read", "Edit", "Write", "Bash"],
      "instructions": "Complete the assigned task.",
      "on": { "DONE": "branch-done", "FAIL": "failed" }
    },
    "branch-done": { "type": "final" },
    "review": {
      "allowed_tools": ["Read", "Bash"],
      "instructions": "Run full test suite.",
      "on": { "PASS": "completed", "FAIL": "failed" }
    },
    "completed": { "type": "final" },
    "failed": { "type": "final" }
  }
}
```

## How It Works

### Sequential (Claude Code, Codex, OMX)

The agent calls `statewright_transition(event="FORK")`. The gateway creates branch sessions. The agent works through branches one at a time using `statewright_load_workflow(branch="lint")`. After each branch completes, the agent fires `BRANCH_DONE:lint`. After all branches complete, the gateway auto-joins and advances to `on_complete`.

### Parallel (Pi)

The Pi plugin has a `statewright_fork` tool that spawns parallel sub-agent processes. Each branch runs as a separate Pi process with its own gateway session. Branches execute simultaneously. The parent collects results and fires `BRANCH_DONE:name` for each.

## Fork Definition Fields

| Field | Type | Description |
|---|---|---|
| `branches` | Object | Map of branch name to `{ initial, terminal }` |
| `join` | `"all"` or `"any"` | Join strategy — wait for all or first |
| `on_complete` | String | State to advance to after join |
| `on_fail` | String | State to advance to if join fails |

## Branch Definition Fields

| Field | Type | Description |
|---|---|---|
| `initial` | String | State the branch starts in |
| `terminal` | String | Final state that signals branch completion |

## Join Strategies

- **`all`** — All branches must reach their terminal state. Default.
- **`any`** — First branch to complete triggers the join.

## BRANCH_DONE Event Format

The event must include the branch name after a colon:

```
statewright_transition(event="BRANCH_DONE:lint", data={rationale: "lint passed"})
```

The gateway matches the branch name against `_fork.branches` and marks it complete.

## Per-Branch Model Routing (Pi)

Branches inherit the `implementing` state's model and tool restrictions. In Pi, each branch subprocess gets the state's model via `setModel()` and tools via `setActiveTools()`.

```json
"implementing": {
  "model": "ollama-qwen/qwen3.6:35b",
  "thinking_level": "off",
  "allowed_tools": ["Read", "Edit", "Write", "Bash"]
}
```

## Context

The `_fork` context is stored in the parent session during fork execution. It tracks branch status and join progress. The context is automatically cleaned up after join or deactivation.
