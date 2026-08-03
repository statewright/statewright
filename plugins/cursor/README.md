# Statewright for Cursor

Statewright supports two Cursor modes:

- `statewright-exec --host cursor` uses Cursor Agent hooks for hard tool enforcement, executor-owned MCP transport, and same-chat resume across model route changes.
- Standalone IDE MCP/rules mode exposes workflow tools and instructions but remains advisory.

## Executor mode

Install and authenticate `cursor-agent`, then run:

```bash
node plugins/executor/statewright-exec.mjs \
  --host cursor --workflow bugfix --cwd "$PWD" -- \
  "Fix the failing tests"
```

The executor creates a Cursor chat with `cursor-agent create-chat`, launches the Statewright Cursor plugin against that chat, and always resumes the same chat ID. On a state route change it restarts the CLI with the new model and resumes the existing chat. The child process receives only an authenticated loopback bridge, not the remote Statewright API key.

Cursor's hooks map native tools such as `Shell`, `ReadFile`, and `StrReplace` to portable Statewright capabilities. Pre-tool policy is evaluated before execution, post-tool results are accounted to the active state, and nonfinal stop attempts are returned to the workflow.

## Standalone IDE mode

1. Build the gateway: `cargo install statewright-gateway`.
2. Copy a workflow template: `cp templates/bugfix/config.json .statewright/config.json`.
3. Merge `plugins/cursor/mcp.json` into `.cursor/mcp.json`.
4. Copy `plugins/cursor/statewright.mdc` into `.cursor/rules/statewright.mdc`.
5. Open the project in Cursor.

This mode cannot claim hard enforcement because MCP and an `.mdc` rule alone do not intercept every Cursor tool call. Use executor mode when enforcement or isolated delivery is required.

## Capability boundary

| Capability | Executor mode | Standalone IDE mode |
|------------|---------------|---------------------|
| Tool policy | Hard, native pre-tool hook | Advisory rule |
| State context | Session-start and post-tool hooks | `.mdc` rule and MCP results |
| Stop handling | Native stop hook | Advisory |
| Model routing | Restart and resume same chat | Manual |
| Isolated delivery | Shared executor | Unavailable |
