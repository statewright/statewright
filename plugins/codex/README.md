# statewright-codex

State machine guardrails for [OpenAI Codex CLI](https://github.com/openai/codex). Per-state tool enforcement, interrupts, fork/join, approval gates.

## Install

```bash
codex plugin marketplace add statewright/statewright
codex plugin install statewright
```

Or manual setup:

1. Get an API key at [statewright.ai/keys](https://statewright.ai/keys)
2. Save it: `echo 'sw_live_...' > ~/.statewright/api_key`
3. Add the MCP server:
   ```bash
   codex mcp add statewright -- bash /path/to/plugins/codex/mcp-proxy.sh
   ```
4. Enable hooks in `~/.codex/config.toml`:
   ```toml
   [features]
   hooks = true
   ```
5. Merge `hooks.json` into `~/.codex/hooks.json`

**Important**: Add `env_vars` to propagate API keys to the MCP server:

```toml
[mcp_servers.statewright]
command = "bash"
args = ["/path/to/mcp-proxy.sh"]
env_vars = [
  "STATEWRIGHT_API_KEY",
  "STATEWRIGHT_GATEWAY_URL",
  "STATEWRIGHT_PB_URL",
  "STATEWRIGHT_TELEMETRY_DIR",
  "STATEWRIGHT_TELEMETRY_PORT",
  "STATEWRIGHT_TELEMETRY_BUILD_ID",
]
```

Codex does not propagate parent environment variables to MCP child processes by default. The `env_vars` field explicitly forwards them.

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

Start a workflow via MCP tool:

```
statewright_load_workflow(name='bugfix')
statewright_list_workflows()
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

Set `meta.agent-decision-record` to `true` to make the gateway invoke the
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
- **PreToolUse**: enforces allowed_tools per state, bash discernment, command whitelisting
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
