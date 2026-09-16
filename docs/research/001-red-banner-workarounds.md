# Statewright handoff banner workarounds

## Research Summary

There is a credible no-fork workaround for a subset of Statewright handoffs: change the active turn's model settings through Codex's experimental `turn/settings/update` API, eliminating the interruption that causes the red banner. A diagnostic against the installed Codex 0.153.4 binary proved a same-turn model/effort switch with zero interrupted terminals, but this is not a general cross-provider solution and upstream explicitly warns that model-instruction correctness and attribution are incomplete. For handoffs that must interrupt, no safe JSON-RPC-only banner override was found; a narrowly scoped renderer change remains cleaner than dropping or relabeling lifecycle events. [4–9]

Follow-up acceptance testing now confirms the compatible switch in the real native TUI, including queued input and genuine cancellation. Crucially, the unmodified pinned Sol/Astra catalog pair is rejected in both directions because its node REPL review requirements differ. Sol effort-only switching passes. This makes effort-only routing the strongest initial candidate, not a general Sol/Astra handoff replacement. See [acceptance findings](002-live-turn-settings-acceptance.md).

## Key Findings

1. **Active-turn switching works in the installed binary.** With experimental API access and `features.step_model_switching=true`, the native app-server accepted an exact-thread/exact-turn model/effort update. The next scripted Responses request used model B/high instead of A/low, within the original turn. Both tested turns completed normally; no interruption event was generated. See the [reproducible probe](probes/turn-settings-workaround.mjs) and [captured results](probes/turn-settings-workaround-results.json). [4–7]

2. **This is different from changing thread defaults.** The control experiment using `thread/settings/update` left the active turn on A and changed only the subsequent turn to B. Sending a thread update is not a safe substitute when an active-turn update is rejected or unavailable. [4, 7]

3. **The feature is experimental, not a production guarantee.** It is disabled by default. Upstream describes it as a diagnostic path and warns about retained initial-turn consumers, model-specific instructions, attribution and resume behavior. An `applied` response proves publication to future settings captures, not that the next inference has already used the requested model. [4–6]

4. **A tool-result barrier is essential.** Updating after observing `item/completed` can be too late: the next model step may already have captured its settings. Statewright must hold the relevant transition-tool response until it has verified authority and received the live-update acknowledgement. The native probe demonstrated this with a held dynamic-tool response; a real managed-MCP barrier still needs implementation and validation. [4, 6, 13]

5. **`PostToolUse` does not offer the expected hard-stop shortcut.** Despite the name `continue: false`, this hook replaces the model-visible tool result and allows processing to continue. The pinned upstream regression test explicitly expects a second model request. It therefore cannot guarantee a phase boundary without further inference. [2, 11]

6. **The red banner and interruption cleanup are separable inside the TUI, but not through an exposed main-thread setting.** Codex already uses `InterruptedTurnNoticeMode::Suppress` for side conversations while still calling interruption cleanup. The problem is exposing a correctly scoped presentation choice, not inventing a new cleanup mechanism. [8–10]

## Detailed Analysis

### 1. What actually generates the red banner

An app-server `turn/completed` notification with `turn.status = "interrupted"` enters the TUI's interruption handler. That handler finalizes the turn, handles pending steers, restores queued drafts and attachments, refreshes input state, and adds the visible notice. The server does not send the red text as a replaceable warning string. [8, 9]

This explains why filtering an exact model-switch warning succeeds while filtering this banner at the WebSocket layer does not. The former is a presentation message. The latter is generated locally as one effect of an execution-lifecycle event. The documented notification opt-out operates on whole methods, not on individual rendering effects. [1, 8]

The previous shim-only conclusion needs this refinement: **replacing the banner for an actual interruption needs another presentation capability, but avoiding an interruption can be possible without a client fork.** The active-turn settings API provides that second route. [4]

### 2. Best no-fork candidate: active-turn settings updates

The pinned protocol accepts these fields: `threadId`, `turnId`, `approvalsReviewer`, `model`, `effort`, `summary`, and `serviceTier`. It rejects unknown fields. There is no provider, sandbox, working-directory, personality or collaboration-mode override in this request. [5]

