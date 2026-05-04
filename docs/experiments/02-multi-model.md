# Experiment 002: Multi-Model Self-Guardrailing with Programmatic Minimizer

**Date:** 2026-04-23  
**Models tested:** gemma3 (3.3GB), gemma4:e2b (7.2GB), gpt-oss:20b (13.8GB), llama3.3 (42.5GB)  
**Infrastructure:** Ollama on K8s (k8s cluster), Statewright engine (Rust)  
**Status:** Core thesis validated. Optimization ongoing.

---

## Thesis (Refined)

Prompt engineering for specific use cases works — but it's bespoke, fragile, and doesn't generalize. What we're building is the same thing (constraining model behavior for reliability) but expressed as a **general, customizable framework** rather than per-task prompt hacks.

The state machine defines the solution space. Models learn to play by the rules. The rules are extensible. Weaker models get more guardrails (safe_next, programmatic checks). Stronger models get the same structure but need fewer training wheels. The framework adapts to the model — the model doesn't need to adapt to the framework.

This is the distinction from current SOTA approaches: frontier models achieve reliability by brute-forcing through 1T+ parameters. Statewright achieves reliability by constraining the search space so that smaller models can't fail in the ways that make them unreliable.

---

## Task

Fix a deliberate bug in a Python calculator module. The `divide()` function uses `//` (integer division) instead of `/` (true division). One failing test out of seven. No hint comment in the source.

**Success criteria:**
1. All 7 tests pass
2. Minimal diff (≤5 lines changed)
3. No introduced regressions
4. Model navigates the full state machine lifecycle

---

## State Machine (Final Iteration)

```
planning (max 5 iterations, safe_next: implementing)
  Tools: read_file, list_directory, run_test
  → PLAN_READY/DONE → implementing
  → FAIL → failed

implementing (max 3 iterations, safe_next: testing)
  Tools: read_file, write_file
  PROGRAMMATIC: on exit, diff check — reject if >5 lines changed, restore snapshot
  → DONE → testing
  → FAIL → failed

testing (max 3 iterations, NO safe_next — model must use correct event names)
  Tools: read_file, run_test
  → TESTS_PASS → review (requires_approval)
  → TESTS_FAIL → implementing
  → FAIL → failed

review (human gate — auto-approved in demo, auto-advances to completed)
  → APPROVED → completed
  → REJECTED → implementing

completed (final)
failed (final)
```

### Guardrail Mechanisms Employed

| Mechanism | What it does | Why it exists |
|---|---|---|
| **Tool enforcement** | Blocks tools not in the current state's allowed list | Prevents writing during planning, testing during implementing |
| **safe_next** | Fallback target when model emits unrecognized transition event | Compensates for weak instruction-following in small models |
| **Programmatic minimizer** | Auto-rejects diffs >5 lines, restores snapshot, bounces back to implementing | Enforces surgical changes without relying on model discipline |
| **Decision checkpoints** | Forces transition-or-fail when max_iterations reached | Prevents infinite loops in any state |
| **Conversation history** | Tool results passed as actual message turns, not flat summaries | Gives models memory across steps |
| **Native tool calling** | transition() and get_available_actions() as API-level tools | Models trained for function calling use their trained pathway |
| **Bare event parsing** | Handles `{"event": "NAME"}` without tool_calls wrapper | Catches models that output events in non-standard formats |
| **Auto-restore** | RAII guard snapshots files before run, restores on exit (even on panic) | Ensures repeatable experiments |
| **Approval gate** | TESTS_PASS requires human approval before advancing | In production: human checkpoint. In demo: auto-approved, tests ARE the human |

---

## Results by Model

### gemma3:latest (3.3GB, ~4B parameters)

**Outcome: FAILED — minimizer rejects**

| Run | Fix correct | Lines changed | Minimizer | Navigation | Steps |
|-----|-------------|---------------|-----------|------------|-------|
| Pre-conversation-history | Yes | 21/26 | N/A | Looping, never transitioned | 7 |
| Post-conversation-history | Yes | 21/26 | N/A | Completed in 4 steps! | 4 |
| With minimizer | Yes | 21/26 | REJECTED ×2, gave up | Transitioned via safe_next | 4 |

**Behavior pattern:**
- Reads test file, immediately knows the fix (skips reading source — guesses from test expectations alone)
- Always rewrites the entire file — renames variables (a,b → x,y), drops docstrings, reformats everything
- Cannot produce a minimal diff at any temperature or prompt variation
- Uses safe_next for every transition (says DONE/FINAL instead of PLAN_READY/MINIMAL)
- Guardrails correctly prevent the sloppy rewrite from shipping

