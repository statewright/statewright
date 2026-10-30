# Statewright for Codex 0.3.5

## Revision 1

`codex-v0.3.5-r1` updates the 0.3.5 release line. It retains the plugin's
0.3.5 version and uses a new release tag; the original tag is unchanged.

- Preserve foreground conversation ownership across background summaries and
  keep workflow discovery available through connection and cold-resume paths.
- Retain the MCP runtime when a plugin cache entry is removed, so an existing
  proxy does not depend on a deleted package directory.
- Explain classifier denial causes and approval availability without promising
  a dialog that has not been submitted. Repository validation commands still
  require their applicable execution authority.
- Refresh documentation examples, release labels and source references.

The accompanying gateway source adds web-specific workflow guidance and visible
confirmed-transition receipts. Web connectors retain the chat's selected model;
they do not acquire terminal hooks or native model routing. See the
[web workflow guide](../web-workflow-execution.md) for continuation and event
delivery limits. Installing the plugin does not deploy a self-hosted gateway.

This revision does not change credentials, native permissions or workflow
definitions during installation. Existing clients keep their loaded code until
an ordinary idle restart. The upgrade instructions below still apply.

## Original 0.3.5 release

This maintenance release fixes the first-send failure after resuming or forking
a conversation in the managed Codex TUI.

## What changed

- Bind routing ownership after Codex confirms a successful start, resume or
  fork. A fork belongs to the returned child, not its source conversation.
- Preserve the previous owner and pending classifier approval when attachment
  fails, is cancelled, or conflicts with a concurrent ownership change.
- Report an actionable attachment error without disconnecting the transport.
  Optional diagnostic reports follow your existing telemetry choice and exclude
  prompts, commands, paths and thread identifiers. Messages are never resent
  automatically.

## Upgrade

Refresh the marketplace and reinstall through the native plugin manager:

```sh
codex plugin marketplace add statewright/statewright
codex plugin add statewright@statewright
```

Restart the affected client when its work is idle. Existing processes keep
their loaded runtime; installation does not restart active conversations.
If a resident is preserving detached work, let that work finish before
restarting it. Check uncertain sends before manually repeating them.

Your saved gateway credentials, permissions and workflows are unchanged.
This is a Codex plugin update; no gateway, website or Claude upgrade is needed.

## Validation and boundaries

Regression tests cover ownership, cancellation, native refusal and malformed
responses. A native protocol canary covers start/send, fork/send and
restart/resume/send using a local rejecting provider, without real inference
or user history. Live managed-TUI testing confirmed the repaired resume path.

This does not add Desktop chat forking or change model-routing guarantees.
The [0.3.4 release boundaries](codex-0.3.4.md#boundaries-and-known-limitations)
still apply.
