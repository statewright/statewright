# Live-turn settings: native acceptance and limits

Date: 2026-09-14. Native binary: Codex 0.153.4. Source/catalog: `rust-v0.153.4`, revision `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`.

## Outcome

The no-interruption mechanism works in the real native client, but it cannot replace the motivating Sol/Astra transition with the pinned catalog. Both directions are rejected by native safety validation. A same-model Sol low → high effort change succeeds.

Testing followed the testing-expert skill's external-boundary isolation: real native app-server and real remote TUI, with only model responses and an inert dynamic tool scripted. No user credentials, hosted inference, existing threads, production MCP connection or live-session restart were used. The harness relays lifecycle notifications unchanged. It is a diagnostic relay, not the production Statewright shim or a full Statewright transition test.

## Results

Seven API scenarios pass their assertions: compatible current-turn switch, future-thread-only control, disabled-feature rejection, synthetic unsafe-destination rejection, Sol → Astra rejection, Astra → Sol rejection, and Sol effort-only activation. Every scenario finishes both test turns normally; the expected rejections leave routing unchanged. A stale target is rejected as unavailable, and a provider field is rejected by the protocol.

The native TUI journey proves:

1. A held inert tool provides the boundary. The native settings update returns `applied`; the following request uses compatible model B/high inside the original turn.
2. During that request, a text message queued using Tab remains visibly queued. The footer still reads A/low even though the captured provider request is B/high.
3. Releasing the scripted response finishes normally, with no interruption banner. The queued text is submitted exactly as the next user turn, which uses the unchanged A/low thread defaults.
4. A later held request is cancelled with actual Escape. The client sends `turn/interrupt`, receives a genuine interrupted terminal, and renders the original banner in red (ANSI color 1).
5. A subsequent user message completes normally. No terminal filtering, relabeling or fake completion was involved.

The native TUI also creates an auxiliary title-generation thread. The provider fixture handles it separately; its completed terminal is included in raw evidence and must not be counted as a main-thread completion. The fixture's convenience `active`/`held` fields are not authoritative multi-thread/liveness state; the assertions use native events, input RPCs, captured Responses requests and actual pane output.

## Limits and recommendation

- **Sol/Astra is blocked in this version.** The unmodified catalog has `node_repl_auto_review_required=false` for Sol and `true` for Astra. The native error in both directions is `the destination changes the admitted node REPL review requirement`. This rejection occurs even in the inert diagnostic with code mode disabled. Do not rewrite metadata to evade it.
- **Experimental, disabled by default.** Both experimental API negotiation and the app-server's `step_model_switching` feature are required. No feature was enabled in the user's installed configuration.
- **Next settings capture, not an in-flight rewrite.** A held tool result is a useful barrier, but the actual managed-MCP bridge, concurrent tools and enclosing code-mode scripts need separate proof. An acknowledgement cannot rewind an already-admitted model step.
- **Same provider.** There is no provider field. This API cannot switch between hosted inference and a Qwen provider.
- **Not a fresh turn.** Initial model-specific instructions and retained context are not fully rebuilt. Native source explicitly cautions about instruction correctness, attribution and resume behavior. Source details are linked in the [research report](001-red-banner-workarounds.md).
- **Future defaults and visible status are separate.** Updating the current turn does not change the next turn's defaults. Native footer attribution also remains original in this test. Statewright needs truthful effective-step status, and separately acknowledged future defaults when wanted.
- **Not a universal banner replacement.** Genuine interruptions still show the stock red notice. Enabling this experimental feature also produces its own yellow startup warning; the test preserved it.
- **Still unproven:** real hosted inference/auth, billing attribution, provider WebSockets, reconnect/resume, attachments, pending-steer/cancel races, and the full Statewright transition barrier.

Recommended next implementation scope: a Statewright-owned, opt-in, version-gated effort-only path with exact client/thread/turn/route-generation correlation. Preserve native safety checks and define a bounded, explicit fallback for rejection. Compatible cross-model routes require individual validation. Do not use this as the default Sol/Astra workaround.

## Evidence and reproduction

- [API harness](probes/turn-settings-workaround.mjs) and [seven-case results](probes/turn-settings-workaround-results.json).
- [Native TUI harness](probes/turn-settings-tui.mjs) and [raw snapshots plus eleven passing checks](probes/turn-settings-tui-results.json).

Run the API harness with `node docs/research/probes/turn-settings-workaround.mjs /path/to/pinned/codex-source`. The TUI harness takes the same source path and prints an isolated home, loopback WebSocket URL and private control URL. Start `codex --remote` against that URL with the printed home and a custom local provider configured with `requires_openai_auth=false` in the client as well as the server. Accept trust only for that generated test directory. The diagnostic `/release` control applies settings and releases the inert tool; `/finish` completes the held response. The checked interactive sequence is documented above.

All owned test processes and the dedicated `sw-step-tui-probe` tmux session were stopped after capture. Temporary diagnostic homes remain for inspection. No production implementation or global configuration changed in this test follow-up.
