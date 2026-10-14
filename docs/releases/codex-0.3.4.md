# Statewright for Codex 0.3.4

This release adds browser onboarding, managed Desktop continuity and
more precise shell-command classification.

## What changed

- **Start with engineering.** Ask to use the engineering workflow for a fix,
  feature, refactor or investigation. The `agentic-engineering` starter includes
  baseline evidence, validation, review and a bounded repair round. Existing
  workflows are preserved; the old `bugfix` starter can be deleted.
- **Connect in a browser.** Confirm a device code and sign in to Statewright.
  The plugin verifies the returned credential and stores it in macOS Keychain,
  Windows Credential Manager or Linux Secret Service, keyed by gateway.
  A connection failure does not silently open a browser or replay an action.
- **Resume local Desktop conversations.** The macOS launcher allocates a
  separate workflow/App Server lane for each selected local Codex-backed chat,
  including historical conversations. It preserves the project and refuses a
  second managed writer to the same thread. Loading history is not activation.
- **Keep the native app identity.** The launcher uses the installed ChatGPT app
  and its bundled Codex executable. It does not patch the app. Verified runtime
  snapshots outside the plugin cache survive cache cleanup.
- **Preserve resume permissions.** The destination thread retains its saved
  effective permissions and workspace roots. Explicit CLI overrides take
  precedence through the compatibility transport. Unsupported permission
  shapes are rejected rather than widened.
- **Follow model handoffs.** The App Server adapter consumes successive
  workflow route receipts and applies routes at turn boundaries. A requested
  route and an observed provider response remain distinct evidence.
- **Keep questions available.** Non-blocking native questions remain
  interactive while independent work proceeds. Silence, dismissal and a
  preselected default never grant approval.
- **Classify command effects.** Bounded shell analysis preserves known reads,
  writes, network and destructive effects across supported wrappers and command
  shapes. Opaque programs and unsupported syntax remain conservative.
  Repository-code execution is not reclassified as a read merely because its
  entrypoint is known.
- **Keep ownership and recovery scoped.** Local hooks, remote connectors,
  workflow approvals and credentials stay bound to their owning session.
  Explicit remote destinations do not inherit another managed session's identity.
- **Choose whether to send diagnostics.** Supported plugin failures can send a
  small report under your Statewright account's optional telemetry choice.
  Older recording-only approvals do not enable plugin reports, and local
  opt-outs take precedence. Reports exclude commands, prompts, credentials and
  exception text. [Details and opt-out](../guides/optional-telemetry.md).

## Install or upgrade

Use the native Codex plugin manager, then restart the affected session:

```sh
codex plugin marketplace add statewright/statewright
codex plugin add statewright@statewright
```

Ask Codex to call `statewright_connect` and confirm the matching browser code.
Existing production key-file migration is retained for compatibility, but
non-production gateways never borrow that key.

See the [Codex integration reference](../../plugins/codex/README.md),
[OAuth guide](https://docs.statewright.ai/getting-started/oauth-login) and
[Desktop guide](https://docs.statewright.ai/plugins/codex-desktop).

## Boundaries and known limitations

The local Desktop launcher is experimental and macOS-only. It applies to
Codex-backed conversations, not ordinary cloud ChatGPT chats. A remote
Statewright connector can run a workflow in ChatGPT web, but cannot switch the
host-selected model.

Desktop chat forking and profile-wide settings writes through the multi-chat
broker are not supported. Per-chat settings stay with their owner. Resident
lanes are bounded; active work is never evicted to make room for another chat.

Shell classification may reject legitimate commands. Explicit workflow
capabilities, command restrictions, environment policy and approval gates still
apply. A semantic judgment cannot override a known write, destructive or
external effect. An eligible uncertain invocation may request scoped human
review; that is not a blanket bypass or recovery of a terminal blocked run.

Native approval forms are available only when the owning account and host can
present the decision. Cancellation, disconnect, expiry, identity mismatch or an
unsupported host leaves work pending or denied. Provider telemetry is exact
only when a supported native event is present; missing data is not zero usage.

## Validation scope

Validation includes native TUI workflow completion and model handoffs, macOS
Desktop historical-chat recovery and workflow completion, plus staging OAuth
and account-authorized diagnostic delivery. Source, packaging and native
protocol checks complement those journeys; they are not substitutes for them.
Cross-platform release assets have their own build and artifact-smoke gates.
