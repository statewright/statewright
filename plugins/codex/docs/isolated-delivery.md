# Isolated delivery

Statewright's Codex adapter automatically looks for
`.statewright/delivery.json` in the working directory and then each parent
directory. No command-line flag is required.

## On and off

- No config file: delivery stays dormant.
- Config file present: delivery is enabled by default.
- `"enabled": false`: delivery is disabled.
- `--delivery-config PATH`: use an explicit config instead of discovery.

A workflow that declares delivery `required` stops before task work when
delivery is dormant or disabled.

## Minimal configuration

```json
{
  "enabled": true,
  "workspace": {
    "repositories": [
      {
        "name": "app",
        "path": "..",
        "target_branch": "main"
      }
    ]
  },
  "preview": {
    "driver_root": "delivery-driver",
    "bundle_sha256": "<sha256-of-the-driver-directory>"
  }
}
```

Paths are relative to `.statewright/delivery.json`. The first repository is
primary unless another entry has `"primary": true`.

Defaults:

- `version`: `1`
- `workspace.mode`: `git_worktree`
- `workspace.root`: `~/.statewright/delivery-runs`
- repository `base_ref`: its `target_branch`
- `preview.driver_root`: `.statewright/delivery-driver`
- `preview.driver`: `preview-delivery.mjs`
- `preview.action_timeout_ms`: `1800000`
- `promotion.mode`: `manual`

Repository paths, target branches, sensitive environment variables, and
`preview.bundle_sha256` remain explicit. Statewright will not guess a merge
target, silently grant credentials, or trust mutable deployment code.

## Multiple repositories

Add repository entries to `workspace.repositories`. Each run receives one
isolated worktree per repository. Set exactly one explicit primary when the
first entry should not be primary.

## Promotion

Set `"promotion": { "mode": "squash" }` to let a delivery workflow perform its
guarded promotion state. The default `manual` mode preserves the validated
preview and requires an operator-managed merge.

The adapter snapshots the trusted preview driver, checkpoints the run
worktrees, validates and deploys the exact source fingerprint, and refuses
cleanup before successful promotion.
