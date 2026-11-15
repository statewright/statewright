# Statewright for Claude Code 0.4.0

## Changes

- **Native Desktop sign-in.** Connect opens the host MCP dialog. Terminal sessions can reload an external sign-in once, with clear restart guidance when the host cannot reload it.

- **More reliable recovery.** Shared runtime improvements protect workflow
  checkpoints and conversation history during reconnects and credential renewal.
- **Simpler helper setup.** Where the shared credential adapter is used, a missing
  native helper can be downloaded from the matching published release with source
  and SHA256 verification. Helpers cover Apple Silicon and Intel macOS, Linux x64
  and Windows x64.
- **Windows reliability fixes.** Path handling, cleanup diagnostics and shutdown
  of owned processes retain the fixes included in 0.3.8.

## Using Statewright

Use the Arbiter and sidebar in Claude Code or **Claude Desktop → Code → Local**.
Claude continues to manage its native OAuth sign-in; no separate Statewright
launcher is required. This integration does not run in ordinary Desktop Chat or
Cowork.

Update with `claude plugin update statewright@statewright`, then reload the
conversation with `/reload-plugins`. If you previously installed manual hooks,
follow the [migration guide](../../plugins/claude-code/README.md#upgrade-from-manual-hooks)
before starting a workflow.

Codex-specific approval dialogs are not added to Claude by this release. Local
model-based command authorization is not enabled for production.
