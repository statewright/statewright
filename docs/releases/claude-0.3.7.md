# Statewright for Claude 0.3.7

This release aligns the Claude Code plugin version with the current 0.3.7
capability line. Version 0.3.6 was not published. The plugin behavior is the
same as [0.3.5](claude-0.3.5.md): limited, scrubbed Sentry/GlitchTip error
diagnostics run automatically, while website session recording remains off
until you turn on its single switch. Umami pageview analytics is independent.

Update `statewright@statewright` through Claude's plugin manager and reload
plugins in affected conversations when idle. This update does not alter OAuth
credentials, native permissions, workflow approvals or workflow definitions.
