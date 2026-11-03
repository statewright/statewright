# Statewright for Claude 0.3.5

This patch makes limited native Sentry/GlitchTip error diagnostics automatic.
The separate **Diagnostic reports** plugin setting is removed. Reports use
fixed failure categories and exclude prompts, source code, commands,
credentials, paths, account identifiers, raw exception messages and stacks.
They can cover pre-login and fatal-exit failures. A failed report does not
change the original operation or retry a command.

Website session recording remains off until you turn on its single switch;
Umami pageview analytics remains independent. `STATEWRIGHT_SENTRY_DISABLED=true`
is an operator emergency control, not a user telemetry preference.

Update `statewright@statewright` through Claude's plugin manager and reload
plugins in affected conversations when idle. This update does not alter OAuth
credentials, native permissions, workflow approvals or workflow definitions.
