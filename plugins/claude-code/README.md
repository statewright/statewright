# statewright plugin for Claude Code

State machine workflow enforcement. Controls which tools your agent can use in each phase.

## Install

First, add the marketplace:
```
/plugin marketplace add statewright/statewright
```

Then install:
```
/plugin install statewright
```

Your browser opens. Sign up. Generate a key. Paste it. Done.

For executor-owned isolated delivery, launch Claude Code through the shared executor:

```bash
node plugins/executor/statewright-exec.mjs \
  --host claude --workflow bugfix --cwd "$PWD" -- \
  "Fix the failing tests"
```

The executor owns the remote credential and MCP session. Claude Code receives an authenticated loopback bridge.

### Transparent Model Routing

The plugin setup installs the managed Claude client automatically. Restart the
terminal once after installing or updating the plugin, then keep using `claude`
normally. The shim stays dormant unless a workflow is loaded. At a route boundary it owns
and restarts only its own CLI child, forks the saved conversation, and starts
the fork with the workflow model. Forking is required because the
[Claude model configuration reference](https://code.claude.com/docs/en/model-config)
documents that plain `--resume` preserves the prior session model; the
[CLI reference](https://code.claude.com/docs/en/cli-usage) documents both
`--fork-session` and `--model`. Claude does not expose a documented CLI
reasoning-effort flag, so Statewright applies the state model and records the
effort as advisory for this host. Disable with
`statewright-managed-client --disable --host claude`.

To remove managed routing entirely, run
`statewright-managed-client --uninstall`. It removes only Statewright's shims
and marked shell-path block.

## What happens

Every prompt, statewright checks your workflow state and tells Claude which tools are allowed. Claude reads first, edits second, tests third. No skipping phases.

```
❯ fix the failing tests

⏺ statewright - statewright_get_state (MCP)
⏺ Current phase: planning. Let me read the code first.
  Read 2 files
  [statewright] planning => implementing
⏺ statewright - statewright_transition (MCP)(event: "READY")
```

## Default workflow

| Phase | Tools | Limits |
|-------|-------|--------|
| planning | Read, Grep, Glob | No edits. |
| implementing | Read, Edit, Write | 20 lines max, 3 files max |
| testing | Read, Bash | Test commands only |

Build your own at [statewright.ai/workflows](https://statewright.ai/workflows).

## Status line

Show the current workflow state in your Claude Code status bar. Add to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "/path/to/statusline.sh"
}
```

An example script is in [`examples/statusline.sh`](examples/statusline.sh). It renders a powerline segment with the active state and iteration count, colored by phase:

```
 ~/project  main  Opus 4.6  03:42         implementing 2/8  ⚙ statewright 
```

When no workflow is running, just the brand pill shows. Append the statewright segment to your existing statusline script — see the comments in the example for integration.

## License

Apache 2.0. Cloud at [statewright.ai](https://statewright.ai).
