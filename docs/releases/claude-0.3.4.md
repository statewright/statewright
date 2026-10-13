# Statewright for Claude 0.3.4 (Draft)

Statewright now runs as a native Claude plugin in the terminal and in
**Claude Desktop → Code → Local**. Keep using the ordinary Claude app and CLI;
no Statewright app wrapper is needed. This candidate has not been published.

## What changed

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

## Candidate validation

Source and native plugin contract tests cover connection recovery, scoped
consent, workflow controls, model routing, cancellation, result rendering and
migration. These tests do not establish live OAuth or platform acceptance.
Fresh consumer-identity TUI and Desktop journeys, the documentation/demo review,
and the full release and disclosure audit remain release gates. Legacy shell
transport canaries are not acceptance evidence for the new native plugin.
