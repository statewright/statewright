# Isolated delivery

Isolated delivery gives a Codex task its own Git worktrees and routes preview
lifecycle actions through project-owned Taskfile tasks. Statewright controls
when those tasks run, which task names are allowed, what environment crosses
the trust boundary, and which source fingerprint was deployed and validated.

Statewright does not prescribe Kubernetes, Docker Compose, database snapshots,
or a migration tool. Those details stay in the project Taskfile.

## Requirements

- Statewright's Codex plugin and a Statewright API key.
- A local Statewright checkout for the delivery launcher.
- [Task](https://taskfile.dev/) 3.x available as `task`.
- Git repositories with the configured base and target refs.
- A workflow with `workspace.mode: "git_worktree"` and
  `preview.mode: "taskfile"`.

The adapter searches the current directory and its parents for
`.statewright/delivery.json`.

- No config file: isolated delivery stays dormant.
- Config present: isolated delivery is enabled.
- `"enabled": false`: isolated delivery is disabled.
- `--delivery-config PATH`: use an explicit config.

A workflow that marks workspace or preview delivery as required stops before
task work when delivery is dormant or disabled.

## 1. Define project hooks

Create `.statewright/delivery-hooks/Taskfile.yml`:

```yaml
version: "3"

tasks:
  delivery:prepare:
    cmds:
      - ./ops/preview prepare "$STATEWRIGHT_DELIVERY_MANIFEST"

  delivery:deploy:
    cmds:
      - ./ops/preview deploy "$STATEWRIGHT_DELIVERY_MANIFEST"

  delivery:validate:
    cmds:
      - ./ops/preview validate "$STATEWRIGHT_DELIVERY_MANIFEST"

  delivery:discard:
    cmds:
      - ./ops/preview discard "$STATEWRIGHT_DELIVERY_MANIFEST"
```

The commands are examples. A project can use `pg_dump`, volume snapshots,
fixtures, migrations, Docker Compose, Kubernetes, a cloud preview API, or a
local process. Each task must exit nonzero when it cannot prove its action
completed.

The final stdout line may be a JSON object:

```json
{"ok":true,"action":"validate","preview_url":"https://preview.example.test"}
```

Statewright records that object with the task name, duration, output byte
counts, and output SHA-256 values. Large or sensitive logs should be written to
the run evidence directory rather than stdout.

## 2. Pin the hook bundle

Statewright snapshots the hook directory before Codex opens the isolated
worktree. Generate its digest with:

```bash
node /path/to/statewright/plugins/codex/scripts/statewright-delivery.mjs \
  digest --root .statewright/delivery-hooks
```

The command prints JSON containing `sha256`. Recalculate it whenever the
Taskfile or any supporting file under the hook root changes.

The hook root cannot contain symbolic links. Statewright rejects a digest
mismatch instead of executing changed deployment code.

## 3. Enable delivery

Create `.statewright/delivery.json`:

```json
{
  "version": 1,
  "enabled": true,
  "workspace": {
    "repositories": [
      {
        "name": "app",
        "path": "..",
        "target_branch": "main",
        "primary": true
      }
    ]
  },
  "hooks": {
    "root": "delivery-hooks",
    "taskfile": "Taskfile.yml",
    "bundle_sha256": "REPLACE_WITH_DIGEST",
    "environment_allowlist": [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL"
    ],
    "action_timeout_ms": 1800000
  },
  "preview": {},
  "promotion": {
    "mode": "manual"
  }
}
```

Paths are relative to `.statewright/delivery.json`. The first repository is
primary unless another entry sets `"primary": true`.

Add credentials to `hooks.environment_allowlist` only when a trusted project
task requires them. These variables are available to the snapshotted hooks;
they are removed from the Codex child environment.

## 4. Register the starter workflow

The repository includes
[`plugins/codex/workflows/isolated-delivery-v1.json`](../workflows/isolated-delivery-v1.json).
Register its JSON object through the Statewright MCP tool:

```text
statewright_create_workflow(
  name="isolated-delivery-v1",
  definition=<contents of plugins/codex/workflows/isolated-delivery-v1.json>
)
```

The starter workflow performs isolated implementation, local validation,
review, preview preparation, preview deployment, and preview validation. It
does not merge branches or delete the preview automatically. Replace its
`task test` command allowlist with the project's authoritative local validation
command before using it.

## 5. Start the isolated task

The marketplace plugin supplies hooks and MCP tools. The delivery launcher is
currently run from a Statewright checkout:

```bash
node /path/to/statewright/plugins/codex/scripts/statewright-codex.mjs \
  --delivery-run-id feature-123 \
  --workflow isolated-delivery-v1 \
  -- "Implement and validate the requested change"
```

Statewright creates every declared worktree before opening the Codex thread and
sets the primary worktree as its working directory.

## Task contract

The default action-to-task mapping is:

| Action | Default task | When it runs |
| --- | --- | --- |
| `prepare` | `delivery:prepare` | Before preview deployment |
| `deploy` | `delivery:deploy` | After the run worktrees are checkpointed |
| `validate` | `delivery:validate` | Only after the same fingerprint deployed |
| `lock` | `delivery:lock` | Before automatic promotion |
| `renew` | `delivery:renew` | While automatic promotion holds its lock |
| `preflight-promote` | `delivery:preflight-promote` | Before target refs move |
| `promote` | `delivery:promote` | After guarded Git promotion |
| `unlock` | `delivery:unlock` | After promotion or promotion failure |
| `teardown` | `delivery:teardown` | After successful final promotion |
| `discard` | `delivery:discard` | During explicit unpromoted-run discard |

Override task names with `hooks.actions`:

```json
{
  "hooks": {
    "actions": {
      "prepare": "preview:copy-staging",
      "deploy": "preview:apply",
      "validate": "preview:smoke"
    }
  }
}
```

Task names may contain letters, numbers, `_`, `-`, and `:`. Statewright never
passes a task name through a shell.

Every task receives:

| Variable | Meaning |
| --- | --- |
| `STATEWRIGHT_DELIVERY_ACTION` | Current lifecycle action |
| `STATEWRIGHT_DELIVERY_RUN_ID` | Safe run slug |
| `STATEWRIGHT_DELIVERY_MANIFEST` | Absolute run manifest path |
| `STATEWRIGHT_DELIVERY_PRIMARY_WORKTREE` | Primary isolated worktree |
| `STATEWRIGHT_DELIVERY_EVIDENCE_PATH` | External evidence directory |
| `STATEWRIGHT_DELIVERY_FINGERPRINT` | Exact multi-repository source fingerprint |
| `STATEWRIGHT_DELIVERY_EXECUTION_TOKEN` | Promotion lock token when applicable |

The manifest contains every repository's source path, isolated worktree path,
base commit, target branch, and target head.

## Multiple repositories

Add entries to `workspace.repositories`. Each run receives one branch and
worktree per repository. A single fingerprint covers all repository HEADs.
Automatic promotion refuses to proceed when any configured target branch moved
after the run began.

## Promotion and cleanup

The default promotion mode is `manual`. The starter workflow leaves the
validated branches and preview intact for operator review.

Automatic squash promotion requires:

- `"promotion": { "mode": "squash" }` in the config;
- a workflow promotion policy with the same mode;
- lock, renew, preflight, promote, unlock, teardown, and discard tasks suitable
  for the project's runtime.

Statewright journals each repository update and refuses cleanup until promotion
and exact source verification complete.

Discard an unpromoted run explicitly:

```bash
node /path/to/statewright/plugins/codex/scripts/statewright-delivery.mjs \
  discard \
  --delivery-config .statewright/delivery.json \
  --run-id feature-123
```

Discard requires the exact run ID, unchanged target refs, clean isolated
worktrees, and a successful project discard task.

Recover an interrupted multi-repository promotion before resuming or
discarding:

```bash
node /path/to/statewright/plugins/codex/scripts/statewright-delivery.mjs \
  recover \
  --delivery-config .statewright/delivery.json \
  --run-id feature-123
```

## Failure behavior

- Hook failure preserves worktrees and evidence for diagnosis.
- Deploy and validation evidence are keyed by source fingerprint.
- Validation cannot run without a completed deploy for that fingerprint.
- Output beyond the adapter limit terminates the hook.
- Action timeouts terminate the complete adapter process group.
- A changed hook bundle, adapter snapshot, config, repository set, branch, or
  manifest fails before lifecycle work resumes.
- Statewright does not retry a failed project task or treat unavailable
  evidence as success.

## Defaults

- `version`: `1`
- `workspace.mode`: `git_worktree`
- `workspace.root`: `~/.statewright/delivery-runs`
- repository `base_ref`: its `target_branch`
- `hooks.root`: `.statewright/delivery-hooks`
- `hooks.taskfile`: `Taskfile.yml`
- action tasks: `delivery:<action>`
- `hooks.action_timeout_ms`: `1800000`
- `preview.evidence_root`: `<workspace.root>/.evidence`
- `promotion.mode`: `manual`

Repository paths, target branches, the hook-bundle digest, and sensitive
environment variables remain explicit. Statewright does not guess deployment
targets or silently grant credentials.