An illustrative Statewright-originated request is:

```json
{
  "id": "statewright-route-generation-42",
  "method": "turn/settings/update",
  "params": {
    "threadId": "owned-thread",
    "turnId": "observed-active-turn",
    "model": "destination-model",
    "effort": "high"
  }
}
```

The control connection must initialize with experimental API access, and the managed app-server must explicitly enable `step_model_switching`. There is no need to enable it globally or modify the Qwen plugin. Reviewer-only updates have different feature-gate rules, but do not solve model routing. [4, 5]

The response has two success-shape statuses: `applied` and `targetUnavailable`. Validation, feature and safety rejections are JSON-RPC errors. Statewright must handle all three outcomes separately and never reinterpret a stale target as permission to update a different turn. [4–6]

#### Native diagnostic results

The diagnostic used the real installed binary with a fresh temporary home, a loopback scripted Responses endpoint, and two synthetic model-catalog entries cloned from the same bundled model template. A dynamic tool provided an inert, controlled response barrier. No real provider inference, shell tool execution, production MCP connection, existing-thread attachment or user authentication was used.

| Case | First request | Next request in same turn | Request in next turn | Result |
|---|---|---|---|---|
| Active-turn update | A / low | B / high | A / low | `applied`; no interrupted terminals |
| Thread-default update | A / low | A / low | B / high | Defaults changed; active turn unchanged |
| Feature disabled | A / low | A / low | A / low | Feature-gate rejection |
| Incompatible model safety metadata | A / low | A / low | A / low | Safety rejection |
| Actual Sol → Astra catalog entries | Sol / low | Sol / low | Sol / low | Node REPL review requirement rejection |
| Actual Astra → Sol catalog entries | Astra / low | Astra / low | Astra / low | Same safety rejection |
| Sol effort-only update | Sol / low | Sol / high | Sol / low | `applied`; no interrupted terminals |

Additional assertions verified that a stale turn returns `targetUnavailable`, supplying `modelProvider` is rejected, no second model request occurs while the tool response is held, and exactly two turns start and complete per scenario. The tests establish native request routing, not compatibility between arbitrary real models or end-to-end Statewright UI behavior.

Reproduction:

```sh
node docs/research/probes/turn-settings-workaround.mjs /path/to/codex-source
```

Use the source revision recorded below. The diagnostic accepts `CODEX_PROBE_BINARY` to select a binary; its default matches this machine. It creates isolated temporary homes and stops its own child processes. Those homes are retained for inspection.

#### Proposed Statewright-owned sequence

```text
Transition tool succeeds in the authoritative gateway
  → managed MCP bridge holds its response
  → shim validates client/thread/turn/run/route-generation ownership
  → shim calls turn/settings/update for that exact active turn
  → wait for applied; reject stale/unsafe outcomes
  → emit correlated Statewright status at a safe display boundary
  → release the original transition result
  → next model step captures the updated settings
```

This is a proposal, not an implemented path. The current bridge forwards the gateway response after receipt and optional tool-list annotation; it has no such route barrier. Holding a downstream `item/completed` notification alone would not hold the actual tool result seen by the core. [13]

The MCP bridge and app-server shim need a bounded coordination channel. Bind the request to the managed client, exact thread, exact live task, workflow run and route generation. Do not derive ownership from CWD or whichever session appears most recent. Serialize route updates and invalidate a pending update when the operator cancels or supersedes the work.

On rejection, a native interruption fallback must be deliberate and visible. Simply releasing the response and letting the old model continue could violate Statewright's selected route. Conversely, leaving the response held indefinitely would strand execution. The barrier needs a bounded timeout and a typed failure outcome.

#### What this preserves—and what it changes

Because no interruption occurs, the shim does not bypass interruption cleanup or need to reconstruct invisible local drafts. However, this intentionally changes the interaction model: queued drafts remain queued until normal handling, rather than being restored at every former artificial interrupt boundary. The follow-up native TUI test confirmed one Tab-queued text input survives and submits after completion, and genuine Escape cancellation still renders red. Attachment, pending-steer race and code-mode cases remain untested.

