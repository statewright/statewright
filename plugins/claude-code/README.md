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

`statewright_search_references(query)` is a deterministic, read-only local
reference index stored below Git metadata. Results include source class,
path/line provenance, source hash, commit, and rank reasons. Ignored files,
generated folders, secret paths, and detected credential material are excluded
before any result is returned.

The plugin bootstraps Statewright as a command MCP server, so this tool runs
against the active local checkout; only workflow-control calls go to the hosted
gateway.

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
