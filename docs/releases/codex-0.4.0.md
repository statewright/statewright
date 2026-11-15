# Statewright for Codex 0.4.0

## Changes

- **Fewer repeated approval prompts.** Workflows can remember an approved command
  once, for 2, 4 or 8 hours, or indefinitely. The workflow chooses the duration;
  the dialog remains Allow / Deny / Cancel. Reuse requires matching command,
  dependencies, owner and policy. Separate host and workflow approvals still apply.
- **Clearer command review.** Approval prompts include the command and available
  classifier predictions. Eligible uncertain commands can reach native human
  review after the agent's permitted rework attempt.
- **More reliable review handoffs.** Workflow review can continue when an earlier
  Codex goal is already complete, without reopening that goal. Waiting-for-review
  notifications and reconnect handling have also been improved.
- **Better session recovery.** Credential renewal and gateway restart recovery
  preserve the owning workflow checkpoint. Acknowledged manual model and effort
  choices are preserved across handoffs.
- **Simpler credential setup.** Git-based installs can download a missing native
  credential helper from the matching published release, with source and SHA256
  verification. Helpers cover Apple Silicon and Intel macOS, Linux x64 and Windows
  x64; credentials use the operating system's credential store.
- **More useful review history.** Server-side records include review requests,
  decisions and remembered approvals, with command context and classifier
  predictions. Recognizable credentials and authentication headers are masked.

## Compatibility

Keep Codex up to date and restart the session after updating the plugin.
Windows path handling and process cleanup fixes from 0.3.8 are included.

Local model-based command authorization remains limited to explicitly configured
staging and development environments. It is not enabled for production by this
release. ChatGPT web keeps its selected model and does not gain native hook
enforcement from the terminal/Desktop plugin.