**Key insight:** The 4B model identifies the bug correctly and faster than larger models (1-2 steps). It lacks the precision to change a single line while reproducing the rest verbatim. This is a fundamental attention/context limitation, not a reasoning limitation. The programmatic minimizer correctly catches this.

### gemma4:e2b (7.2GB, ~9B parameters)

**Outcome: FAILED — minimizer rejects**

| Run | Fix correct | Lines changed | Minimizer | Navigation | Steps |
|-----|-------------|---------------|-----------|------------|-------|
| With minimizer | Yes | 24/26 | REJECTED ×1, gave up | Better than gemma3, used get_available_actions | 10 |

**Behavior pattern:**
- Better planning: lists directory first, reads both files, runs tests
- Still rewrites the entire file (24/26 lines changed)
- Tried to write_file during planning — blocked by tool enforcement
- Used checkpoint transitions correctly
- Produced articulate error message: "Could not fix the bug because execution of tests is blocked and previous attempts to modify the file were rejected due to line count limits" — **the model understood why it failed**

**Key insight:** The 9B model has better protocol adherence than the 4B model but still cannot produce surgical diffs. The capability cliff for minimal-change writing is above 9B parameters.

### gpt-oss:20b (13.8GB, ~20B parameters)

**Outcome: PARTIAL SUCCESS — correct fix, surgical diff, stuck on testing navigation**

| Run | Fix correct | Lines changed | Minimizer | Navigation | Steps |
|-----|-------------|---------------|-----------|------------|-------|
| Raw JSON mode (pre-native) | N/A | N/A | N/A | Empty responses, can't follow raw JSON protocol | 10 |
| Native tool calling | Yes | 1/26 | PASSED | Used transition() and get_available_actions() natively | 9 (to fix) |
| With testing fix | Yes | 1/26 | PASSED | Navigated to testing but couldn't run tests before transitioning | 15 |

**Behavior pattern:**
- Completely non-functional with raw JSON prompting (returns empty strings — trained for native function calling, not raw JSON output)
- Excellent with native tool calling: reads files, identifies bug, writes surgical 1-line fix
- Uses `get_available_actions()` when blocked — queries the state machine for what it can do
- Uses `transition(PLAN_READY)` and `transition(DONE)` correctly via native tool calling
- Struggles with testing state: defaults to `transition(DONE)` which isn't a valid event in testing
- Never runs `run_test` in the testing state before trying to transition

**Key insight:** This is the breakthrough model. 20B with native tool calling writes a 1-line fix that passes the programmatic minimizer. The failure is purely navigational (testing state protocol) not capability. The model that was completely non-functional with raw JSON becomes highly capable with native tool calling — the same model, different interface, dramatically different results.

### llama3.3:latest (42.5GB, 70B parameters)

**Outcome: SUCCESS**

| Run | Fix correct | Lines changed | Minimizer | Navigation | Steps |
|-----|-------------|---------------|-----------|------------|-------|
| Pre-conversation-history | Yes | N/A | N/A | Looping, re-reading files repeatedly | 25 (timeout) |
| Post-conversation-history | Yes | 1/26 | N/A | Full lifecycle in 9 steps | 9 |
| With minimizer | Yes | 1/26 | PASSED (never triggered) | Full lifecycle in 10 steps | 10 |

**Behavior pattern:**
- Reads test file, runs tests, reads source code, identifies bug — methodical 3-step planning
- Writes surgical 1-line fix: `return a // b` → `return a / b`
- Preserves all variable names, docstrings, formatting — 1/26 lines changed
- Uses correct transition names on first attempt (PLAN_READY, DONE, TESTS_PASS, APPROVED)
- Gets blocked trying run_test in implementing — correctly adjusts by transitioning to testing
- Navigates the full state machine lifecycle without safe_next or fallbacks

**Key insight:** The 70B model doesn't need most of the guardrails — but the guardrails don't hurt it. It follows the protocol naturally. The tool enforcement at step 5 (blocking run_test in implementing) is the one guardrail that actively shaped its behavior — and it adapted correctly.

---

## Capability Thresholds Identified

### Surgical Diff Capability

```
  4B (gemma3)     ████████████████████░ 21/26 lines — FAILS minimizer
  9B (gemma4)     █████████████████████ 24/26 lines — FAILS minimizer
 20B (gpt-oss)    █░░░░░░░░░░░░░░░░░░░  1/26 lines — PASSES minimizer
 70B (llama3.3)   █░░░░░░░░░░░░░░░░░░░  1/26 lines — PASSES minimizer
```

