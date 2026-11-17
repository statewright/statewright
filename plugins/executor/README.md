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

Supported host names are `pi`, `opencode`, `cursor`, and `omx`. `--host claude` is refused: Claude Code is plugin-native, so install the Statewright Claude Code plugin (or use `statewright-managed-client --host claude`) instead. Use `--plugins-root` or `STATEWRIGHT_PLUGINS_ROOT` when the adapter directories are not siblings of `plugins/executor`.

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

## Codex resume-history guard

Managed Codex resumes inspect the canonical local rollout before starting the
native TUI. Statewright fails closed when a paginated rollout would feed a
known-stale projection or contains any unfamiliar ordinal anomaly. It never
reads or rewrites another thread.

The default `guard` mode prints an actionable error without modifying history.
Set `routing.managed_clients.codex_history_repair` to `auto` in
`~/.statewright/config.json`, or set `STATEWRIGHT_CODEX_HISTORY_REPAIR=auto` for
one launch, to repair the one recognized Codex defect: a restart-generated
`thread_settings_applied` record that repeats the immediately preceding
ordinal. Automatic repair:

1. mirrors Codex's coordination-plus-per-thread writer-lock lifecycle and
   revalidates the canonical filename, ordinal-zero session metadata, and
   embedded thread identity;
2. creates a mode-0700 backup under `~/.codex/backups` containing the exact
   rollout, a consistent projection-database backup, checksums, and rollback
   instructions, with the backup directory entry synced before any canonical
   replacement;
3. validates a candidate rollout with contiguous ordinals, then compares the
   source inode, size, modification time, and hash immediately before atomic
   replacement; and
4. deletes only that thread's derived projection rows so Codex rebuilds them
   from the repaired canonical rollout.

Any JSON error, ordinal gap, other regression, ambiguous rollout, unavailable
SQLite backup API, or failed integrity check aborts without applying the
repair. Automatic repair currently requires a POSIX runtime with Perl `flock`
and Node's `node:sqlite` backup API; unsupported platforms retain fail-closed
guard mode. `off` disables the preflight and is intended only as an explicit
diagnostic escape hatch.

The guard follows the child's effective storage configuration: `CODEX_HOME`
for sessions and writer locks, and a command-line or top-level TOML
`sqlite_home`, then `CODEX_SQLITE_HOME`, for the derived database. A configured
root that cannot be resolved blocks the resume instead of inspecting or
resetting a different default path. Compact `-c` forms are recognized;
`-C/--cd` anchors relative CLI and environment paths, while a relative
top-level TOML path is anchored to the Codex config directory.

## Isolated delivery

If `.statewright/delivery.json` is present and enabled, the executor prepares the configured worktrees before the TUI starts. Project-owned Taskfile hooks perform preview setup, deployment, validation, promotion, and cleanup. The executor pins the hook bundle, restricts its environment, journals promotion, and refuses workflows that require delivery when no verified delivery owner exists.

The Codex marketplace plugin contains a generated copy of this delivery core so its git-subdir package remains standalone. Run `task plugins:sync-executor-core` after changing executor delivery modules; the Codex regression suite rejects drift.
