# Per-Branch MCP Sessions for Fork/Join

**Status**: TODO — design spec for future implementation
**Date**: 2026-05-27
**Context**: Claude Code fork/join currently lacks per-branch structural enforcement

## Problem

When a fork spawns parallel branch workers in Claude Code, all workers share a single MCP session and hook enforcement context. The statewright hook (`hook.sh`) reads one cached state and enforces one set of `allowed_tools` for all tool calls in the session — it cannot distinguish which branch a tool call originates from.

This means:
- Parallel branches cannot have different tool restrictions
- A branch worker can use tools intended for a different branch
- The enforcement boundary is the fork-branch-worker agent's prompt (cooperative), not the state machine (structural)

Sequential fork execution works correctly: `get_state` returns the active branch's state, and the hook enforces that branch's `allowed_tools`. The gap is parallel-only.

## How Pi Solves This

The Pi plugin spawns each fork branch as a **separate process** with its own MCP session:

1. Parent calls FORK transition → gateway creates branch sessions with `br_` prefix keys
2. `runBranch()` spawns a new Pi subprocess with `STATEWRIGHT_BRANCH_SESSION_ID=br_<branch>` env var
3. Each subprocess's `gwCall()` sends `Mcp-Session-Id: br_<branch>` header
4. Gateway routes the request to the branch's isolated session
5. Each branch has its own state, `allowed_tools`, iteration count, and context
6. Branch subprocess calls `BRANCH_DONE` → gateway marks branch complete
7. When all branches complete → gateway auto-joins, transitions parent to next state

Each branch has full structural enforcement because each has its own session.

## Proposed Architecture for Claude Code

### Gateway Side (already implemented)

The gateway already supports branch sessions:
- `_fork.branches.<name>.session_key` stores the branch session key
- Branch sessions are full `GatewaySession` instances with their own state
- `get_state` with a branch session routes to the branch's state
- `BRANCH_DONE` events are scoped per-branch

No gateway changes needed.

### Plugin Side (hook.sh changes)

#### Option A: Environment Variable Routing

1. When `hook.sh` detects a FORK transition (PostToolUse), it writes branch session IDs to `$SESSION_DIR/.fork_branches.json`
2. The fork instructions tell the parent agent to spawn `fork-branch-worker` agents with `STATEWRIGHT_BRANCH_SESSION=<session_key>` in the Agent prompt
3. The `fork-branch-worker` agent sets this as an env var for its Bash calls
4. `hook.sh` PreToolUse checks: if `STATEWRIGHT_BRANCH_SESSION` is set, fetch that branch's cached state instead of the parent's
5. Per-branch cache files: `$SESSION_DIR/.state_cache.<branch_name>`

**Problem**: Claude Code Agent tool doesn't support env var propagation to subagents. The env var would need to be passed via the prompt and self-set by the worker.

#### Option B: Branch Tag File (Sequential-Safe)

1. Fork-branch-worker writes `$SESSION_DIR/.current_branch` with its branch name before starting work
2. `hook.sh` reads this tag, looks up the branch session in `.fork_branches.json`, uses branch-specific cache
3. Worker clears the tag when done

**Problem**: Race condition with parallel workers overwriting the tag file.

#### Option C: Per-Worker Cache (Parallel-Safe)

1. PostToolUse FORK handler fetches each branch's state and writes per-branch caches: `$SESSION_DIR/.state_cache.lint`, `$SESSION_DIR/.state_cache.test`, etc.
2. Fork-branch-worker prompt includes: "You are working on branch 'lint'. Write your branch name to `$SESSION_DIR/.branch_tag.$$` before each tool call."
3. `hook.sh` reads all `.branch_tag.*` files, finds one matching the current PID lineage, loads that branch's cache
4. Fallback: if no tag found, use parent state cache

**Problem**: PID matching between hook subprocess and agent subagent is unreliable.

#### Option D: MCP-Level Branch Routing (Recommended)

1. Replace `mcp-proxy.sh` with a branch-aware proxy, or add branch routing to hook.sh
2. When a fork is active, UserPromptSubmit for each branch worker calls `get_state` with the branch session header
3. Each worker's state is independently cached with branch-scoped file names
4. PreToolUse reads the correct branch cache based on the worker context

This requires the Claude Code Agent tool to either:
- Support custom MCP session headers per subagent
- Or allow the fork-branch-worker to override the MCP session in its own calls

**This is the correct long-term solution** but requires upstream Claude Code support for per-agent MCP session scoping, or a creative workaround.

## Current Workaround (Shipped)

Sequential forks: full per-branch structural enforcement via cached branch state.

Parallel forks: enforcement uses whichever branch state was last cached. Per-branch scoping is cooperative — the fork-branch-worker agent's prompt restricts which tools it uses, and the agent definition's `tools` frontmatter controls availability. Not structurally enforced per-branch.

The fork-branch-worker agent has a blanket PreToolUse auto-allow hook to prevent the parent session's statewright hook from blocking branch tool calls with stale parent state.

## Migration Path

1. **Now**: Cooperative enforcement for parallel forks, structural for sequential
2. **Next**: Investigate Claude Code Agent env var or MCP session propagation
3. **Target**: Option D — per-branch MCP session routing with independent state caches
4. **Upstream**: If Claude Code adds per-agent MCP session support, this becomes trivial

## Acceptance Criteria

- [ ] Each parallel fork branch has its own `allowed_tools` structurally enforced
- [ ] Branch A cannot use tools only allowed in Branch B
- [ ] hook.sh makes zero additional network calls per tool use (cache-based)
- [ ] Works with both sequential and parallel fork execution
- [ ] No regression on non-fork workflow enforcement