The cliff is between 9B and 20B. Below 9B, models rewrite entire files. At 20B+, models can change one line while reproducing the rest verbatim.

### Protocol Adherence

```
  4B  — Uses safe_next constantly. Invents transition names. Cannot self-correct.
  9B  — Uses safe_next frequently. Better error messages. Understands why it fails.
 20B  — Follows native tool calling protocol. Uses get_available_actions. Struggles with non-uniform state transitions.
 70B  — Follows raw JSON protocol precisely. Self-corrects from parse failures. Minimal guardrail reliance.
```

### Tool Calling Mode

```
  Raw JSON prompting  — Works for 70B. Fails completely for 20B (gpt-oss). Partially works for 4-9B.
  Native tool calling — Works for 20B+. Untested for smaller models (gemma3/4 may benefit).
```

The choice of tool calling interface changes whether a model can participate at all. gpt-oss:20b went from non-functional (raw JSON) to writing surgical fixes (native). **This is not a prompt engineering discovery — it's a protocol compatibility discovery.** The state machine framework must support both paths.

---

## Architecture Discoveries

### 1. Programmatic guardrails beat LLM-driven guardrails

The LLM-driven minimizer state (where the model reviewed its own diff) was completely ineffective. Models rubber-stamped their own sloppy work. The programmatic minimizer (automatic diff check + snapshot restore) is deterministic, reliable, and model-agnostic.

**Pattern:** If a constraint can be expressed programmatically, don't ask the model to enforce it on itself. Save LLM reasoning for decisions that require understanding, not discipline.

### 2. safe_next is an adapter for model capability

`safe_next` makes states navigable by models that can't reliably produce specific transition event names. It doesn't change the state machine's semantics — the same states and transitions exist. It changes the error handling: instead of rejecting unknown events, it falls back to a declared target.

States with branching transitions (testing: TESTS_PASS vs TESTS_FAIL) should NOT use safe_next because the branch target matters. States with a single forward path (planning → implementing) can safely use it.

**Pattern:** `safe_next` is a capability adapter, not a crutch. Its presence signals "this state has a clear forward path that weaker models may fail to name correctly."

### 3. Native tool calling is not optional

gpt-oss:20b went from 0% success to writing surgical fixes solely by switching from raw JSON to native function calling. The model is the same. The capability is the same. The interface determines whether the model can express its capability.

**Pattern:** The framework MUST support both native and raw JSON tool calling. The choice should be per-model, not per-deployment. Auto-detection (try native, fall back to raw) is the correct default.

### 4. The state machine IS the prompt engineering

Traditional prompt engineering: "Please make minimal changes. Don't rename variables. Only change the buggy line."

State machine engineering: `max_iterations: 3`, `allowed_tools: [read_file, write_file]`, programmatic diff check on exit.

Both constrain model behavior. The state machine approach is:
- **Inspectable** — the constraints are a data structure, not buried in a prompt
- **Enforceable** — tool blocking and diff checking are deterministic, not advisory
- **Composable** — states can be added/removed/reordered without rewriting prompts
- **Model-agnostic** — the same machine works across model sizes with capability adapters (safe_next)
- **Testable** — 91 unit tests validate the constraint logic independent of any model

The insight: **we're not replacing prompt engineering, we're formalizing it into a machine-readable, enforceable, composable structure.**

### 5. The conversation history is load-bearing

Every model improved dramatically when switched from flat text summaries to actual conversation history. The difference:
- Without: models re-read the same files repeatedly (no memory of what they already know)
- With: models build cumulative understanding and make transition decisions based on accumulated evidence

**Pattern:** Tool results must be passed as conversation turns, not summarized. The model needs to see "I read this file and it contained X" as something it *said*, not something it's told it did.

---

## What the Data Means for Statewright

### The pitch

"The same 20B open-source model that fails at basic bug fixing with raw prompting writes 1-line surgical fixes when constrained by a state machine. The state machine doesn't make the model smarter — it prevents the failure modes that make smart models unreliable."

### The market position

Frontier models (Opus, GPT-5) achieve reliability through scale — 1T+ parameters, $3-30 per million tokens, cloud-only. Statewright achieves comparable reliability through structure — state machines enforcing tool access, diff minimization, and decision checkpoints. The model runs locally on commodity GPUs.

This is not "small models are as good as big models." It's "small models constrained by good structure achieve specific task reliability that previously required big models." The structure compensates for the capability gap on well-defined tasks.

### The roadmap

1. **Auto-run tests on testing state entry** — don't wait for the model to call run_test, just do it
2. **Per-model capability profiles** — auto-select safe_next, tool mode, max_iterations based on model size
3. **LLM-generated state machines** — the model designs its own constraints for each task
4. **Multi-file tasks** — extend beyond single-file bug fixes
5. **Benchmark suite** — SWE-bench subset with and without guardrails across model sizes

