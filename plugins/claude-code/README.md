# Statewright for Claude Code

The 0.4.0 candidate includes the Arbiter, workflow sidebar, compact tool results and
per-state model routing to Claude Code and **Claude Desktop → Code → Local**.
Use ordinary Claude; no separate app or Statewright launcher is required.

Use Claude Code 2.1.295 or newer. Desktop bundles its own Code engine: check
`/status` inside a Code conversation, not only the Desktop application version.
This integration is not for the ordinary Chat tab or Cowork.

See the [Claude Desktop guide](https://docs.statewright.ai/plugins/claude-desktop)
for the first-message startup, clickable pills, workflow map, result details
and connection recovery.

## Install and connect

In Claude Code:

```text
/plugin marketplace add statewright/statewright
/plugin install statewright@statewright
```

For an existing install, run `claude plugin update statewright@statewright`
in a terminal. Reload an open conversation with `/reload-plugins`.
Installation is shared with Desktop Code.

If the old installation used `setup.sh` or hooks added directly to settings,
complete [Upgrade from manual hooks](#upgrade-from-manual-hooks) before starting
a workflow. Plugin updates do not remove those hooks; do not run the native
and legacy integrations together.

The Arbiter appears when the Code conversation starts. Select its connection
status to open the sidebar, then **Connect**. In Desktop, this opens Claude's
`/mcp` dialog: select Statewright and choose **Connect** there. Finish browser
sign-in, then fully quit and reopen Desktop and resume the conversation if its
connection has not updated. Desktop cannot reconnect the server mid-session.
The terminal uses the native CLI sign-in helper. Claude owns OAuth credentials
and refresh; a Statewright API key file is not required.

The shared managed-client credential adapter can also retrieve a missing native
helper from the matching published Claude plugin release, verifying source/tag,
SHA256 and cached bytes. This does not replace Claude's native OAuth handling.

The connection and permission to control a conversation are separate.
An existing login can restore without another browser visit. Workflow-control
consent is scoped to the live session; reloading or closing it clears that grant.
It does not override file/command permission rules or workflow approvals.

## Use a workflow

Limited error diagnostics run automatically through Statewright's self-hosted
GlitchTip service. Reports exclude prompts, commands, code and credentials.
Website session recording is a separate opt-in. See
[telemetry and privacy](../../docs/guides/optional-telemetry.md).

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

The marketplace package binds the literal URL `https://mcp.statewright.ai/mcp`.
Desktop checks the raw `.mcp.json` URL during sign-in and does not resolve
`${user_config.*}` there. The old **Statewright gateway** preference has been
removed; `/statewright configure` now contains appearance preferences only.

For another gateway, prepare a separate plugin distribution from source with
your literal HTTPS MCP endpoint in `plugins/claude-code/.mcp.json` before
packaging. Keep its native server identity and OAuth declaration intact. Your
service must support the native Claude control protocol and register the
`statewright-claude` OAuth client. Restart Desktop after changing that package's
configuration. Do not edit installed caches: the next update replaces them.
Existing custom-gateway users need that custom package before upgrading;
the marketplace package does not use the old saved gateway preference.

If browser sign-in is unavailable, run this in a separate terminal on the same
machine and in the same Claude configuration scope:

```sh
claude mcp login plugin:statewright:statewright --no-browser
```

Open its link on a browser-capable computer and paste the full callback URL
into that terminal. In the terminal host, return to Claude and check the saved
connection; the plugin attempts one scoped reconnect on missing authentication.
For Desktop, use `/mcp` → Statewright → **Connect** instead of this CLI fallback,
then fully restart Desktop if the live session remains disconnected. CLI
`Connected` does not establish Desktop authentication. The literal-URL fix
plus full Desktop restart was reported working on engine 2.1.321; importing an
external CLI credential alone has not been separately verified.
Do not paste tokens or
callback URLs into the conversation. The terminal fallback requires the native
Claude CLI; its automatic browser helper also requires Expect. Desktop sign-in
uses neither helper.

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
- **Signed in but still disconnected:** `reconnect/reconnect_unavailable` means
  the host refused connection reload. `reconnect/credential_reload_pending`
  means the login helper completed but the session still reports missing auth.
  The sidebar keeps that diagnosis and offers **Check saved connection**;
  successful sign-in is not repeated in that view. Only a verified connection
  and catalog response enable workflows. A fresh session or plugin reload
  clears the in-memory diagnosis; it does not prove credentials were imported.
- **Desktop says the plugin points at a different server URL:** verify the
  installed package has a literal URL in `.mcp.json`, then fully restart
  Desktop. `expected=<unparseable>` in `verifyPluginMcpBinding` is consistent
  with Desktop reading an unresolved URL placeholder. Reloading only the
  plugin is not a substitute for the restart in the confirmed recovery.
- **A command was denied:** preserve the refusal. Shell classification can be
  conservative; do not retry the denied operation through another interpreter.
- **Model unavailable:** only the recognized Fable usage-credit gate has an
  adapter fallback to Opus at the same effort. Other provider/policy failures
  remain visible; partial responses are never replayed.
- **Enforcement boundary:** native tool hooks check the call presented before
  permission settlement. A host-side argument rewrite after that check may
  execute without another pre-check; post-call input comparison is detection,
  not prevention. Statewright does not replace Claude's own authorization.

## Classifier reviews and timed approvals

When Statewright cannot establish a command's effects, the native plugin may
ask you to deny it, allow it once, or allow the exact invocation for 2, 4, or
8 hours or until its binding changes. The workflow's
`meta.approval_memory.approve_for` selects the initial choice, except that
**Always** is never preselected; a missing default, `approve_for: always`, or
an empty duration list starts at **Allow once**. **Always** remains an explicit
human choice. The gateway's single `STATEWRIGHT_APPROVAL_ALWAYS` switch is
`on` by default; set it to `off` to remove **Always** from the picker and
reject both new and existing Always grants. `allowed_durations` limits the
timed choices. If dependency provenance is
incomplete, or the gateway has no reusable-grant key and durable history,
only **Deny** and **Allow once** are offered. Claude's own permission prompt
may still follow. A timed choice skips only Statewright's classifier review
for the exact command and session working directory while the policy and
captured dependencies remain unchanged; Statewright may
miss changes to executable contents it did not capture.

Use `/statewright approvals revoke` or **Revoke approvals for this project** in
the sidebar to revoke timed and Always grants. The plugin first asks the
gateway to revoke every grant you hold for this project (the gateway records a
cutoff time and rejects any token issued at or before it, in any conversation,
including copies), then removes the saved tokens from the plugin store. If the
gateway can't be reached, the message says so: the local copies are still
removed, but a copied token keeps working until it expires (Always: until a
gateway revoke succeeds, `STATEWRIGHT_APPROVAL_ALWAYS=off`, or the signing key
rotates). If project scope is unavailable, the command removes all saved tokens
and revokes the conversation scope at the gateway. Timed grants require a
gateway signing key and durable approval history; without them, only one-time
approval is available.

Each review id is bound to the MCP connection (`Mcp-Session-Id`) the plugin
used when Statewright issued it. A grant or decline arriving on any other
connection is rejected, and the attempt consumes the id. Reopening the
Statewright connection mid-review therefore cancels that review; Statewright
asks again on the next attempt.

### Known risks

- **Reading Claude's credential store.** The gateway authenticates the plugin
  with Claude's own stored Statewright MCP credential (macOS Keychain item
  `Claude Code-credentials`; `~/.claude/.credentials.json` on Linux). On macOS
  that item can be released to any process running as you without a Keychain
  prompt. An agent that reads it could open its own MCP connection and run the
  whole review flow there, approving its own commands. The gateway can't tell
  that connection from the plugin's: both hold the same credential, and the
  plugin's store is readable by the same user. Statewright therefore treats
  reads of these stores (`security find-generic-password`, `dump-keychain`,
  `.credentials.json`, `secret-tool lookup`, Statewright's own key files) as
  known risk: they are denied and never offered for review. That screen is
  lexical and best effort; Claude's own permission prompt is the other control.
- **A legacy `mcp__statewright__*` server.** The legacy shell hook only
  recognises the `statewright` server when its configured URL is a Statewright
  gateway (see `STATEWRIGHT_URL`).

## Development

`node --test plugins/claude-code/tests/*.test.mjs` runs source tests from the
repository root. `claude plugin validate plugins/claude-code` and
`claude plugin test plugins/claude-code` exercise the native plugin contract.
Fixture passes do not replace live OAuth, TUI or Desktop acceptance.
Track each Claude Desktop/embedded-engine/CLI and Codex Desktop/engine/CLI
release separately using [host release compatibility](../../docs/releases/host-compatibility.md).

See [Statewright docs](https://statewright.ai/docs),
[Claude mod support](https://code.claude.com/docs/en/plugins/mods/overview), and
[the repository](../../README.md).
