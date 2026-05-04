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

## License

Apache 2.0. Cloud at [statewright.ai](https://statewright.ai).