Workflow state and Codex turn are no longer one-to-one. Statewright must attribute tools, inference, usage and status to a state-generation/step segment inside a turn. It cannot assign every token in the turn to the most recently selected state. Upstream's own attribution limitations make this a release gate, especially for auditable or billed runs. [4]

#### Boundaries that remain

- **Same provider only through this API.** There is no provider parameter; model names are resolved under the existing provider. Hosted-to-Qwen or other provider changes still need a separate path. Do not fake a provider change with a prefixed model string. [5]
- **Settings captured before publication remain unchanged.** Concurrent calls or running code-mode scripts may already be admitted under older settings. A completed nested transition call is not proof that its enclosing script has stopped. A phase barrier must account for these producers. [4, 6]
- **Initial model consumers remain.** Model-specific instructions and other retained context may still reflect the starting model. A successful A/B catalog-clone test does not establish the correctness of a real cross-model transition. [4]
- **Safety checks are part of the contract.** Unknown/fallback metadata, changed review authority and certain model safety differences can reject activation. Do not clone or edit real model metadata to evade them; catalog cloning here was only an isolated test fixture. [6]
- **Future defaults are independent.** Persisting the selected route for subsequent turns needs a separate thread-default update and its own acknowledgement. [4, 7]
- **Instructions need an explicit path.** The model still needs the next state's authoritative instructions. Preserve the Statewright transition result or use a separately justified context mechanism; a UI status item does not update model instructions.

### 3. Workaround comparison

| Candidate | No vendor fork? | Lifecycle/input implications | Assessment |
|---|---|---|---|
| Active-turn settings update | Yes | No interruption; same turn continues | Best bounded experiment for compatible same-provider routes |
| Natural phase completion, then routed start | Yes | Uses genuine normal completion; queued input can auto-submit | Viable if bounded end-of-phase inference and input arbitration are acceptable |
| `PostToolUse continue: false` | Yes | Replaces output; does not hard-stop the turn | Not a deterministic phase-stop primitive |
| `turn/steer` alone | Yes | Adds input to the same active turn | Cannot carry model or permission overrides |
| Drop interrupted terminal | Yes | Bypasses cleanup and draft restoration | Reject |
| Relabel terminal as completed or failed | Yes | Chooses different cleanup/queue behavior and misstates status | Reject |
| Notification opt-out / theme / notification setting | Yes | Cannot selectively remove the local banner effect | Not a solution |
| Native side-conversation suppression | Yes, through real side UI | Different thread/UI mode; suppresses all its notices | Real mechanism, unsuitable as a transparent main-thread workaround |
| Root-turn suspension and recovery | Yes where exposed | Shutdown path explicitly drops pending input | Not a drop-in presentation workaround |
| Statewright-managed PTY rendering adapter | Yes | Native cleanup remains intact if only display is changed | Technically plausible, unproven and terminal-specific |
| Per-event renderer presentation extension | No, until upstream adoption | Can preserve exact interrupted lifecycle and input restoration | Cleanest general solution when interruption is necessary |

Protocol and renderer evidence: [1–3, 5, 8–12]. PTY assessment is an engineering inference, not a tested product capability.

### 4. Why the other shortcuts do not close the gap

**Hooks.** `PostToolUse continue: false` changes feedback, not turn termination. `Interrupt` hooks cannot veto the interruption or restart the turn. `suppressOutput` is not an implemented global banner control. `systemMessage` adds a warning, so it is also the wrong neutral-status channel. These similarly named fields should not be treated as interchangeable lifecycle controls. [2, 11]

**Failed-without-error projection.** In the pinned TUI this path finalizes the turn and attempts queued-input submission. That is not the interrupted path's restoration behavior. It also marks an intentional handoff as a failure. Relabeling a real event is not an acceptable fix for either UX or trustworthy telemetry. [9]

**Side mode.** Side conversations really do select the internal suppression mode. The mode depends on the application's local side-thread registry and changes other behavior, including thread context and naming. Merely tagging an app-server thread as a side thread does not set that local registry. Automating side-mode entry would alter session semantics and hide genuine interruptions in that mode too. [10]

