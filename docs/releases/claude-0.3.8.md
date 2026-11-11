# Statewright for Claude 0.3.8

This patch keeps the Claude plugin and capability version aligned with Codex
0.3.8. Its Claude workflow and diagnostic behavior is unchanged from 0.3.7.
The shared managed-client runtime reports the current version in diagnostics.

Update `statewright@statewright` through Claude's plugin manager and reload
plugins in affected conversations when idle. This update does not alter OAuth
credentials, native permissions, workflow approvals or workflow definitions.
