# Statewright — State Machine Pipeline Architecture

## Overview

The `gen_sm => llm_solve` pipeline separates the intelligence required to design a plan from the intelligence required to execute it. A model (or fine-tuned specialist) generates a task-specific state machine, then a second model (potentially smaller, cheaper) executes within those constraints.

This formalizes prompt engineering and bespoke scaffolding into a machine-readable, composable, trainable structure.

---

## The Pipeline

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Task Input   │────▶│  State Machine    │────▶│  Executor     │
│  (issue desc) │     │  Generator        │     │  (any model)  │
│               │     │  (planner model)  │     │               │
└──────────────┘     └──────────┬───────┘     └──────┬───────┘
                                │                      │
                                ▼                      ▼
                        StateMachineDefinition    Task Result
                        {                         (fix applied,
                          states,                  tests pass,
                          transitions,             diff minimal)
                          guards,
                          allowed_tools,
                          safe_next,
                          max_iterations
                        }
```

### Stage 1: Generate State Machine (gen_sm)

**Input:** Task description (issue text, error message, feature request)
**Output:** A `StateMachineDefinition` JSON tailored to this specific task
**Model:** Can be frontier (one-shot, high quality), fine-tuned specialist (cheap, fast), or same model as executor (single-model mode)
**Cost:** One API call. Structured output. Low temperature. Cached and reusable for similar tasks.

The generator model's job is to answer:
- What phases does this task require? (planning, implementing, testing, deploying)
- What tools are appropriate in each phase?
- Where are the danger points that need human approval?
- What's the maximum effort per phase before escalating?
- What are the valid transitions and rollback paths?

### Stage 2: Execute Within State Machine (llm_solve)

**Input:** The generated `StateMachineDefinition` + the task description + working directory
**Output:** The completed task (files modified, tests passing)
**Model:** Any model. Smaller models get more guardrails (safe_next, auto-test, edit_line). Larger models get fewer.
**Cost:** Multiple API calls (one per step). The state machine constrains how many.

The executor model's job is:
- Use the allowed tools in each state
- Follow the transitions
- Produce the actual fix/feature/change

### Why Separation Matters

| Dimension | Single-model (current) | Pipeline (gen_sm => llm_solve) |
|---|---|---|
| Planning cost | Every run re-plans from the system prompt | Generate once, reuse across runs |
| Executor model size | Must be large enough to both plan and execute | Can be small — the plan is provided |
| Plan quality | Limited by executor model's planning ability | Can use frontier model for planning, commodity for execution |
| Reproducibility | Plan is implicit in prompt, varies per run | Plan is an explicit artifact, deterministic |
| Trainability | Can't train on "good plans" | Can fine-tune planner on successful plans |

---

## Planner Model Training

### Training Data Source

Every successful Statewright execution produces a training triple:

```json
{
  "task": "Fix the failing test in test_calc.py...",
  "state_machine": { "id": "fix-calc-bug", "initial": "planning", "states": {...} },
  "outcome": {
    "success": true,
    "steps": 10,
    "lines_changed": 1,
    "model_used": "gemma4:e2b",
    "guardrails_fired": ["tool_block:write_file_in_planning", "minimizer:1_line"]
  }
}
```

Failed executions are negative signal:

```json
{
  "task": "...",
  "state_machine": { ... },
  "outcome": {
    "success": false,
    "failure_reason": "model rewrote 21/26 lines, minimizer rejected",
    "steps_before_failure": 7,
    "model_used": "gemma3:latest"
  }
}
```

### What the Planner Learns

From the experimental data we already have:

1. **Tool selection by model capability:**
   - For ≤10B models: include `edit_line`, exclude `write_file`
   - For 10-30B models: include `edit_line` + `patch_file`
   - For 30B+: all tools

2. **Safe_next topology:**
   - Linear states (planning → implementing) should have `safe_next`
   - Branching states (testing: pass vs fail) should NOT have `safe_next`

3. **Max iterations calibration:**
   - Planning: 5 for ≤10B (they need more attempts), 3 for 30B+
   - Implementing: 3 universally (minimizer catches bad attempts)

4. **Programmatic state selection:**
   - Testing state should always be programmatic (auto-run tests)
   - Minimizing should always be programmatic (auto-diff check)
   - Planning and implementing should always be LLM-driven

5. **State machine topology by task type:**
   - Bug fix: planning → implementing → testing → review
   - Feature add: planning → designing → implementing → testing → review
   - Refactor: planning → implementing → testing (no review — refactors are verified by tests alone)
   - Research: gathering → analyzing → summarizing
   - Deploy: planning → building → staging → verifying → production (multiple approval gates)

### Training Approach

**Phase 1: Template library.** Curate 10-20 state machine templates for common task types. The planner selects and adapts a template based on task description keywords.

**Phase 2: Fine-tuning.** Collect 1,000+ (task, state_machine, outcome) triples from real executions. Fine-tune a small model (7-14B) on successful triples only. The model learns to predict optimal state machine structure from task descriptions.

**Phase 3: Reinforcement.** Use outcome quality (steps to completion, diff size, guardrails fired) as a reward signal. The planner learns that fewer steps + smaller diffs = better state machines.

---

## Deployment Configurations

### Single-Model Mode (Current)

```
User → [Model] → gen_sm → [Same Model] → llm_solve → Result
```

The model generates its own state machine then executes within it. Simplest deployment. Works with 20B+ models. The state machine generation is the first step of execution.

### Split-Model Mode

```
User → [Frontier Model] → gen_sm → [Commodity Model] → llm_solve → Result
```

Use Claude/GPT for planning (one call, ~$0.01), use local 9B model for execution (many calls, ~$0). The expensive intelligence designs the plan once. The cheap intelligence follows it repeatedly.

**Economics:** A Opus call to generate the state machine costs ~1K tokens input + 2K output ≈ $0.04. The local model execution costs $0 (self-hosted). The frontier model amortizes across all subsequent runs of the same task type.

### Fine-Tuned Planner Mode

```
User → [Statewright Planner 7B] → gen_sm → [Any Model] → llm_solve → Result
```

A purpose-built small model that only generates state machines. Runs locally alongside the executor. No API calls at all. The planner model is the Statewright product — it encodes all the scaffolding knowledge that currently lives in prompt engineering.

### Cached Template Mode

```
User → [Template Matcher] → select_sm → [Any Model] → llm_solve → Result
```

No LLM for planning at all. A keyword/embedding classifier selects from a library of pre-validated state machine templates. Zero planning latency. Works for well-understood task categories (bug fix, refactor, test writing).

---

## Relationship to Existing Work

### vs. Prompt Engineering

Prompt engineering: "Please make minimal changes. Don't rename variables."
State machine pipeline: `implementing.allowed_tools = [edit_line]`, `max_diff_lines = 5`

Both constrain model behavior. The pipeline is:
- **Inspectable**: the constraints are a data structure, not buried in a prompt
- **Enforceable**: tool blocking and diff checking are deterministic
- **Trainable**: you can fine-tune a model to produce better constraints
- **Composable**: states can be added/removed without rewriting prompts
- **Shareable**: a good state machine for "Django bug fix" works for anyone

### vs. SWE-agent / OpenHands Scaffolding

SWE-agent uses a fixed Agent-Computer Interface (ACI) with hardcoded tool definitions and a single agent loop. The scaffolding is the same for every task.

Statewright generates task-specific scaffolding. A deployment task gets approval gates and rollback states. A bug fix gets a minimizer and auto-test. A research task gets no write tools until summarizing. The structure adapts to the task.

### vs. Agentless

Agentless uses a two-phase pipeline (localize → patch) which is conceptually similar to gen_sm → llm_solve. The difference: Agentless hard-codes the two phases. Statewright generates an arbitrary number of phases with arbitrary tool constraints per phase.

### vs. Agent Fine-Tuning

Agent fine-tuning (training models to be better tool users) improves the executor. The gen_sm pipeline improves the plan. Both are complementary — a fine-tuned executor running within a generated state machine gets both benefits.

---

## Experimental Evidence

From experiments 001-003:

| Finding | Implication for pipeline |
|---|---|
| Scaffold engineering moves SWE-bench 42%→78% with same model | The state machine IS the scaffold — gen_sm automates scaffold engineering |
| gemma4 (9B) succeeds with edit_line, fails with write_file | Planner must select tools by model capability |
| gpt-oss (20B) succeeds with native tool calling, fails with raw JSON | Planner must select tool calling mode by model |
| Programmatic auto-test eliminates testing state navigation failures | Planner should mark states as programmatic vs LLM-driven |
| safe_next helps small models but hurts on branching states | Planner must understand when safe_next is appropriate |
| Minimizer rejects sloppy rewrites from all model sizes | Planner should always include programmatic minimizer for implementing states |
| 70B model doesn't need most guardrails but isn't hurt by them | Conservative state machines work across all sizes — optimize for the smallest viable model |

### The headline result

A 9B model + a well-designed state machine solved a real bug fix task that the same 9B model cannot solve without the state machine. The state machine was designed by hand. A planner model would generate it automatically.

**If the planner model can generate state machines at the quality level of our hand-crafted ones, then the pipeline enables 9B models to perform at levels currently requiring 70B+ models, on structured tasks, at 1/8th the compute cost.**

---

## Implementation Roadmap

### Phase 1: Template Library (Now)

- Curate state machines for: bug_fix, feature_add, refactor, research, deploy
- Include model-capability adapters (tool selection by model size)
- Keyword classifier selects template from task description
- Ships with Statewright as default templates

### Phase 2: Generator Integration (Next)

- Wire the existing `statewright-agent::generator` to the demo pipeline
- Use frontier model (via Ollama or API) for gen_sm
- Use local model for llm_solve
- Validate generated state machines with `statewright-agent::validator`
- A/B test: hand-crafted vs generated state machines on same tasks

### Phase 3: Training Data Collection

- Instrument all executions to produce (task, state_machine, outcome) triples
- Store in Postgres alongside instance transitions
- Build dataset export for fine-tuning

### Phase 4: Planner Model

- Fine-tune a 7-14B model on successful triples
- Evaluate: does the fine-tuned planner produce better state machines than the template library?
- Evaluate: does gen_sm(planner_7B) + llm_solve(gemma4_9B) outperform llm_solve(gemma4_9B) alone?
- Target: SWE-bench Lite easy subset, comparing with and without pipeline
