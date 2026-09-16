# Hard-interrupt preface and provider-transition findings

Date: 2026-09-15. Native client/app-server: Codex 0.153.4.

> Cross-provider scope correction: [005-companion-context-handoff.md](005-companion-context-handoff.md) validates the actual companion stack and supersedes this document's blanket OpenAI/Qwen blocker. The original direct-endpoint reproductions below intentionally omit its compatibility adapter.

## Delivered in the checkout

Statewright's app-server shim emits a separate native warning immediately before a qualifying real interrupted terminal:

```text
⚠ [statewright] switching from sol=>astra, hard interrupt required
■ Conversation interrupted - tell the model what to do differently. …
```

The reverse direction says `astra=>sol`. OpenAI/Qwen provider changes use the actual model labels. This permits and explains the existing hard-interruption path; it does not introduce a new interrupt owner, suppress a terminal, promise that the destination has started, or enable experimental in-turn model switching. The native warning renderer supplies the yellow color; the original banner remains red.

The Codex hook adds an optional exact `turn_id` to its atomic next-route record. The resident's display-only lookup validates managed-client/root ownership and the next queued route without consuming or reordering it. The shim also requires the observed turn, matching route turn, workflow run/state, known originating model/provider, and one of the requested transition classes. Legacy records without a turn ID still route normally but are not annotated. Explicit operator cancellation through the connection, stale routes, lookup errors, and racing operator activity do not receive the preface.

The lookup has a 250 ms limit and upstream delivery is serialized so later events cannot overtake the terminal/preface pair. The notice is a warning history cell, not a fabricated agent-message completion that could splice a native answer stream. All original lifecycle and user-input messages remain unchanged. There is no Qwen-only plugin change.

## Validation

- 104 targeted tests passed: notice direction/ordering, partial streams, exact turn/client ownership, stale/legacy routes, cancellation races, bounded lookup failures, preservation of route reservations, both provider-switch directions, rejected/mismatched destinations, rollback requests, native connection usability, and hook turn-ID production.
- The hook suite initially inherited `STATEWRIGHT_STOP_CONTINUATION=0` from this session. Running with only that variable removed restored the expected Stop assertions; no Stop policy was changed.
- The real stock TUI rendered the exact yellow preface immediately above the red banner and continued displaying the scripted successor. This rendering probe scripts lifecycle events; it is not a live workflow test.
- Separately, the real native app-server behind the production shim made Sol → Astra → Sol requests through a loopback WebSocket model fixture. Both real interruptions were prefaced, and the final turn completed normally.
- Provider-switch protocol tests pass in both directions, but native execution uncovered the blocker below. These are not equivalent acceptance claims.

Commands:

```sh
env -u STATEWRIGHT_STOP_CONTINUATION node --test plugins/executor/tests/app-server-handoff.test.mjs plugins/executor/tests/app-server-handoff-proxy.test.mjs plugins/executor/tests/codex-app-server-transport.test.mjs plugins/executor/tests/hard-interrupt-preface.test.mjs plugins/codex/tests/statewright-codex-tui.test.mjs
node docs/research/probes/hard-interrupt-roundtrip.mjs /path/to/codex-source --same-provider
node docs/research/probes/hard-interrupt-roundtrip.mjs /path/to/codex-source
node docs/research/probes/hard-interrupt-roundtrip.mjs /path/to/codex-source --qwen-to-openai
```

The two cross-provider commands are blocker reproductions: successful assertions mean the known mismatch was detected, not that the handoff worked. They stop their own diagnostic turn once the unsupported request is observed. [Raw results and TUI capture](probes/hard-interrupt-preface-results.json).

## OpenAI ↔ Qwen is not yet cleared for use

The provider detach/resume and requested next-turn model are correct, but retained context causes native compaction to select the previous model on the destination provider:

| Direction | Native request observed before destination inference |
|---|---|
| OpenAI → Qwen | Qwen Responses endpoint receives `model=gpt-5.6-sol` with a context-checkpoint compaction prompt |
| Qwen → OpenAI | OpenAI Responses WebSocket receives `model=qwen3.8-27b` with a `compaction_trigger` |

The forward case was allowed to retry in an initial diagnostic and ultimately produced a real failed terminal. A minimal synthetic request to the user's actual Qwen endpoint confirmed HTTP 404 `model_not_found` for `gpt-5.6-sol`; `/v1/models` listed `qwen3.8-27b`. No private thread content was sent. The reverse probe establishes the outgoing mismatch using an isolated destination; it is not a live OpenAI rejection test.

A source-provider explicit compaction experiment did not remove the forward mismatch. Do not claim this is fixed by issuing `thread/compact/start` alone. A provider-safe context transfer needs its own design and native validation, including plaintext versus provider-specific compacted history, target context limits, and preserved root-thread ownership. Do not silently alias OpenAI model IDs to Qwen, falsify context-window metadata, rewrite stored history, or move the user to another root thread to make the test pass.

A permissive early fixture accepted all compaction model names and appeared to complete the reverse direction. That result is invalid as compatibility evidence; the final fixture rejects unsupported destination model IDs. Separating native WebSocket prewarm from real inference was also necessary to avoid counting warmup as a model step.

OpenAI's current [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) reserves built-in provider IDs. The fixture therefore uses the user-level `openai_base_url` override and a dummy key, rather than redefining `model_providers.openai`. One earlier environment-only override attempt went to the default OpenAI endpoint and received 401 using that dummy key; no real credentials were used.

## Adoption boundary

Changes are local and uncommitted in the existing dirty checkout. No live resident was restarted, no global plugin/configuration was installed, and no workflow was activated. The preface requires the new hook and shim together. All owned diagnostic processes and the dedicated TUI tmux session were stopped; temporary test homes remain for inspection. OpenAI/Qwen end-to-end compatibility remains unresolved and must not be reported as complete.
