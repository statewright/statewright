# Statewright for Codex 0.3.9

Candidate notes. This document does not establish publication or installed
TUI/Desktop acceptance.

## Changes

- Preserve command effects across shell composition and require explicit
  repository-execution authority for build/test commands.
- Send eligible exhausted classifier reworks to the owning native approval
  controller. Missing ownership or unsupported presentation remains a visible
  denial; no workflow restriction is overridden by classifier approval.
- Recover failed waiting-for-review notifications and handle late native
  transport acknowledgments without accepting stale decisions.
- Align managed-client and native diagnostic version reporting with the package.
- Remember accepted classifier reviews for the workflow's configured duration
  (`once`, `2h`, `4h`, `8h`, or `always`). Reuse requires the same command,
  dependencies, owner and policy; a remembered decision does not override a
  separate workflow or host approval. The native dialog still uses
  Allow / Deny / Cancel.
- Record native human-review requests, decisions and remembered-grant reuse in
  server-side telemetry, with command context and classifier predictions.
- Verify route ownership across credential renewal and recover the exact bound
  checkpoint after a gateway restart. Preserve acknowledged manual model and
  effort choices when handing off between runs.
- Retain the Windows path-identity and owned-process shutdown fixes from 0.3.8.
- Bootstrap missing credential helpers for Git-based terminal/Desktop installs
  from the matching published release with source/tag and SHA256 verification.
  Publish standalone helper assets, including Intel macOS, alongside release ZIPs.
- Mask recognizable credential fields, cookie/auth headers and shell-quoted
  credential arguments before writing human-review records. Command targets,
  decisions and classifier predictions remain available for audit.

Local semantic authorization is restricted to explicitly configured staging/dev
environments. Production remains evaluation-only; enabling a provider alone
grants no execution authority. Uncertain, failed or ambiguous assessments require
native human review. No model weights are bundled.

The earlier staging canary verified eight-hour grant reuse and server telemetry.
This release preparation also reconciles the public 0.3.8 fixes, so those earlier
receipts do not establish acceptance of the complete new artifact. Exact-source
CI, packaged clean-install checks and fresh staging acceptance remain required.
Desktop and Windows UI acceptance must be recorded separately. See the
[repair evidence](../research/classifier-hitl-local-model-20261105.md) for source
checks and outstanding acceptance gates.
