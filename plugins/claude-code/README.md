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

Then run the local bootstrap once from the repository checkout:

```bash
bash plugins/claude-code/setup.sh
exec zsh
```

The setup command installs Claude hooks, configures the Statewright MCP
server, installs the managed `claude` shim, and enables transparent model
routing. The `exec zsh` reloads `PATH`; it is required only once after the
initial setup or a plugin update.

The MCP client and hook gateway are configured as one endpoint. For a
self-hosted or staging gateway, set `STATEWRIGHT_GATEWAY_URL` when running
setup; otherwise the public gateway is used:

```bash
STATEWRIGHT_GATEWAY_URL=https://mcp.statewright.ai bash plugins/claude-code/setup.sh
```

Verify the install:

```bash
command -v claude
cat ~/.statewright/config.json
```

The first command should resolve to `~/.statewright/bin/claude`. The config
should contain `routing.managed_clients.enabled: true` and
`routing.managed_clients.hosts.claude: true`.

After that, use Claude normally. No wrapper command, shell alias, or plugin
cache path is needed:

```bash
claude
```

### Claude routing canary

Use the Claude-specific canary, which routes between Claude model annotations
instead of Codex model names:

```text
Load the `claude-model-routing-canary` workflow and follow its instructions exactly. Confirm the current Statewright phase, then emit the required transition.
```

The canary starts on `anthropic/claude-sonnet-4-6` and routes to
`anthropic/claude-opus-4-6`. Do not use the Codex-only `model-routing-canary`
workflow from Claude.

Your existing Claude sessions can be tested through the managed client by
starting a fresh terminal and resuming the session normally:

```bash
claude --resume SESSION_ID
```

At a Statewright model boundary, the managed client preserves the conversation
by forking the session and starts the fork with the routed model.

To disable only managed Claude routing while leaving Statewright installed:

```bash
node plugins/executor/statewright-managed-client.mjs --disable --host claude
```

To remove the managed shims and the Statewright shell-path block:

```bash
node plugins/executor/statewright-managed-client.mjs --uninstall
```

Your browser opens during plugin installation. Sign up, generate a key, and
paste it when prompted. The local setup command reuses the saved key.

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