**Suspension.** The source has a root-turn suspension path that cancels execution without recording a terminal event, permitting worker recovery under the original turn ID. Its comments explicitly state that accepted pending input and interactive waiters are not preserved. This is process handoff infrastructure, not a safe visual substitution. [12]

**PTY filtering.** A Statewright launcher could keep all protocol events intact and alter only the terminal's displayed cells. This would put policy in Statewright, not the Qwen plugin, but extends ownership beyond a WebSocket shim. A robust implementation must handle ANSI attributes, fragmented writes, wrapping, resizing, alternate-screen state, transcript redraws and repeated appearances of old cells. A one-shot regular expression is not sufficient. It also needs authenticated handoff identity: matching the banner's words alone would hide genuine operator interruptions. No PTY workaround was implemented or validated here.

### 5. Small renderer extension for the general case

If an interruption is required, preserve its original status and attach a narrowly scoped, optional presentation annotation recognized by a managed client. The TUI can select a neutral supervisor-authored notice for that one terminal while still running the existing interrupted-turn cleanup. Older clients should ignore the annotation and retain their ordinary notice. This is a proposed protocol extension, not an existing field. [8–10]

Prefer a per-event argument to a mutable global suppression flag. A global flag can suppress the wrong turn after a race or an operator Escape. Validation must bind the annotation to the terminal's exact identity and must not allow a failed model run or arbitrary tool output to declare itself a supervisor handoff.

The regression contract should cover queued drafts and attachments, pending steers, active output, user Escape during handoff preparation, failed continuation, duplicate terminals, stale IDs, multiple subscribers, history replay and resume. In Statewright's own UI, a corresponding presentation choice can be implemented directly if that UI owns rendering; that does not automatically change the stock Codex TUI.

### 6. Recommendation

Proceed with an explicitly experimental Statewright-owned active-turn routing spike for a small allowlist of compatible model/effort transitions. Start with an effort-only change on the same model, then test a real same-provider model pair whose safety and instruction requirements have been reviewed. Preserve the current interrupt path for unsupported transitions and errors until there is a complete alternative.

Before enabling it in normal workflows, prove the managed-MCP response barrier, code-mode/concurrent-call behavior, actual request model and effort, next-state instruction delivery, per-state usage attribution, cancellation, queued input and resume. Do not equate the native `applied` acknowledgement with all of those guarantees.

For cross-provider transitions or strict new-turn boundaries, prefer the small per-event renderer extension over protocol-status fabrication or terminal-output surgery. The research therefore identifies a real narrower workaround without overturning the earlier warning about suppressing interrupted terminals.

## Sources & Evidence

