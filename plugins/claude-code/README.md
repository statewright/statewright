# Statewright for Claude Code

The 0.3.4 plugin adds the Arbiter, workflow sidebar, compact tool results and
per-state model routing to Claude Code and **Claude Desktop → Code → Local**.
Use ordinary Claude; no separate app or Statewright launcher is required.

Use Claude Code 2.1.295 or newer. Desktop bundles its own Code engine: check
`/status` inside a Code conversation, not only the Desktop application version.
This integration is not for the ordinary Chat tab or Cowork.

## Install and connect

In Claude Code:

```text
/plugin marketplace add statewright/statewright
/plugin install statewright@statewright
```

For an existing install, run `claude plugin update statewright@statewright`
in a terminal. Reload an open conversation with `/reload-plugins`.
Installation is shared with Desktop Code.

The Arbiter appears when the Code conversation starts. Select its connection
status to open the sidebar, then **Connect**. Finish Statewright sign-in and
Claude's native permission prompts. Claude owns OAuth credentials and refresh;
a Statewright API key file is not required.

The connection and permission to control a conversation are separate.
An existing login can restore without another browser visit. Workflow-control
consent is scoped to the live session; reloading or closing it clears that grant.
It does not override file/command permission rules or workflow approvals.

## Use a workflow

Select a workflow in the sidebar and choose **Start**, or ask Claude to use a
named workflow. Selecting its name alone does not start it. The Arbiter shows
current state, available events, and model/effort when known. Expand tool-result
**Details** to inspect the exact JSON behind a compact summary.

Use `/statewright` to reopen the sidebar, or turn the workflow **Off** there.
Off restores the host-selected model. Requested effort is a setting, not
proof of internal reasoning; routed response receipts identify the observed model.

Terminal separators are plain by default. `/statewright configure` opens saved
preferences. Enable Powerline only if your terminal font supports it;
`/statewright powerline on`, `off`, or `default` overrides only this session.

## Another gateway or an SSH session

Set **Statewright gateway** through `/statewright configure`, then reload plugins.
The default is `https://mcp.statewright.ai/mcp`. Your service must support the
native Claude control protocol and register the `statewright-claude` OAuth client.

If browser sign-in is unavailable, run this in a separate terminal on the same
machine and in the same Claude configuration scope:

```sh
claude mcp login plugin:statewright:statewright --no-browser
```

Open its link on a browser-capable computer and paste the full callback URL
into that terminal. Return to Claude and connect again. Do not paste tokens or
callback URLs into the conversation. Both paths require the native Claude CLI;
automatic browser sign-in also requires Expect.

## Upgrade from manual hooks

Marketplace-only installations upgrade under the same
`statewright@statewright` identity. If you previously ran `setup.sh` or installed
Statewright hooks directly in settings, the plugin update cannot remove them.

Close affected Claude sessions first. From this plugin directory, preview the
cleanup using the exact old plugin directory named in your settings:

```sh
node scripts/migrate-native.mjs --settings /absolute/path/to/settings.json \
  --legacy-root /absolute/path/to/old/claude-code
```

Review the reported positions. Repeat with `--apply` only after review; pass
additional `--legacy-root` arguments for distinct old installations. The tool
removes only exact legacy commands, retains a private byte-for-byte backup,
and preserves unrelated hooks, permissions, plugin settings and credentials.
Custom/ambiguous Statewright commands require manual review, not guessing.
Check user and project settings separately. Do not edit settings concurrently.

Also remove a separately configured legacy Statewright MCP server through
Claude's MCP settings, if present, and stop using the old managed Claude launcher.
Do not remove other servers or grant blanket tool permissions. Never run the old
`setup.sh` to repair a native installation; it now exits without changing anything.

## Troubleshooting and limits

- **No Arbiter:** send the first message in Desktop Code → Local, then check
  `/status` and `/plugin`. Organization policy may prevent mods from loading.
- **Missing Statewright tools:** reload plugins; if tools remain missing, quit
  and reopen the affected Claude host, then resume the conversation.
- **Connection needs attention:** open the sidebar for the failed step. A native
  permission denial is not an OAuth failure; signing in again does not fix it.
- **A command was denied:** preserve the refusal. Shell classification can be
  conservative; do not retry the denied operation through another interpreter.
- **Model unavailable:** only the recognized Fable usage-credit gate has an
  adapter fallback to Opus at the same effort. Other provider/policy failures
  remain visible; partial responses are never replayed.
- **Enforcement boundary:** native tool hooks check the call presented before
  permission settlement. A host-side argument rewrite after that check may
  execute without another pre-check; post-call input comparison is detection,
  not prevention. Statewright does not replace Claude's own authorization.

## Development

`node --test plugins/claude-code/tests/*.test.mjs` runs source tests from the
repository root. `claude plugin validate plugins/claude-code` and
`claude plugin test plugins/claude-code` exercise the native plugin contract.
Fixture passes do not replace live OAuth, TUI or Desktop acceptance.

See [Statewright docs](https://statewright.ai/docs),
[Claude mod support](https://code.claude.com/docs/en/plugins/mods/overview), and
[the repository](../../README.md).
