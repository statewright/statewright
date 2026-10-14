# Optional telemetry

Statewright asks for one optional telemetry choice on its website. The current
wording covers website session recordings and diagnostic
reports from connected plugins. Declining does not limit workflows or change
your host's permissions. An older recording-only approval does not authorize
plugin diagnostics; accept the new wording if you want to enable them.

Basic website analytics through Umami runs independently of this choice.
Declining optional telemetry stops session recording and diagnostic reports,
not basic website analytics.

When signed in, **Telemetry preferences** saves this choice to your Statewright
account. Supported plugins follow that account's choice for the gateway they
are connected to. An anonymous browser choice alone does not authorize a plugin.
This preference is separate from OAuth login, command permissions and workflow
approvals. Statewright does not inherit permission from Claude or OpenAI.

## Turn it off

- On the website, open **Telemetry preferences** and choose **Decline telemetry**.
- In Claude, run `/statewright configure` and turn **Diagnostic reports** off.
  This veto applies even when your account allows telemetry.
- For Node-based integrations, set `STATEWRIGHT_SENTRY_DISABLED=true` in the
  launching environment. `STATEWRIGHT_SENTRY_ENABLED=false` also disables them.

Website account preferences refresh on focus and periodically (normally within
a minute). Claude requires a recently verified account preference, no older
than one minute, and receives updates with its workflow reads. Node reporters
query the authenticated account service before sending. Missing, stale or
unavailable consent means no account-authorized report. An event already sent
cannot be recalled by changing the setting.

For a deliberate diagnostic session, `STATEWRIGHT_SENTRY_ENABLED=true` is an
explicit local opt-in. A local disable or a known account withdrawal still wins.
Pre-login failures cannot infer an account grant. Fatal Node exits cannot wait
for an account lookup, so their bounded exit-time reporter requires this local
opt-in. Nothing is queued for retrospective upload after you sign in.

## What plugin reports contain

Reports contain a fixed failure category, operation category, plugin version,
platform and, when available, a numeric status or exit code. They can describe
connection, credential-store, permission, command and plugin failures without
including the command or its output. Exception messages and stacks are withheld.
Prompts, source code, credentials, filesystem paths, account identifiers and
workflow contents are excluded from these reports.

Reports go to Statewright's self-hosted GlitchTip service using Sentry envelopes.
Repeated failures are deduplicated and attempts are capped per process. Failed
delivery does not change the original operation's outcome or replay a command.

Website recordings are different from plugin reports: they capture page
interactions with form-input masking. Receiving infrastructure necessarily
handles network data such as IP addresses. Payload filtering alone is not a
claim of anonymity or GDPR compliance; retention, access controls and the
operator's privacy notice still apply.
