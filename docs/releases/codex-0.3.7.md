# Statewright for Codex 0.3.7

This patch updates native error reporting. Limited, scrubbed Sentry/GlitchTip
diagnostics run automatically for connection, permission, command and plugin
failures, including failures before login and on fatal exit. The reporter no
longer asks for or reads the website recording preference. Reports exclude
prompts, source code, commands, credentials, paths, account identifiers, raw
exception messages and stacks. Delivery failure does not retry a command or
change its outcome.

Website session recording remains off until you turn on its single switch.
Umami pageview analytics remains independent. `STATEWRIGHT_SENTRY_DISABLED=true`
is reserved as an operator emergency control, not a user telemetry preference.

Install or update `statewright@statewright` through the Codex plugin manager.
Restart an affected client when its work is idle. This plugin update does not
change saved credentials, command permissions or workflow definitions and does
not deploy a gateway or website.
