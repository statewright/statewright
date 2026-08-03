# Statewright executor

`statewright-exec` gives supported terminal agents one Statewright execution contract. It owns the remote MCP session, API credential, workflow lifecycle, isolated delivery worktrees, and telemetry. Host plugins receive only an authenticated loopback bridge and adapt their native hooks, model controls, and continuation behavior to that owner.

## Run

From a Statewright checkout:

```bash
node plugins/executor/statewright-exec.mjs \
  --host pi \
  --workflow agentic-delivery \
  --cwd /path/to/project \
  -- "Implement and validate the change"
```

Supported host names are `pi`, `claude`, `opencode`, `cursor`, and `omx`. Use `--plugins-root` or `STATEWRIGHT_PLUGINS_ROOT` when the adapter directories are not siblings of `plugins/executor`.

The API key stays in the executor process. Child TUIs receive a short-lived loopback URL and bearer token, a single transport session identity, and an executor lease when isolated delivery is active.

## Host capabilities

| Host | Tool gate | State continuation | Model and effort routing |
|------|-----------|--------------------|--------------------------|
| Pi | Native extension | Same session | Live through `setModel` and `setThinkingLevel` |
| OpenCode | Native plugin | Same session through `session.prompt` | Live per message |
| Claude Code | Native hooks | Resume same session | Restart at route boundary |
| Cursor Agent | Native hooks | Resume executor-created chat | Restart at route boundary |
| OMX | Codex-native hooks | Host-managed | Applied at startup |

The executor does not claim a capability the host does not expose. OMX currently has hard tool enforcement and executor-owned transport, but no proven same-session route-change API.

## Isolated delivery

If `.statewright/delivery.json` is present and enabled, the executor prepares the configured worktrees before the TUI starts. Project-owned Taskfile hooks perform preview setup, deployment, validation, promotion, and cleanup. The executor pins the hook bundle, restricts its environment, journals promotion, and refuses workflows that require delivery when no verified delivery owner exists.

The Codex marketplace plugin contains a generated copy of this delivery core so its git-subdir package remains standalone. Run `task plugins:sync-executor-core` after changing executor delivery modules; the Codex regression suite rejects drift.
