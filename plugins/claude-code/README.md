# statewright plugin for Claude Code

State machine workflow enforcement. Controls which tools your agent can use in each phase.

## Install

First, add the marketplace:
```
/plugin marketplace add statewright/statewright
```

Then install (inside Claude Code):
```
/plugin install statewright@statewright
```

Then run the local bootstrap once from the repository checkout:

```bash
bash plugins/claude-code/setup.sh
exec zsh
```

The setup command installs Claude hooks, configures the Statewright MCP
server, installs the managed `claude` shim, reconciles any active Claude
plugin cache or local directory marketplace, and enables transparent model
routing. The `exec zsh` reloads `PATH`; it is required only once after the
initial setup or a plugin update.

The MCP client and hook gateway are configured as one identity-preserving
proxy and one endpoint. This is important: configuring Claude with a direct
HTTP MCP URL creates a second Statewright client session and can show
conflicting active workflows. For a
self-hosted or staging gateway, set `STATEWRIGHT_GATEWAY_URL` when running
setup; otherwise the public gateway is used:

```bash
STATEWRIGHT_GATEWAY_URL=https://mcp.statewright.ai bash plugins/claude-code/setup.sh
```

### Named shell environments

After setup, optionally source the installed shortcuts from your Bash or Zsh
profile (remove any older aliases with the same names):

```sh
. "$HOME/.statewright/claude-env.sh"
```

`claude` selects production; `sclaude` selects `staging`; `d1claude`, `d2claude`
and `d3claude` select `dev1`, `dev2` and `dev3`. Configure named gateways in
`~/.statewright/environments.json`, for example:

```json
{
  "gateways": {
    "staging": {
      "gateway_url": "https://mcp.staging.example.com",
      "auth_url": "https://staging.example.com"
    }
  }
}
```

The shortcuts forward all arguments, including resume and permission options,
and clear inherited Statewright connection/session overrides for the child only.
They do not read passwords, change Claude authentication or add permission flags.
Unconfigured named environments fail explicitly through the managed launcher.
For a one-off custom gateway instead, use `command claude` with your explicit
environment variables; it bypasses the shell function, not the installed runtime.

These shortcuts select the current managed launcher on `PATH`; they are not a
native mod/OAuth migration. They do not configure Claude Desktop. In particular,
forwarding `--desktop` does not guarantee that the Desktop session inherits the
selected gateway. Desktop Code needs explicit plugin/host configuration and its
own acceptance test as part of the native upgrade.

Verify the install:

```bash
type -a claude
cat ~/.statewright/config.json
```

The first command should list `~/.statewright/bin/claude` (and the optional
shell function, if loaded). The config
should contain `routing.managed_clients.enabled: true` and
`routing.managed_clients.hosts.claude: true`.

After that, use Claude normally. No wrapper command, shell alias, or plugin
cache path is needed:

```bash
claude
```

After updating a checkout or local directory marketplace, rerun setup and
reload Claude plugins. This updates only Statewright runtime files in the
active install locations and keeps the plugin MCP proxy as the sole
Statewright transport:

```bash
bash plugins/claude-code/setup.sh
```

To diagnose or reconcile runtime drift without changing Claude settings:

```bash
task plugins:sync-claude-runtime
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

The current Claude transport still uses the legacy gateway API-key file. On
the first missing-key request, its proxy can open the signup/key page; the
local setup command does not itself complete OAuth or install a gateway
credential. Claude OAuth and per-gateway credential storage are separate
follow-up work.
The [mod/OAuth discovery handoff](../../docs/specs/claude-mod-oauth-discovery.md)
records the current boundary and the acceptance checks for that refit.

For executor-owned isolated delivery, launch Claude Code through the shared executor:

```bash
node plugins/executor/statewright-exec.mjs \
  --host claude --workflow '<explicit-workflow-name>' --cwd "$PWD" -- \
  "Fix the failing tests"
```

The executor owns the remote credential and MCP session. Claude Code receives an authenticated loopback bridge.

### Transparent Model Routing

The plugin setup installs the managed Claude client automatically. After setup,
start `claude` from the terminal so the shim can load. It stays dormant unless
a workflow is loaded. At a route boundary it owns
and restarts only its own CLI child, resumes the same conversation with the workflow
model, and preserves the plugin MCP session. Claude does not expose a documented CLI
reasoning-effort flag, so Statewright applies the state model and records the
effort as advisory for this host. Disable with
`statewright-managed-client --disable --host claude`.

### Approval evidence

When a parked transition carries a `statewright/evidence-packet/v1` manifest,
the persistent supervisor uploads the declared project files through the
gateway-bound approval and opens the authenticated review page once. The hook
states that the browser review is opening, and a resumed pending gate recreates
the review request. The workflow remains parked until an authorized reviewer
decides it; the conversation transcript is not part of the packet.

### Model translation

Claude routes semantic model tiers across providers so a workflow can remain
portable. The Claude adapter translates `sol` to `opus`, `terra` to `sonnet`,
and `luna` to `haiku`. For example, `openai/gpt-5.6-sol` launches Claude with
the native `opus` alias. Native `anthropic/...` model IDs pass through unchanged.
An OpenAI model without one of these semantic suffixes is rejected rather than
silently sent to Claude as an invalid model name.

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

FSL-1.1-ALv2 (see [`../LICENSE.md`](../LICENSE.md)). Cloud at
[statewright.ai](https://statewright.ai).
