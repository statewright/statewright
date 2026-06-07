# Model Traits

Statewright includes a model traits registry that automatically configures the agent harness for any supported model. Traits describe how a model handles tool calling, reasoning, context, and output formatting.

## Quick Start

Call `statewright_get_model_traits` with a model tag to get the configuration:

```json
{"name": "statewright_get_model_traits", "arguments": {"model": "qwen3:8b"}}
```

Returns:
```json
{
  "model": "qwen3:8b",
  "traits": {
    "tool_mode": "native",
    "reasoning": true,
    "response_field": "content",
    "history_window": 5,
    "max_full_read_lines": 200,
    "max_diff_lines": 10,
    "unescape_tool_args": false,
    "single_quote_json": false,
    "num_ctx": 8192
  }
}
```

Call without a model tag to get the full registry:
```json
{"name": "statewright_get_model_traits", "arguments": {}}
```

## Trait Fields

| Field | Type | Description |
|-------|------|-------------|
| `tool_mode` | `native\|raw\|auto` | How the model receives tool definitions. `native` uses Ollama's tool calling API. `raw` embeds tool schemas in the prompt as JSON. `auto` uses native for regular steps, raw for checkpoints. |
| `reasoning` | `bool` | Whether the model supports chain-of-thought reasoning. When true, the harness allows thinking text before tool calls. |
| `response_field` | `content\|reasoning` | Which field contains the model's actionable output. Most models use `content`. Reasoning models like gpt-oss output to `reasoning`. |
| `history_window` | `int` | Number of conversation turns to retain in the sliding window. Smaller for small models (3) to prevent context pollution. Larger for big models (10). |
| `max_full_read_lines` | `int` | Maximum lines for unranged file reads. Files exceeding this are blocked with a suggestion to use ranged reads. Prevents context clobbering on small models. |
| `max_diff_lines` | `int` | Maximum changed lines before an edit is considered oversized. Small models produce better results with tight limits (5). Larger models handle bigger edits (15). |
| `unescape_tool_args` | `bool` | Whether the model double-escapes JSON in native tool call arguments (`\"` instead of `"`). Common with Gemma models in native mode. |
| `single_quote_json` | `bool` | Whether the model outputs single-quoted JSON (`{'key': 'val'}` instead of `{"key": "val"}`). Common with Qwen Coder models. |
| `num_ctx` | `int` | Ollama context window size override. |

## Hierarchical Resolution

Traits resolve hierarchically: defaults → family → size → tag.

```
Registry defaults (all models)
  └─ Family defaults (e.g., "qwen3")
       └─ Size overrides (e.g., "8b")
            └─ Tag overrides (e.g., custom finetunes)
```

Each level inherits from its parent and overrides only the fields it specifies.

## Registered Models

The built-in registry includes traits for:

- **gemma4** — native tool mode, unescape required, strict diff limits
- **gemma3** — raw tool mode, strict diff limits
- **qwen2.5-coder** — raw/auto tool mode, single-quote JSON normalization
- **qwen3** — native tool mode, reasoning support, stable tool calling
- **gpt-oss** — native tool mode, reasoning output in `reasoning` field, Harmony token format
- **deepseek-r1** — raw tool mode, reasoning in `reasoning` field
- **devstral-small-2** — raw tool mode, agentic coding optimized

## Adding Custom Models

To add traits for a custom or finetuned model, call `statewright_get_model_traits` with no arguments to get the full registry, then provide a custom registry file with your additions. The registry JSON format:

```json
{
  "version": 1,
  "defaults": { ... },
  "models": {
    "my-finetune": {
      "family_defaults": {
        "tool_mode": "native",
        "reasoning": false,
        "max_diff_lines": 10
      },
      "sizes": {
        "7b": { "history_window": 3, "max_full_read_lines": 80 }
      }
    }
  }
}
```

## Use in Plugins

Plugins should call `statewright_get_model_traits` on workflow load to configure:

1. **Context management** — set sliding window size and file read limits from `history_window` and `max_full_read_lines`
2. **Tool call parsing** — enable JSON unescape or single-quote normalization based on `unescape_tool_args` and `single_quote_json`
3. **Prompt format** — use clean prompts for `native` tool mode, JSON-schema prompts for `raw`
4. **Response parsing** — read from `content` or `reasoning` field based on `response_field`
5. **Edit constraints** — set diff size limits from `max_diff_lines`

## Mixture of Models (MoM)

Model traits enable the MoM escalation pattern: when a small model fails, the harness escalates to a larger model with different traits. The traits auto-configure the harness for each tier:

```
Tier 1: qwen3:8b (5GB)  — history_window=5, max_read=200
Tier 2: devstral-small-2:24b (15GB) — history_window=10, max_read=400
Tier 3: Frontier API — no local constraints
```

Each escalation level resolves its own traits. The harness switches tool mode, prompt format, and context limits automatically.