---

## Full Scoreboard

| Model | Size | Fix | Diff | Minimizer | Protocol | Tool Mode | Outcome |
|-------|------|-----|------|-----------|----------|-----------|---------|
| gemma3 | 3.3GB | Correct | 21/26 | REJECTED | Weak | Raw JSON | FAILED |
| gemma4:e2b | 7.2GB | Correct | 24/26 | REJECTED | Moderate | Raw JSON | FAILED |
| gpt-oss | 13.8GB | Correct | **1/26** | **PASSED** | Good (native) | Native | PARTIAL (nav) |
| llama3.3 | 42.5GB | Correct | **1/26** | **PASSED** | Strong | Raw JSON | **SUCCESS** |

### Guardrails that fired (across all runs)

| Guardrail | Times fired | Models affected | Prevented |
|---|---|---|---|
| Tool enforcement (write blocked in planning) | 8+ | All | Premature file modification |
| Tool enforcement (run_test blocked in implementing) | 6+ | All | Skipping verification phase |
| Programmatic minimizer (diff rejection) | 5 | gemma3, gemma4, gpt-oss (once) | Shipping sloppy rewrites |
| safe_next (unknown transition name) | 10+ | gemma3, gemma4, gpt-oss | Protocol navigation failures |
| Decision checkpoint (max_iterations) | 8+ | All | Infinite loops in any state |
| Auto-restore (snapshot restore on exit) | Every run | All | Corrupted fixture state between runs |
| Approval gate (TESTS_PASS requires approval) | 3 | gpt-oss, llama3.3 | Direct path from testing to completed |

---

---

## Addendum: Gemma Reruns After Infrastructure Improvements

**Date:** 2026-04-23 (same session, late)

After implementing native tool calling, `transition()` / `get_available_actions()` tools, bare event parsing, and the auto-approve fix, the gemma models were rerun to see if the infrastructure improvements changed outcomes.

### gemma3 rerun

**Outcome: Still FAILED, but significantly better protocol adherence**

```
Step 1  planning  get_available_actions()      — queried the state machine (NEW behavior)
Step 2  planning  run_test()                    — ran tests
Step 3  planning  tried diff (BLOCKED)          — correctly blocked
Step 4  planning  get_available_actions()       — queried again
Step 5  planning  read_file(calc.py)            — read source
Step 6  CHECKPOINT transition(DONE)             — used transition tool correctly (NEW)
Step 7  implementing transition(FAIL)           — gave up without writing
```

