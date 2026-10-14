# Statewright for Claude 0.3.4

Statewright now runs as a native Claude plugin in the terminal and in
**Claude Desktop → Code → Local**. Keep using the ordinary Claude app and CLI;
no Statewright app wrapper is needed.

## What changed

- **Start with engineering.** Ask to use the engineering workflow for a fix,
  feature, refactor or investigation. The `agentic-engineering` starter includes
  baseline evidence, validation, review and a bounded repair round. Your existing
  workflows stay available; the old `bugfix` starter can be deleted.
- **An Arbiter in your conversation.** See the current workflow state, available
  events, model and effort. Open the sidebar to choose and start a workflow,
  reconnect, or turn it Off. Named workflow requests use the same integration.
- **Compact results.** State changes read as previous state → new state, with
  the outcome, allowed tools and disposition. Expand Details for the original
  JSON; the summary does not replace the evidence.
- **Native sign-in.** Claude manages Statewright OAuth and saved credentials.
  Gateway selection is a plugin preference. SSH users can complete native
  sign-in from another browser-capable computer.
- **Per-state model routing.** Workflow routes select Claude equivalents for
  native main-conversation requests. Receipts distinguish requested settings
  from the response's observed model and available token counts. A recognized
  Fable usage-credit gate falls back to Opus at the same effort; partial
  responses, ordinary errors and permission refusals are not replayed.
- **A smaller status display.** Desktop uses clickable pills. Terminal users
  can opt into Powerline and override that preference for the current session.
- **Optional failure reports.** Native connection, permission and command
  failures can send a small diagnostic report under your Statewright telemetry
  choice, with a plugin-local opt-out. Reports never include command contents,
  prompts or credentials. [Details](../guides/optional-telemetry.md).

## Install or upgrade

Use Claude Code engine 2.1.295 or newer. Desktop has its own engine; check
`/status` inside a Code conversation. Install or update `statewright@statewright`
through Claude's plugin manager, then reload plugins in open conversations.

Follow [installation, connection and migration instructions](../../plugins/claude-code/README.md).
If you installed manual hooks previously, preview the included migration before
applying it. It preserves unrelated settings and creates a private backup.
The old `setup.sh` no longer installs command hooks.

## Boundaries

This integration does not add the Arbiter to ordinary Desktop Chat or Cowork.
Claude permission prompts and Statewright workflow approvals remain separate;
connecting does not approve commands or file changes. Off restores the
host-selected model.

Shell classification can still reject valid read-only commands. Preserve the
refusal instead of trying the same operation through another executable.
Native pre-permission checks also cannot prevent a later host-side argument
rewrite from executing without another check; post-call comparison detects that
case but is not prevention.

## Validation scope

Validation includes consumer-plugin workflow completion in the TUI and macOS
Desktop Code → Local, plus native model-routing and result-rendering checks.
Staging account consent, OAuth and installed Node diagnostic delivery were
tested separately; native Claude diagnostic dispatch is covered by engine
contract tests, not a fresh live Desktop failure injection. Legacy shell
transport tests are not acceptance evidence for the native plugin.
