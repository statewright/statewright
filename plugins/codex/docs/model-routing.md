# Codex state-boundary model routing

Statewright's Codex adapter makes per-state model and reasoning-effort routing enforceable by
owning the Codex app-server turn lifecycle.

Codex does not support changing the model on `turn/steer`. A model change takes effect on a new
`turn/start`, where `model` and `effort` are explicit per-turn overrides. The adapter therefore
treats each successful Statewright load or transition as a hard boundary:

The protocol boundary is documented in OpenAI's current
[Codex app-server guide](https://developers.openai.com/codex/app-server/). The adapter also queries
`model/list` at runtime instead of treating a copied model catalog as authoritative.

1. Start a low-cost bootstrap turn that only calls `statewright_load_workflow`. This preserves the
   normal Statewright MCP and hook activation path.
2. Interrupt that turn as soon as the load tool completes.
3. Read `statewright_get_state` through `mcpServer/tool/call` on the same app-server thread.
4. Resolve the state's `model` and `thinking_level` against the live `model/list` catalog.
5. Start the next turn with those explicit values.
6. Repeat at every successful transition until the workflow reaches a final or approval state.

At process start, the adapter also creates a unique `br_codex_*` MCP transport id and passes it to
both the Statewright proxy and Codex hooks. The currently deployed gateway isolates those ids while
ordinary echoed session ids remain API-key scoped. This prevents another Codex/tmux session from
changing the workflow state used for routing.

This cannot hot-swap the model inside an already-running Codex TUI turn. Use the adapter as the
session owner for workflows that need model routing.

## Experimental: persistent native Codex TUI

The managed `codex` shim also has an experimental App Server transport for normal native TUI
sessions. It keeps one local App Server alive, connects the unmodified Codex TUI with `--remote`,
and applies a Statewright route only after the current turn completes. Same-provider routes update
the next turn in place. Cross-provider routes retire only that managed resident, reconnect the TUI,
and resume the same thread under the selected provider.

It is off by default. Enable it in `~/.statewright/config.json`:

```json
{
  "routing": {
    "managed_clients": {
      "enabled": true,
      "hosts": { "codex": true },
      "codex_transport": "app-server"
    }
  }
}
```

For a one-session rollback, launch Codex with
`STATEWRIGHT_CODEX_TRANSPORT=restart codex`. An explicit
`STATEWRIGHT_CODEX_TRANSPORT=app-server` enables the experimental transport without changing the
file.

The App Server receives an isolated temporary `CODEX_HOME`: its `config.toml` is copied;
authentication, plugins, profile-v2 files, and other runtime state are shared by local symlink.
The normal `~/.codex/config.toml` is never changed. Statewright preserves the isolated projection
after shutdown so a TUI that is still unwinding can resolve its canonical rollout.

## Mixed-provider native picker

Codex binds `modelProvider` when a thread is loaded, while `model/list` entries and
`thread/settings/update` contain only a model id. Statewright bridges that protocol gap by
discovering Codex profile-v2 files in `$CODEX_HOME`, adding their catalog entries to `/model` with
provider-qualified ids, and treating a cross-provider selection as an idle thread handoff.

Keep the provider definition in the base Codex config:

```toml
[model_providers.local_compatible]
name = "Local compatible provider"
base_url = "https://models.example.invalid/v1"
wire_api = "responses"
requires_openai_auth = false
```

Then add `$CODEX_HOME/local.config.toml`:

```toml
model = "local-code-model"
model_provider = "local_compatible"
model_catalog_json = "/absolute/path/to/local-models.json"
model_reasoning_effort = "low"
web_search = "disabled"
```

The profile file must declare both `model_provider` and `model_catalog_json`. Provider URLs and
credentials remain in Codex configuration; Statewright reads only the profile name, routing keys,
and model catalog. The native picker keeps the active provider's model ids bare and qualifies only
alternate-provider choices, such as `local_compatible/<model>`. For a thread with completed work,
selecting either provider resumes the same thread id there. A provider change before the first turn
has been accepted starts a fresh thread because Codex has no durable rollout to resume. If a turn
is active, the provider change is refused with guidance to wait for completion.

Some Responses-compatible providers cannot accept the opaque `compaction` items produced by a
different provider. Opt one profile into Statewright's bounded compatibility adapter with a
same-named `$CODEX_HOME/local.statewright.json` sidecar:

```json
{
  "responses_compatibility": "replace_encrypted_compaction"
}
```

For that profile only, Statewright reads its `base_url`, routes Codex through a loopback HTTP
adapter, and replaces each undecodable `compaction` or `context_compaction` item with an explicit
developer handoff note. Retained user/developer items and all post-checkpoint history stay in their
original order. The adapter cannot recover the encrypted assistant summary; the inserted note
tells the target model to reconstruct and verify prior state. Authorization headers are forwarded
without being written to telemetry. Profiles without the sidecar, including the built-in OpenAI
provider, keep Codex's direct request path.

## Run

From the Statewright checkout:

```bash
plugins/codex/scripts/statewright-codex.mjs \
  --workflow "[magent] desktop-android-pulse v1" \
  --cwd "$PWD" \
  -- "Implement the approved plan and continue until the workflow is final."
```

Resume a Codex thread and the last paused workflow run:

```bash
plugins/codex/scripts/statewright-codex.mjs \
  --workflow rugged-sdlc \
  --thread-id 019f0000-0000-7000-8000-000000000000 \
  --resume-workflow \
  -- "Continue the task."
```

The adapter prints the thread id immediately. Keep it for resume and audit correlation.

For a convenient shell entrypoint:

```zsh
alias swcodex="$HOME/dev/statewright/plugins/codex/scripts/statewright-codex.mjs"
```

## Workflow routes

Use the existing Statewright fields. Exact catalog ids and the semantic family aliases `sol`,
`terra`, and `luna` are accepted by this adapter. Provider-qualified ids are also accepted.

```json
{
  "meta": {
    "default_model": "openai-codex/gpt-5.6-luna"
  },
  "states": {
    "discover": {
      "model": "openai-codex/gpt-5.6-sol",
      "thinking_level": "high"
    },
    "build": {
      "model": "openai-codex/gpt-5.6-luna",
      "thinking_level": "medium"
    },
    "review": {
      "model": "openai-codex/gpt-5.6-terra",
      "thinking_level": "high"
    }
  }
}
```

A state without `model` inherits the active route. When a state changes models but omits
`thinking_level`, the new model's catalog default is used. This prevents a previous Sol `max`
effort from leaking into a cheaper state.

To use the same workflow with a local provider and a cloud equivalent, declare an ordered
`model_ladder` on the state instead of copying the workflow:

```json
{
  "model": "local_compatible/local-code-model",
  "model_ladder": [
    {
      "model": "local_compatible/local-code-model",
      "thinking_level": "low",
      "health_url": "https://model.example.invalid/health"
    },
    {
      "model": "openai-codex/gpt-5.6-luna",
      "thinking_level": "low"
    }
  ]
}
```

Both managed transports check each `health_url` in order. The persistent App Server transport
applies a candidate from the current provider in place. When the first healthy candidate belongs
to another configured profile-v2 provider, it waits for the active turn to complete, records an
atomic handoff, retires the exact resident, and resumes the same thread on that provider. The
standalone adapter chooses the first ladder entry present in its active provider's live model
catalog.

Routing is fail-closed:

- An explicit state model missing from the live catalog stops before another turn starts.
- An explicit unsupported effort stops before another turn starts.
- A provider-side `model/rerouted` notification stops the session unless `--allow-reroute` is set.
- The bootstrap and unrouted fallback default to Luna at `medium`; override with
  `--fallback-model` and `--fallback-effort`.

## Permissions and human prompts

The default is `approvalPolicy=on-request` with `approvalsReviewer=auto_review`, matching Codex's
"Approve for me" behavior. A Statewright workflow approval gate is different: the adapter stops,
prints the gate and thread id, records it in telemetry, and exits with status 3. Resume after the
review is resolved.

Unexpected app-server approval or elicitation requests are declined rather than left hanging. A
future Magent client can replace that terminal policy with a mobile approval inbox without changing
the routing boundary.

## Telemetry

The default JSONL log is:

```text
~/.statewright/telemetry/codex-routing.jsonl
```

Records include timestamps, thread and turn ids, workflow state, requested and selected routes,
provider reroutes, transition boundaries, completion status, and Codex token-usage notifications.
The writer strips prompt, input, arguments, content, and text fields and creates the log with mode
`0600`. Disable it with `--no-telemetry` or choose a path with `--telemetry-path`.

## Protocol compatibility

The cross-provider transport is validated against Codex CLI `0.153.4`. It depends on these
generated App Server protocol surfaces:

- `initialize` / `initialized`
- `model/list`
- `thread/start` and `thread/resume`, including the resume-time `model` and `modelProvider` fields
- `thread/settings/update` and `thread/settings/updated`
- `config/batchWrite`
- `turn/start` and `turn/interrupt`
- `mcpServerStatus/list` and `mcpServer/tool/call`
- `item/completed`, `turn/completed`, `model/rerouted`, and token-usage notifications

Provider handoff clients connect to the bare App Server proxy address required by Codex and carry
their one-time launch nonce through `--remote-auth-token-env`. Provider-qualified picker ids are
stripped before any thread, settings, turn, or compaction request reaches native Codex.

Additional providers must be configured as profile-v2 files at
`$CODEX_HOME/<name>.config.toml`, with `model_provider` and `model_catalog_json` set. Use only one
profile-v2 catalog for each provider id. Older Codex releases that do not expose the protocol
fields above are outside this transport's validated compatibility boundary.

Regenerate schemas after upgrading Codex and rerun the adapter tests before relying on routing:

```bash
codex app-server generate-json-schema --out /tmp/statewright-codex-schema
node --test plugins/codex/tests/*.test.mjs
```
