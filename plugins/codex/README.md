# statewright-codex

State machine guardrails for [OpenAI Codex CLI](https://github.com/openai/codex). Per-state tool enforcement, interrupts, fork/join, approval gates.

## Read-only tool equivalents

Workflow names such as `Read`, `Grep`, and `Glob` are capabilities, not a promise
that Codex exposes tools with those exact names. The existing policy maps simple
`exec_command` reads (`cat`, `rg`, read-only `find`) to the required capability.

With `Read`, the local hook and gateway also recognize checksum generation using
`sha256sum FILE...` or `shasum -a 256 FILE...`, with an optional `--` before files.
Use explicit paths (quote paths containing spaces). This narrow form excludes
stdin, globs/expansions, other flags including manifest-check mode, and file-output
redirection. It does not authorize Python or OpenSSL. Hash output must be compared
with the expected digest before claiming verification; reading a receipt alone
does not independently verify its hash. State command restrictions still apply.

## Queued human input (Desktop and TUI)

The shared app shim keeps native non-blocking question cards interactive while
independent work continues. An additive `UserPromptSubmit` hook teaches agents
to use `request_user_input_async` when it is advertised and permitted; it runs
without a Statewright login or active workflow. It preserves other instructions
and the existing enforcement hook. Questions name the decision and affected
task, and only dependent work is parked. Pending decisions belong in the normal
handoff, not in a second task system.

The native App Server owns request IDs, answer delivery and card resolution.
The shim forwards these intact and removes only the deprecated auto-resolution
timer from explicitly non-blocking questions. Silence, a selected default or a
dismissal never grants approval. Blocking questions and approval gates are not
converted to asynchronous requests. If the host does not expose async input,
the agent records the gap and continues only authorized independent work.

Chat/SMS can later project the same request, rather than creating another
decision authority. No outbound adapter is enabled here. It would need
authenticated responders, exact request/thread/run/scope binding, expiry,
deduplication, revocation and privacy controls. See
[ADR 016](../../docs/adr/016-queued-human-input.md). Reinstall/new-session pickup
and native renderer acceptance are separate from source/transport tests.

## Install

```bash
codex plugin marketplace add statewright/statewright
codex plugin add statewright@statewright
```

After installation, call `statewright_connect`. Statewright creates a short-lived
device request and opens an authenticated approval page in your browser. Confirm
that the browser shows the same device code as the tool response, then approve.
The plugin polls in the background, verifies the returned Statewright gateway
key against a read-only endpoint, and stores it in macOS Keychain, Windows
Credential Manager, or Linux Secret Service. The native helper keys each entry
by canonical gateway URL, so production, staging, and development credentials
remain independent. It never asks you to paste the key into a Codex or ChatGPT
conversation.

The old `~/.statewright/api_key` file is consulted only for the exact production
gateway and copied into the OS credential store. It is preserved for rollback
and is never used for another gateway. Headless Linux installations without an
unlocked Secret Service fail closed; automation can still use the process-scoped
`STATEWRIGHT_API_KEY` override.

Gateway aliases use non-secret configuration in
`~/.statewright/environments.json`:

```json
{
  "gateways": {
    "staging": {
      "gateway_url": "https://staging-gateway.example/mcp",
      "auth_url": "https://staging-accounts.example"
    },
    "dev1": {
      "gateway_url": "https://dev1-gateway.example/mcp",
      "auth_url": "https://dev1-accounts.example"
    }
  }
}
```

Set `STATEWRIGHT_GATEWAY_URL` to select a configured URL directly, or
`STATEWRIGHT_ENV=dev1` to select a named profile. Unknown named environments and
gateways without an authorization-service mapping fail closed instead of
falling back to production.

If browser launch is disabled, `statewright_connect` returns the complete
approval URL and device code. `https://statewright.ai/keys` remains the manual
recovery path when device enrollment cannot be started. The tool catalog reads
the OS credential store for every request, so authenticated tools become available
in the same MCP process after approval.

### Exact native token telemetry

Native Codex hooks expose tool metadata but not provider token totals. Exact
per-response totals are explicitly enabled in Statewright configuration. Put
this in `~/.statewright/config.json` (or in a project
`.statewright/config.json` when the adapter is launched from that project):

```json
{
  "telemetry": { "codex": { "native_tokens": true } }
}
```

At the next Statewright MCP startup, the plugin creates its loopback-only OTel
exporter if Codex has no existing `[otel]` table. Restart Codex once to apply
the exporter. Statewright never overwrites an existing user-owned OTel setup.

For ordinary Codex sessions, the MCP proxy supervises a loopback-only
OTLP/HTTP JSON receiver at `127.0.0.1:4318`. For managed routed sessions, the
durable managed-client supervisor owns the same receiver before it launches a
disposable Codex child, so a model-route restart cannot kill telemetry. Codex
sends no API key to that receiver. The receiver keeps
the Statewright API key locally, discards raw OTLP records after parsing, and
durably stores only sanitized token counts and correlation identifiers before
upload. `log_user_prompt` must remain `false`.

Provider usage that arrives before its workflow binding is durably quarantined
for a five-second correlation window and reconciled when the hook publishes the
state boundary; it is never treated as a completed upload or silently
discarded. Sanitized records that remain unbound are visible on the loopback
`/v1/unbound` endpoint, retained for 24 hours, and capped at 10,000 records.
The `/health` response separates listener, delivery, and receive-protocol
health and includes protocol, build, and configuration identities so the MCP
proxy can replace a managed collector after plugin upgrades, endpoint changes,
API-key rotation, or telemetry disablement.

Codex emits `response.completed` token usage as a per-response delta. The
Statewright app-server adapter continues to treat
`thread/tokenUsage/updated.total` as cumulative. Both sources normalize to the
same token fields:

- input;
- cache-read input;
- cache-write input;
- output;
- reasoning output;
- total.

State totals are exact when this provider event is present. Per-tool token
attribution remains an estimate based on tool-result bytes, and the remainder
is reported as unattributed rather than mislabeled as reasoning.

## Usage

### Interactive model routing

For a terminal Codex session that must enforce per-state model and reasoning
routes, Statewright installs its transparent managed client during plugin setup.
Restart the terminal once after installing or updating the plugin, then continue
launching `codex` normally. The shim is dormant until a
workflow is loaded. At an authoritative Statewright boundary it resumes the
same session with that state's `--model` and `model_reasoning_effort`; it owns
only that terminal's child process group. Other terminals are never signalled.

This is a process boundary, not a hot swap inside a turn. A session started
before the plugin bootstrap runs continues to receive tool enforcement but
cannot change its current model automatically. Disable with
`statewright-managed-client --disable --host codex`.

To remove managed routing entirely, run
`statewright-managed-client --uninstall`. It removes only Statewright's shims
and marked shell-path block.

The explicit `statewright-codex-tui.mjs` launcher remains available for scripts
that want to name the workflow and bootstrap route up front.

### ChatGPT Desktop routing (experimental, macOS)

The same `statewright` Codex plugin can optionally route Desktop App Server
turns. It is a single-thread experimental broker: it does not patch or
redistribute ChatGPT.app, and it does not claim support for arbitrary Desktop
chats, approvals, or generated-answer correctness.

This launcher applies to **Codex/Work chats backed by Codex App Server**. A
cloud ChatGPT conversation, including one started on mobile and later opened in
the Desktop app, remains a ChatGPT conversation and does not inherit the local
Codex MCP process. To use Statewright in those conversations, connect the
deployed Statewright MCP endpoint as a ChatGPT plugin and enable that plugin in
the conversation. The local launcher and the remote ChatGPT plugin are two
separate host integrations over the same Statewright service.

On macOS, open a chat that uses the installed Statewright plugin once. Its MCP
startup quietly provisions **ChatGPT + Statewright** in your user Applications
folder. Quit every ChatGPT.app instance, then open **ChatGPT + Statewright**
from Applications, Spotlight, or the Dock. It starts ChatGPT with the routing
shim only for that process tree; normal ChatGPT launches are unchanged.

The installed plugin always binds this standard launcher to the production
gateway (`https://mcp.statewright.ai`). A pre-provisioned credential stays in
local Statewright storage and is never requested in chat. The first Desktop turn is held briefly
until the native App Server reports Statewright's tools as ready, so a fast
first prompt cannot race MCP registration.

### Developer troubleshooting

The CLI is not part of plugin-user installation. It is only for developers
diagnosing a local checkout or recovering a failed development setup:

```bash
node /path/to/statewright/plugins/codex/scripts/statewright-desktop-setup.mjs enable
node /path/to/statewright/plugins/codex/scripts/statewright-desktop-setup.mjs doctor
node /path/to/statewright/plugins/codex/scripts/statewright-desktop-setup.mjs disable
```

The production profile uses the public Statewright gateway. An internal
staging profile must receive its endpoint explicitly so private infrastructure
is never compiled into the public plugin:

```bash
node /path/to/statewright/plugins/codex/scripts/statewright-desktop-setup.mjs enable \
  --profile staging --gateway-url https://your-staging-gateway.example
```

When upgrading a legacy launchd-based setup, `enable` restores its recorded prior
value only if the launchd value still points to the recorded Statewright shim;
otherwise it refuses to overwrite the user's setting. Re-run `enable` after
updating the plugin so its private shim points at the newly installed runtime.
A signed-in route canary plus direct MCP-tool visibility in a fresh Desktop code
chat remain required before this is release-ready.

ChatGPT/mobile acceptance is separate: register the deployed HTTPS `/mcp`
endpoint in ChatGPT developer mode, complete its OAuth flow, then verify direct
Statewright tool visibility in an ordinary ChatGPT conversation that originated
on mobile. A passing Codex App Server resume does not satisfy that gate.

### Native workflow approvals (experimental App Server mode)

The standalone Statewright managed client owns the native approval controller,
private resolver, and restart-safe journal. `codex-local-models`, a local model
endpoint, and Qwen configuration are not required. For the source-checkout
road test, launch the Statewright shim directly, rather than an `ascodex` alias
that may point to the companion:

```bash
STATEWRIGHT_CODEX_TRANSPORT=app-server STATEWRIGHT_QWEN_ENABLED=false ~/.statewright/bin/codex
```

At a human gate, Statewright saves the exact run/session/approval identity,
pauses the native goal, and presents the authorized reviewer and evidence link
in Codex's permission form. The API-key identity must be an authorized reviewer
with Pro entitlement; otherwise the session waits without decision controls.
Cancel or disconnect does not approve or reject. Resume reopens a still-pending
gate, including after a runtime restart. An acknowledged approval must match
the owning workflow and destination route before autonomous work resumes.
Newer user input supersedes the old automatic continuation.

`STATEWRIGHT_NATIVE_APPROVALS=0` disables native presentation, not enforcement:
pending work remains parked. Failures go to the resident debug/error sink, not
raw terminal stderr. Existing active residents are never force-replaced by an
update. Exit the specific road-test session before restarting its runtime.

Run `task test:codex-native-approvals` from the Statewright checkout for the
deterministic lifecycle gate. The vendor protocol probe uses:

```bash
CODEX_BIN=/path/to/codex task test:codex-native-approvals:vendor
```

It exercises the installed vendor protocol with
no inference or real approval decision. These are not desktop/Windows GUI or
live staging journey certificates. Marketplace release packaging and the live
pause/approve/resume road test remain separate release gates.

Classifier fallback approval is a separate, invocation-scoped path. In a
managed `codex-local-models` session, repeated distinct reformulations of one
redacted uncertain intent may be presented through the native permission form
only when the gateway receipt explicitly permits separate approval. Workflow
capability, classifier-policy, interceptor, and known-risk denials are never
eligible for this fallback. The companion must own the exact thread and return
the matching thread, run, state, intent, invocation, denial basis, authority,
and retry-policy identities. One acceptance releases only the waiting
invocation after a fresh authoritative run/state check. Exact retries,
concurrent requests, stale or changed-state replies, dismissal,
timeout, disconnect, an unavailable companion, or an unsupported client stay
denied. This path does not resume a terminal workflow or replace a
workflow-transition approval.

The local host services approval requests through a serial, explicit-priority
chain of responsibility. Only an unsupported (`NotHandled`) request may pass to
the next handler; deny, ask, allow, and error are terminal, and required-handler
errors fail closed. The authoritative workflow-transition barrier precedes the
classifier fallback. The loopback `POST /classifier-approval` adapter uses the
v2 request/response contract and binds the exact thread, workflow run, gateway
run session, state, state epoch, intent, and invocation. Statewright and the
local companion must therefore be updated as one full-tree staging candidate;
mixed v1/v2 runtimes stay denied rather than dropping identity fields.

Start a workflow via MCP tool:

```
statewright_list_workflows()
statewright_load_workflow(name='<exact-name-returned-by-list>')
```

### Isolated delivery runs

`statewright-codex` automatically discovers `.statewright/delivery.json`,
creates its declared worktrees before opening a thread, and binds workflow
states to digest-pinned project Taskfile hooks:

```bash
node /path/to/statewright/plugins/codex/scripts/statewright-codex.mjs \
  --delivery-run-id my-run \
  --workflow isolated-delivery-v1 \
  -- "Implement and validate the change"
```

The config file is the switch: it is enabled by default when present, and
`"enabled": false` turns delivery off. With no file, delivery remains dormant.
See [the isolated delivery guide](docs/isolated-delivery.md) for defaults,
multi-repository overrides, explicit config selection, and promotion modes.

The local config pins a hook-bundle SHA-256 and an environment allowlist.
Statewright snapshots the project hooks and built-in Taskfile adapter before
task work, opens Codex in the primary run worktree, and preserves failed
previews for diagnosis. Projects own their database copy, migrations,
deployment, and validation tasks.

Generate the hook digest with:

```bash
node /path/to/statewright/plugins/codex/scripts/statewright-delivery.mjs \
  digest --root .statewright/delivery-hooks
```

Discard an unpromoted run explicitly:

```bash
node plugins/codex/scripts/statewright-delivery.mjs discard \
  --delivery-config /path/to/preview-delivery.json \
  --run-id my-run
```

Discard requires the exact run ID and clean run worktrees. Promoted runs use
the normal workflow teardown path.

If a process dies while target refs are moving, recover the durable promotion
journal before resume or discard:

```bash
node plugins/codex/scripts/statewright-delivery.mjs recover \
  --delivery-config /path/to/preview-delivery.json \
  --run-id my-run
```

## Agent decision record

Set `meta.agent-decision-record` to `true` so the gateway invokes the
built-in `adr-record` child before the parent workflow begins. The gateway
derives `.statewright/adr/<workflow>-<run-id>.md`, passes it as `adr_path`, and
resumes the parent only after the child records the decision. The child must
capture scope, constraints, evidence, intended edits, verification, and the
final outcome.

```json
"meta": {
  "agent-decision-record": true
}
```

## Hook events

- **UserPromptSubmit**: injects workflow state, tools, instructions, autonomous mode directive
- **PreToolUse**: enforces allowed_tools per state, bash discernment, command allowlisting
- **PostToolUse**: interrupt detection (file pattern matching), fork/join status, capture
- **Stop**: blocks Codex from yielding while an active workflow is nonfinal and
  permits it only after a final state.

When launched by `plugins/executor/statewright-exec.mjs`, the Codex hooks and
MCP proxy join the executor's authenticated loopback adapter before performing
any standalone bootstrap. The executor remains the sole owner of the remote
workflow session, credentials, delivery lifecycle, and telemetry. OMX uses
this same Codex-native path when launched with `--host omx`.

## License

FSL-1.1-ALv2 (see plugins/LICENSE.md)
