# Forge/Qwen Tool-Protocol Experiment

## Research boundary

Forge reports substantial Qwen3-8B gains on its 26-scenario tool-workflow
suite. Its reported `Scr` is a composite workflow score, not a solve rate:

| Serving/tool mode | Quantization | Bare `Scr` | Reforged `Scr` | Lift |
| --- | ---: | ---: | ---: | ---: |
| Ollama/native | Q8 | 47.3 | 67.5 | +20.2 |
| Ollama/native | Q4 | 40.7 | 64.9 | +24.2 |
| llama-server/native | Q8 | 50.4 | 68.2 | +17.8 |
| llama-server/native | Q4 | 53.2 | 67.3 | +14.1 |
| llama-server/prompt | Q8 | 63.5 | 72.0 | +8.5 |
| llama-server/prompt | Q4 | 57.4 | 71.1 | +13.7 |

These are function-calling workflow results, not SWE-bench repair scores, so
they motivate a protocol experiment but do not predict comparable SWE-bench
lift.

Sources:

- [Forge repository](https://github.com/antoinezambelli/forge)
- [Forge reforged-versus-bare results](https://github.com/antoinezambelli/forge/blob/main/docs/results/raw/reforged-vs-bare.md)
- [Forge text-response-intent ADR](https://github.com/antoinezambelli/forge/blob/main/docs/decisions/013-text-response-intent.md)
- [Qwen function-calling guide](https://qwen.readthedocs.io/en/stable/framework/function_call.html)
- [Ollama tool-calling guide](https://docs.ollama.com/capabilities/tool-calling)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)

## Root cause in Statewright

Before this branch, native tool definitions were sent to Ollama, but subsequent
history flattened assistant tool calls into text and returned all tool outputs
as one `user` message. Call IDs, per-call result identity, and the `tool` role
were lost. Malformed string arguments were also silently replaced with `{}`.
This contradicted both Qwen's OpenAI-compatible example and Ollama's multi-turn
agent-loop example.

That defect can explain malformed/stale multi-step tool behavior. It does not
explain every localization, validation, or patch-quality failure observed in
SWE-bench, and this experiment must not attribute unrelated failures to it.

## Branch treatment

The branch implements a model-agnostic protocol layer with Qwen-compatible
rescue parsing:

1. Send `tool_choice: required` for state-machine turns. `transition` remains
   available, so the model always has a non-edit completion action.
2. Replay the assistant tool-call message and one correlated `tool` result per
   call using stable IDs.
3. Preserve tool-call reasoning as assistant content for the active multi-step
   chain rather than dropping it.
4. Accept the reasoning field names used across OpenAI-compatible Qwen and
   Ollama responses (`reasoning`, `reasoning_content`, and `thinking`).
5. Rescue fenced or embedded Forge/OpenAI JSON, Hermes `<tool_call>` JSON,
   Qwen rehearsal and function/parameter forms, and Mistral bracket calls.
   Thinking-tag contents are excluded so an internal rehearsal is not executed
   as a requested action.
6. Retry prose-only responses inside the same logical turn with a bounded,
   configurable correction (`SW_TOOL_PROTOCOL_RETRIES`, default `2`, max `5`).
7. Reject malformed argument shape through the matching tool-result channel;
   never coerce invalid arguments to an empty object.
8. Disable silent native-to-raw fallback by default. The old behavior is
   available only as `DEPRECATED_SW_NATIVE_RAW_FALLBACK=1` for reproduction.
9. Enforce the assistant-call/result invariant at serialization. If executor
   control flow interrupts a tool batch, emit a correlated, explicitly
   unconfirmed result and log its call ID before the next model request.

## Live protocol check

On 2026-07-22, the deployed Ollama OpenAI-compatible endpoint advertised
`qwen3:8b` and passed a two-turn protocol probe. With `tool_choice: required`,
Qwen returned an `echo` call with an ID and JSON-string arguments. A second
request replayed the full assistant call plus a `role: tool` result carrying the
same ID; Qwen accepted the history and returned the requested `finish` call.
The deployed response used the `reasoning` field.

## Measurement

The harness logs protocol corrections and rescues as:

```text
[TOOL PROTOCOL] corrections=N rescued=true|false
```

Promotion must compare official SWE-bench verification only. Protocol metrics
are mechanism telemetry, not solves. A focused repeat tranche should compare:

- official solve count and non-infra completion denominator;
- prose-only/native-call rate;
- malformed argument rate;
- repeated identical edit/test loops;
- time to first valid edit and total model calls.
