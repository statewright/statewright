# Fork/Join

Your agent needs to lint, test, and update docs. Sequentially, that's three round trips through the state machine. Fork runs them simultaneously — one subprocess per branch, join when all complete.

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

The agent calls `statewright_transition(event="FORK")`. The gateway creates branch sessions. The agent works through branches one at a time using `statewright_load_workflow(name="my-workflow", branch="lint")`. After each branch completes, the agent fires `BRANCH_DONE:lint`. After all branches complete, the gateway auto-joins and advances to `on_complete`.

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
statewright_transition(event="BRANCH_DONE:lint", data={"rationale": "lint passed"})
```

The gateway matches the branch name against `_fork.branches` and marks it complete.

## Branch Model Inheritance (Pi)

Branches inherit the `implementing` state's model and tool restrictions. In Pi, each branch subprocess gets the state's model via `setModel()` and tools via `setActiveTools()`.

```json
"implementing": {
  "model": "ollama-qwen/qwen3.6:35b",
  "thinking_level": "off",
  "allowed_tools": ["Read", "Edit", "Write", "Bash"]
}
```

## Limitations

- Max 8 branches per fork (Pi plugin limit)
- Max 4 concurrent subprocesses (Pi serializes the rest)
- `join: "any"` completes on the first branch — remaining branches continue but their results are ignored
- Branch failures mark the branch as `"failed"` in the join tally. Under `join: "all"`, any failed branch triggers `on_fail` instead of `on_complete`
- No branch timeout — a hanging branch blocks the join indefinitely. Use workflow-level `max_iterations` to bound branch execution
- Branch sessions are in-memory only — a gateway restart during fork execution loses all branch state

## Tool Enforcement by Plugin

### Pi (full per-branch enforcement)

Each fork branch runs as a separate Pi subprocess with its own MCP session (`br_` prefix). The gateway routes each branch to an isolated session with its own state, `allowed_tools`, and context. Tool restrictions are structurally enforced per-branch.

### Claude Code (sequential: per-branch; parallel: cooperative)

**Sequential forks** have full per-branch structural enforcement. The hook caches the active branch's state (via `get_state`), and enforces that branch's `allowed_tools` for all tool calls until the branch completes.

**Parallel forks** share a single MCP session and hook context. All branch workers read the same cached state, so per-branch `allowed_tools` cannot be structurally enforced independently. Instead:

- The hook enforces whichever branch state was last cached
- Per-branch tool scoping is cooperative: the `fork-branch-worker` agent's prompt restricts which tools it uses
- The agent definition's `tools` frontmatter controls structural tool availability

This means during parallel fork execution, a branch worker could theoretically use a tool allowed by another branch but not by its own. For workflows where branches have different tool restrictions and this matters, use sequential execution or the Pi plugin.

A design spec for per-branch MCP session isolation in Claude Code is at `docs/specs/fork-branch-sessions.md`.