**What changed:**
- Gemma3 now uses `get_available_actions()` to query the state machine — it asks "what can I do?" instead of guessing
- Uses the `transition()` tool in raw JSON mode — correct protocol, not bare `{"transition": "..."}`
- Native tool calling returns 400 (gemma3 doesn't support it) — auto-fallback to raw JSON works correctly
- Still gives up in implementing without writing the fix — the model knows what to do but can't commit to writing

**What didn't change:**
- Still can't produce a surgical diff (never reached write_file to test this)
- The 4B model's fundamental limitation isn't tool protocol — it's task confidence. It reads the source, identifies the bug, but FAILs when asked to write because it doesn't trust itself to produce correct output

### gemma4:e2b rerun

**Outcome: Still FAILED, but exposed a new failure mode — JSON serialization**

```
Step 1   planning      run_test()                  — ran tests first (good instinct)
Step 2   planning      read_file(calc.py)          — read source
Step 3   planning      write_file (BLOCKED)        — blocked in planning
Step 4   planning      run_test() via native       — native tool calling works for gemma4!
Step 5   planning      read_file(calc.py)          — re-read source
Step 6   CHECKPOINT    transition(DONE)             — used transition tool correctly
Step 7   implementing  write_file (GARBLED)         — content malformed, didn't execute
Step 8   implementing  read_file(calc.py)           — re-read to try again
Step 9   implementing  write_file (GARBLED)         — same issue
Step 10  CHECKPOINT    transition(DONE)             — advanced to testing
Step 11  testing       run_test()                   — RAN TESTS IN TESTING STATE (first small model to do this!)
Step 12  testing       write_file (BLOCKED)         — correctly blocked
Step 13  testing       write_file (BLOCKED)         — still trying
Step 14  CHECKPOINT    transition(DONE) → ERROR     — DONE not valid in testing
Step 15  CHECKPOINT    write_file (parse fail)      — garbled again
Step 16  CHECKPOINT    transition(FAIL)             — gave up
```

**What changed:**
- Gemma4 supports native tool calling (step 4) — didn't 400 like gemma3
- Uses `transition()` tool correctly at checkpoints
- **Step 11: ran `run_test` in the testing state** — this is the first time any sub-10B model correctly used a tool in the right state at the right time for the right reason
- Protocol navigation is dramatically better — uses the transition tool, responds to checkpoints

**What didn't change:**
- Still can't write the fix — but the reason is now clear: **JSON serialization failure**, not reasoning failure

**The JSON serialization issue:**

Gemma4 knows the fix (`return a / b` instead of `return a // b`). It constructs a write_file call with the correct content. But the content is a Python file with triple-quoted docstrings (`"""..."""`), and serializing triple quotes inside a JSON string requires careful escaping. The model outputs:

```json
{"name": "write_file", "args": {"content": "Simple calculator module.\n\ndef add..."}}
```

Note: the docstring `"""Simple calculator module."""` becomes `"Simple calculator module."` — the triple quotes are lost because the model can't nest `"""` inside a JSON string. The resulting file is syntactically invalid Python (bare `Simple calculator module.` on line 1 instead of a docstring).

**This is not a reasoning failure — it's a serialization failure.** The model has the correct fix in its "mind" but can't express it through the JSON wire format. A structured edit tool (like `edit_file` with line number + replacement, or a patch format) would bypass this limitation entirely.

### New optimization vector identified: structured edits

The current `write_file` tool requires the model to serialize the **entire file content** as a JSON string. This is:
1. Token-expensive (small models waste context reproducing unchanged code)
2. Error-prone (triple quotes, backslashes, unicode in JSON strings)
3. Why small models rewrite everything (easier to write a new file than reproduce the old one with one change)

A better tool for small models:

```json
{"name": "edit_line", "args": {"path": "calc.py", "line": 19, "old": "    return a // b", "new": "    return a / b"}}
```

This would:
- Eliminate the JSON serialization problem (no full file content in a string)
- Force minimal diffs by construction (the tool only changes specified lines)
- Reduce token usage (model outputs 2 lines instead of 26)
- Make the programmatic minimizer unnecessary for line-level edits

**This is potentially the unlock for sub-10B models.** The capability exists (gemma4 identified the bug). The bottleneck is expression through the tool interface.

### Updated scoreboard (all runs)

| Model | Size | Fix ID'd | Surgical | Protocol | Native TC | JSON Serial | Outcome |
|---|---|---|---|---|---|---|---|
| gemma3 | 3.3GB | Yes | N/A | Improved (uses nav tools) | No (400) | N/A | FAILED — won't commit |
| gemma4 | 7.2GB | Yes | N/A | Good (transition tool, ran tests correctly) | Yes | **FAILS** (triple quotes) | FAILED — serialization |
| gpt-oss | 13.8GB | Yes | **1/26** | Good (native) | Yes | OK | PARTIAL (testing nav) |
| llama3.3 | 42.5GB | Yes | **1/26** | Strong | N/A (uses raw) | OK | **SUCCESS** |

### The emerging pattern

Each model size has a different bottleneck, and the state machine framework can adapt to each:

| Size range | Bottleneck | Framework adaptation |
|---|---|---|
| <5B | Task confidence — identifies bugs but won't commit to writing | Need: auto-suggest mode where model confirms a proposed fix rather than writing from scratch |
| 5-10B | JSON serialization — can't express file content correctly in JSON strings | Need: `edit_line` tool that takes line-level patches instead of full content |
| 10-30B | State navigation — writes correct fixes but can't navigate branching transitions | Need: `safe_next` on linear states, auto-run-test on testing entry |
| 30B+ | None structural — follows protocol, writes surgical fixes | Framework works as-is |

**This is the thesis refined:** the framework doesn't just constrain models — it adapts its interface to compensate for size-specific failure modes. The state machine is the constant. The tool interface is the variable. The combination makes small models viable for structured tasks they'd otherwise fail at.

## Appendix: Key Code Artifacts

- Engine crate: `crates/engine/src/` — 35 tests (guards, transitions, validation, safe_next)
- Agent crate: `crates/agent/src/` — 41 tests (validator, tool enforcer, generator, executor)
- Operator crate: `crates/operator/src/` — 15 tests (CRDs, persistence, NATS, reconciler)
- Demo: `crates/demo/src/main.rs` — dual-mode execution loop with all guardrails
- Fixture: `crates/demo/fixtures/buggy-calc/` — auto-restoring test target
- Previous experiment: `.claude/artifacts/001-self-guardrailing-experiment.md`
