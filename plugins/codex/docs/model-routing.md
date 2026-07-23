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

## Run

From the Statewright checkout:

```bash
plugins/codex/scripts/statewright-codex.mjs \
  --workflow rugged-sdlc \
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

The implementation targets the protocol shipped by Codex CLI `0.144.1` and only uses methods
present in that version's generated schema:

- `initialize` / `initialized`
- `model/list`
- `thread/start` and `thread/resume`
- `turn/start` and `turn/interrupt`
- `mcpServerStatus/list` and `mcpServer/tool/call`
- `item/completed`, `turn/completed`, `model/rerouted`, and token-usage notifications

Regenerate schemas after upgrading Codex and rerun the adapter tests before relying on routing:

```bash
codex app-server generate-json-schema --out /tmp/statewright-codex-schema
node --test plugins/codex/tests/*.test.mjs
```
