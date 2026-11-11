# Statewright for Codex 0.3.6

This patch release gives the changes prepared under the withdrawn
`codex-v0.3.5-r1` publication a distinct plugin version. The original 0.3.5
release remains available; the withdrawn revision's tag remains for provenance.
Version 0.3.6 is rebuilt from source, with matching manifest, runtime and
archive versions.

## What changed

- Preserve foreground conversation ownership across background summaries and
  keep workflow discovery available through connection and cold-resume paths.
- Retain the MCP runtime when a plugin cache entry is removed, so an existing
  proxy does not depend on a deleted package directory.
- Explain classifier denial causes and approval availability without promising
  a dialog that has not been submitted. Repository validation commands still
  require their applicable execution authority.
- Refresh documentation examples and source references.

The accompanying gateway source adds web-specific workflow guidance and visible
confirmed-transition receipts. Web connectors retain the chat's selected model;
they do not acquire terminal hooks or native model routing. See the
[web workflow guide](https://github.com/statewright/statewright/blob/codex-v0.3.6/docs/web-workflow-execution.md) for continuation and event
delivery limits. Installing the plugin does not deploy a self-hosted gateway.

This release does not change credentials, native permissions or workflow
definitions during installation. Existing clients keep their loaded code until
an ordinary idle restart.

## Upgrade

Refresh the marketplace and reinstall through the native plugin manager:

```sh
codex plugin marketplace add statewright/statewright
codex plugin add statewright@statewright
```

Restart the affected client when its work is idle. If a resident is preserving
detached work, let that work finish before restarting it. Check uncertain sends
before manually repeating them. Your saved gateway credentials, permissions
and workflows are unchanged. This plugin update does not require a gateway,
website or Claude upgrade.

## Boundaries

This patch does not add Desktop chat forking or change model-routing guarantees.
The [0.3.4 release boundaries](https://github.com/statewright/statewright/blob/codex-v0.3.6/docs/releases/codex-0.3.4.md#boundaries-and-known-limitations)
still apply.
