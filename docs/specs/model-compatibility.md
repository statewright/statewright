# Statewright — Model Compatibility and Adaptation Layer

## Overview

Different models produce tool calls in different formats. The framework must parse all of them, not mandate a single format. This spec codifies three discoveries from experiments 001-005 and the gpt-oss debugging session.

---

## Discovery 1: num_ctx is Load-Bearing for Ollama

### The Problem

Ollama defaults to `num_ctx: 2048` tokens. State machine system prompts + tool definitions + localized code context + conversation history routinely exceed this. When context is silently truncated, the model never sees the tool definitions and outputs bare text or transitions-only instead of tool calls.

### The Fix

All Ollama requests MUST include `"options": {"num_ctx": N}` where N is sufficient for the task:

| Task type | Recommended num_ctx | Why |
|---|---|---|
| Simple bug fix (small file) | 8192 | System prompt + small file + tools |
| SWE-bench (large file) | 32768 | Localized excerpts + tool definitions |
| TDD greenfield | 16384 | Stubs + test file + requirements |
| Full repo navigation | 65536+ | Multiple file reads in context |

### Implementation

The `OllamaConfig` should include a `context_size` field. The `ChatRequest` serializes it as `options.num_ctx`. Default should be 32768, not 2048.

```rust
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
    max_tokens: u32,
    tools: Option<Vec<ToolDefinition>>,
    options: Option<OllamaOptions>,
}

struct OllamaOptions {
    num_ctx: u32,
}
```

### Models affected

All Ollama-hosted models. This is not a model issue — it's a server default issue. Every model produces better output with adequate context.

---

## Discovery 2: Reasoning Models Output in Non-Standard Formats

### The Problem

Reasoning models (gpt-oss, deepseek-r1) perform chain-of-thought in a `reasoning` or `reasoning_content` field, then output a minimal `content` field. Tool invocations may appear:

1. **In the content field** as JSON — works with our raw JSON parser
2. **In the reasoning field** as Harmony-format tokens — invisible to standard parsers
3. **Mixed** — valid JSON followed by trailing reasoning text in the same content field

Format 3 is the most common failure mode. The model outputs:
```
{"tool_calls":[{"name":"edit_block","args":{...}}]}

We also need to fix the non-commutative branch...
```

Standard JSON parsers fail because the trailing text makes it invalid JSON.

### The Fix

The response parser must handle mixed JSON+text content:

1. **Extract the reasoning field** from the API response. If content is empty but reasoning contains tool calls or transitions, use the reasoning as content.

2. **Parse JSON from mixed content.** When `serde_json::from_str` fails on the full string, find the first `{` and use a brace-counting parser to find its matching `}`, ignoring everything after.

3. **Support multiple output formats** for the same tool call:
   - `{"tool_calls":[{"name":"X","args":{...}}]}` — standard
   - `{"action":"X","path":"...","old":"...","new":"..."}` — gpt-oss style
   - `{"name":"X","args":{...}}` — bare tool call without wrapper
   - `{"event":"X"}` — bare transition

### Models affected

| Model | Content field | Reasoning field | Tool call format |
|---|---|---|---|
| gemma3/4 | JSON or empty | None | Standard `tool_calls` wrapper |
| llama3.3 | JSON | None | Standard `tool_calls` wrapper |
| gpt-oss | JSON + trailing text | Chain-of-thought | `action` format or standard |
| deepseek-r1 | Often empty | Chain-of-thought + tools | Harmony tokens |

---

## Discovery 3: Model Tool Mode Requirements

### The Problem

"Native tool calling" and "raw JSON prompting" are not interchangeable. Each model has a specific mode that works and modes that fail silently.

### The Modes

**Native tool calling:** Tool definitions sent via the `tools` parameter in the API request. The model returns structured `tool_calls` in the response message. Requires: model trained for function calling, Ollama chat template includes `{{ .Tools }}`, no streaming parser bugs.

**Raw JSON prompting:** Tool definitions described in the system prompt as JSON examples. The model outputs `{"tool_calls":[...]}` as text content. Works with any model that can generate JSON.

### Per-Model Requirements

| Model | Native | Raw JSON | Notes |
|---|---|---|---|
| gemma3 (~4B) | 400 error | **Works** | No native support |
| gemma4:e2b (~9B) | Streaming bug | **Works** | `@ai-sdk` drops tool_calls due to `reasoning` field in deltas |
| gemma4:31b | Streaming bug | **Works** | Same as e2b |
| gpt-oss:20b | Harmony format (broken) | **Works** (with parsing fixes) | Reasoning model, needs num_ctx + mixed-content parser |
| llama3.3:70b | Works but regresses quality | **Works** | Native causes whole-file rewrites; raw produces surgical diffs |
| deepseek-r1 | Harmony format | Partial | Reasoning model, burns tokens on thinking |

### Recommendation

**Default to raw JSON mode for all models.** Native is a potential optimization for models that fully support it, but raw JSON works universally with the adaptive parser.