Research access date: 2026-09-14. Installed executable: `codex-cli 0.153.4`. Pinned source: OpenAI Codex tag `rust-v0.153.4`, commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`, dated 2026-09-04. Local-source links are inspection locations; the commit plus repository-relative path identifies the evidence if the temporary checkout is later removed.

1. OpenAI, [Codex App Server](https://learn.chatgpt.com/docs/app-server), current official documentation; initialization, notification opt-out, turn lifecycle and steering. The fetched public page did not document the active-turn settings method found in the pinned source.
2. OpenAI, [Hooks](https://learn.chatgpt.com/docs/hooks), current official documentation; PostToolUse output semantics, unsupported suppression and Interrupt limitations.
3. OpenAI, [Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference), current official documentation; TUI settings and hook configuration.
4. OpenAI, [pinned app-server README](/tmp/codex-src.uaLmNC/codex-rs/app-server/README.md:1365), `codex-rs/app-server/README.md`; active-turn API, feature gates, acknowledgement semantics and explicit limitations.
5. OpenAI, [pinned turn protocol](/tmp/codex-src.uaLmNC/codex-rs/app-server-protocol/src/protocol/v2/turn.rs:40), `codex-rs/app-server-protocol/src/protocol/v2/turn.rs`; permitted fields, unknown-field rejection and response statuses.
6. OpenAI, [pinned step activation](/tmp/codex-src.uaLmNC/codex-rs/core/src/session/step_activation.rs:230), `codex-rs/core/src/session/step_activation.rs`; exact-task publication, feature gate, safety and retained-setting checks.
7. OpenAI, [pinned settings integration tests](/tmp/codex-src.uaLmNC/codex-rs/app-server/tests/suite/v2/turn_settings_update.rs:50), `codex-rs/app-server/tests/suite/v2/turn_settings_update.rs`; A/B/A versus A/A/B controls and rejection tests. Read as source, not executed as Rust tests here.
8. OpenAI, [pinned interrupted-input restoration](/tmp/codex-src.uaLmNC/codex-rs/tui/src/chatwidget/input_restore.rs:231), `codex-rs/tui/src/chatwidget/input_restore.rs`; cleanup, notice selection and draft/steer restoration.
9. OpenAI, [pinned TUI terminal dispatch](/tmp/codex-src.uaLmNC/codex-rs/tui/src/chatwidget/protocol.rs:268), `codex-rs/tui/src/chatwidget/protocol.rs`; differing completed, interrupted and failed behavior.
10. OpenAI, [pinned side-conversation UI](/tmp/codex-src.uaLmNC/codex-rs/tui/src/app/side.rs:225), `codex-rs/tui/src/app/side.rs`; local side-thread ownership of the suppression mode.
11. OpenAI, [pinned PostToolUse regression](/tmp/codex-src.uaLmNC/codex-rs/core/tests/suite/hooks.rs:5215), `codex-rs/core/tests/suite/hooks.rs`; continue-false still produces a second model request. Read as source, not executed as a Rust test here.
12. OpenAI, [pinned turn suspension](/tmp/codex-src.uaLmNC/codex-rs/core/src/session/turn_suspension.rs:14), `codex-rs/core/src/session/turn_suspension.rs`; recovery without a terminal and explicit pending-input loss.
13. Statewright, [managed MCP bridge](/Users/ben/dev/statewright/plugins/executor/lib/managed-mcp-bridge.mjs:52), current local checkout inspected 2026-09-14; existing forwarding seam, not an implemented response barrier.

Additional direct evidence: [native diagnostic source](probes/turn-settings-workaround.mjs) and [machine-readable results](probes/turn-settings-workaround-results.json). Seven native scenarios passed, including expected rejection cases and two extra negative assertions in the active-turn scenario. [Native TUI evidence](probes/turn-settings-tui-results.json) records the separate interactive acceptance test and eleven passing assertions.

## Research Gaps & Limitations

- The diagnostic used scripted HTTP Responses. It tested compatible catalog clones, unmodified pinned Sol/Astra metadata rejection, and a Sol effort-only update; it did not exercise real hosted inference, OAuth, provider WebSockets, model-specific prompt correctness or billing attribution.
- Native TUI acceptance covers compatible switching, one queued text message, genuine Escape cancellation and a subsequent usable turn. The original model/effort footer remains during the switched step. Attachments, pending-steer races and full Statewright integration remain untested.
- The MCP barrier, code-mode serialization and route-generation coordination are proposals. No production runtime, workflow, installed configuration or Qwen-plugin behavior was changed.
- The current source is version-pinned. Public documentation lag and experimental behavior prevent treating this as a stable universal Codex API.
- Other app-server-shaped clients must be checked independently. Similar transport shape does not imply support for these methods or identical cleanup semantics.
- No PTY adapter or renderer fork was built. Their effort and correctness remain engineering assessments.

## Search Methodology

Depth: Deep. The investigation started with the existing Statewright decision record, official app-server documentation and pinned native renderer. Searches included “Codex app server turn interrupt notifications,” “Codex conversation interrupted banner,” “Codex hooks continue false stopReason,” “turn/settings/update Codex,” and “Codex active turn model settings,” restricted to official documentation domains for web evidence.

Source tracing followed terminal dispatch into input restoration, side-mode selection, hook parsing and its regression tests, then thread settings into the separate live-turn settings API. Four isolated native cases tested the decisive API behavior rather than relying only on schema acceptance. Contradictory-looking hook terminology was resolved against both event-specific documentation and the pinned regression test. Unrelated search hits and third-party summaries were not used as supporting evidence.
