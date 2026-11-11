# Statewright for Claude Code 0.3.9

Unpublished release candidate. Claude's native Arbiter, sidebar and main-conversation
routing remain the supported consumer integration.

This candidate synchronizes the shared managed-client runtime, retaining the
Windows cleanup diagnostics and owned-process shutdown handling shipped in 0.3.8.
It also carries the shared checkpoint ownership and history-integrity repairs.
Native Claude and Codex runtime copies are checked against their shared source
before packaging.

The Codex native approval dialog and its eight-hour canary are not Claude UI
acceptance. Claude's native integration and the packaged release need their own
exact-source CI and installed-host validation before publication. Production
local semantic authorization is not enabled by this release.