The framework should auto-detect mode failures and fall back:
1. Try native if `--tool-mode auto`
2. If native returns 400 or empty tool_calls, fall back to raw JSON
3. Log which mode succeeded for this model (learning)

### Conversation Retention by Model Size

| Model size | Strategy | Rationale |
|---|---|---|
| ≤10B | Clear per cycle | Context overflow from failed attempts poisons subsequent calls |
| 10-30B | Clear per phase | Enough context for multi-step within a phase, not across |
| 30B+ | Keep all | Benefits from seeing what was already tried |

---

---

## Discovery 4: Why Statewright Succeeds Where General Agents Fail

### The Problem

opencode, Codex CLI, and similar agentic coding tools fail with small/medium Ollama models on non-trivial tasks — not because the models can't reason, but because the agent frameworks waste context on framework overhead.

A general-purpose agent dumps into context:
- A large system prompt describing all capabilities
- The full tool schema for every available tool (file ops, git, shell, search, etc.)
- The entire conversation history from all previous turns
- Framework bookkeeping (session state, error recovery instructions)

On a model with 8K-32K effective context, this overhead leaves little room for the actual task — the code, the tests, the issue description. The model sees the framework and loses the problem.

### What Statewright Does Differently

**Per-state context minimization.** Each state machine state defines exactly what the model needs to see:

| Context element | General agent | Statewright |
|---|---|---|
| Tool definitions | All tools, always | Only tools allowed in current state |
| System prompt | One large prompt for everything | State-specific instructions |
| Conversation history | Full history | Capability-gated (clear per cycle for ≤10B) |
| File content | Model navigates (burns context) | Programmatic localization (zero LLM context) |
| Test execution | Model calls test tool (burns context) | Programmatic auto-test (zero LLM context) |

A planning state shows `[read_file, grep, run_test]` — 3 tools. An implementing state shows `[edit_line, edit_block, write_file]` — 3 tools. The model never sees all 10+ tools at once.

The programmatic states (localizing, testing, minimizing) do their work without consuming any model context. The model only gets the results — focused excerpts, test pass/fail, diff stats — not the raw 636 lines of code or the full pytest output.

### The Measured Impact

**gemma4:31b (19.9GB):**
- opencode: FAILED — tool protocol mismatch, streaming parser bug, model hallucinates fake tool calls
- Statewright: SUCCESS — 11 steps, 1/636 lines changed on SWE-bench sympy-21847

**gpt-oss:20b (13.8GB):**
- opencode: FAILED — model generates XML/Harmony tool calls that the framework can't parse
- Statewright: Produces correct `apply_patch` with `max→sum` fix (parsing fix needed for trailing text)

The models are identical. The context they receive is different. Statewright gives the model what it needs to solve the task. General agents give the model what the framework needs to operate.

### Implication for Other Frameworks

This insight applies beyond Statewright. Any coding agent using Ollama models should:

1. **Minimize tool definitions per turn** — only show tools relevant to the current step
2. **Clear conversation history for small models** — the test suite is the memory, not chat
3. **Use programmatic file navigation** — grep + line-range reads instead of full file dumps
4. **Set num_ctx** — Ollama's 2048 default is catastrophically small for any agentic task
5. **Separate mechanical work from creative work** — don't burn LLM context on running tests or checking diffs

The state machine is one way to enforce this. Any framework that does per-step context management will see similar improvements with small models.

---

## Implementation Checklist

### Parser Robustness (Critical)

- [x] Handle `{"tool_calls":[...]}` standard format
- [x] Handle `{"event":"X"}` bare transitions
- [x] Handle `{"action":"X",...}` reasoning model format
- [x] Handle `{"name":"X","args":{...}}` bare tool calls
- [ ] Handle JSON + trailing text (brace-counting parser)
- [ ] Extract tool calls from `reasoning` field when content is empty
- [x] Strip markdown code fences
- [x] Find embedded JSON via `find('{')`/`rfind('}')`

### Ollama Configuration (Critical)

- [x] Send `options.num_ctx` in all requests (default 32768)
- [ ] Make num_ctx configurable via `OllamaConfig`
- [ ] Auto-detect model context limits from Ollama `/api/show`

### Mode Detection (Important)

- [x] Support `--tool-mode raw|native|auto`
- [x] Auto-fallback from native to raw on 400/empty
- [ ] Log successful mode per model for future auto-selection
- [ ] Per-model mode override in config

### Reasoning Model Support (Important)

- [x] Parse `reasoning` field from API response
- [x] Use reasoning content when content is empty
- [ ] Inject reasoning into conversation for multi-turn reasoning
- [ ] Handle Harmony `<|channel|>` tokens for deepseek-r1/gpt-oss native mode

### Conversation Management (Important)

- [x] `ConversationStrategy` enum: ClearPerCycle, ClearPerPhase, KeepAll
- [x] Auto-select based on `--model-size`
- [ ] Auto-detect model size from Ollama `/api/show` response
