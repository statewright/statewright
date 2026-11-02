# Telemetry and privacy

Statewright runs limited Sentry/GlitchTip error diagnostics automatically for
the website and supported native plugins. These reports help identify connection,
credential-store, permission, command and plugin failures. They are not a
telemetry preference and do not depend on login or an account grant.

**Website session recording is optional.** It starts off and requires you to
turn on the **Session recording** switch in website telemetry preferences. You
can turn it off at any time. An older explicit combined telemetry grant retains
its recording choice; an unversioned grant does not enable recording. Native
plugins do not start website session recording.

Basic website analytics through Umami runs independently of recording. Choosing
whether to record a website session does not change login, workflows, host
permissions, or the limited error diagnostics.

## What error reports contain

Reports contain a fixed failure category, operation category, plugin version,
platform and, when available, a numeric status or exit code. They can describe
pre-login and fatal-exit failures. They exclude prompts, source code, commands,
credentials, filesystem paths, account identifiers, workflow contents, raw
exception messages and stacks. Reports are deduplicated and attempts are capped
per process. Failed delivery does not change the operation's outcome or replay
a command. Nothing is queued for later upload.

Reports go to Statewright's self-hosted GlitchTip service using Sentry
envelopes. `STATEWRIGHT_SENTRY_DISABLED=true` remains an operator emergency
control for outages and isolated test environments; it is not an additional
telemetry preference.

Website recordings are different from error reports: they capture page
interactions with form-input masking. Receiving infrastructure necessarily
handles network data such as IP addresses. Payload filtering alone is not a
claim of anonymity or GDPR compliance; retention, access controls and the
operator's privacy notice still apply.
