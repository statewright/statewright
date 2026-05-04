# Experiment 003: The edit_line Breakthrough — 9B Model Writes Surgical Fixes

**Date:** 2026-04-23  
**Key result:** gemma4:e2b (7.2GB, ~9B params) successfully fixed a bug with a 1-line change using content-matching `edit_line`  
**Previous barrier:** All sub-20B models failed the programmatic minimizer by rewriting entire files  

---

## What Changed

Two optimizations landed simultaneously:

### 1. Auto-test on state entry

When the state machine enters `testing`, the framework automatically runs the test suite instead of asking the model to call `run_test`. If tests pass, it auto-transitions through the approval gate to `completed`. If tests fail, it bounces back to `implementing` with the test output in conversation history.

**Why this matters:** Every model we tested struggled with the testing state — either trying to use `DONE` instead of `TESTS_PASS`/`TESTS_FAIL`, or trying to write files instead of running tests. The testing state's purpose is mechanical (run tests, check results), not creative. Making it programmatic eliminates an entire class of navigation failures.

**Pattern:** If a state's purpose can be fully expressed as "run X, branch on result" — make it programmatic. Save LLM calls for states that require judgment.

### 2. Content-matching edit_line tool

Replaced line-number-based `edit_line` with content-matching:

```json
// Old (line-number based — models can't count blank lines):
{"name": "edit_line", "args": {"path": "calc.py", "line": 19, "old": "    return a // b", "new": "    return a / b"}}

// New (content matching — model says what to find, tool finds it):
{"name": "edit_line", "args": {"path": "calc.py", "old": "    return a // b", "new": "    return a / b"}}
```

The tool searches the file for the `old` content, validates the match, and replaces it. Line number is optional (for disambiguation when multiple lines match). If no match, the error message shows partial matches to help the model correct.

**Why this matters:** The previous experiment showed gemma4 had the right fix (`return a // b` → `return a / b`) on the right tool (`edit_line`) but the wrong line number (14 instead of 19). The file has blank lines between functions that small models can't count. Content matching eliminates this precision requirement entirely.

**The insight:** Small models fail at `write_file` because they can't reproduce a full file as a JSON string. They fail at line-numbered `edit_line` because they can't count blank lines. Content-matching `edit_line` asks the model only for what it actually knows: the old code and the new code. Everything else is the tool's job.

---

## Results

### gemma4:e2b — SUCCESS (7.2GB, ~9B parameters)

**Tool mode:** raw JSON  
**Steps to completion:** 17  
**Lines changed:** 1/26  
**Minimizer:** PASSED  

```
Step 1   planning      list_directory               — survey the workspace
Step 2   planning      read_file(test_calc.py)      — read test expectations
Step 3   planning      read_file(calc.py)           — read source code
Step 4   planning      patch_file → PARSE FAIL      — tried complex tool, JSON malformed
Step 5   planning      transition(DONE)              — checkpoint → implementing
Step 6   implementing  transition(DONE) [no fix]    — skipped writing, went to testing
Step 7   testing       AUTO-TEST: FAIL              — caught missing fix, back to implementing
Step 8   implementing  patch_file → PARSE FAIL      — tried again, same JSON issue
Step 9   implementing  transition(DONE)              — still no fix
Step 10  testing       AUTO-TEST: FAIL              — caught again
Step 11  implementing  patch_file → PARSE FAIL      — third attempt at complex tool
Step 12  implementing  transition(DONE)              — gave up on patch_file
Step 13  testing       AUTO-TEST: FAIL              — caught again
Step 14  implementing  read_file(calc.py)           — re-read source
Step 15  implementing  edit_line(old: "return a // b", new: "return a / b") → L19 CHANGED
Step 16  implementing  transition(DONE) → DIFF: 1/26 lines → MINIMIZER PASSED
Step 17  testing       AUTO-TEST: ALL PASSED → APPROVED → completed
```

**The learning trajectory (steps 4-15):**

This is the most interesting part. The model tried `patch_file` three times and failed each time due to JSON serialization of nested arrays. The auto-test caught the missing fix three times and bounced it back. On the fourth cycle, the model switched to `edit_line` — the simpler tool — and it worked immediately.

The state machine didn't tell the model to use `edit_line`. The model discovered it was the right tool through trial and error within the guardrails. The framework's contribution:
- Tool enforcement prevented premature file writes during planning (step 4: patch_file blocked)
- Auto-test caught every attempt to advance without a fix (steps 7, 10, 13)
- The implementing→testing→implementing loop gave the model multiple attempts
- `safe_next` kept it moving forward even when transition names were wrong
- Content-matching `edit_line` eliminated the line-number accuracy requirement

**A 9B model, through 4 cycles of failing and retrying within guardrails, self-corrected from a complex tool it couldn't use (patch_file) to a simpler tool it could (edit_line), and produced a 1-line surgical fix.**

### gpt-oss:20b — SUCCESS (13.8GB, ~20B parameters)

**Tool mode:** native  
**Steps to completion:** 10  
**Lines changed:** 1/26  

```
Step 1   planning      read_file(test_calc.py)
Step 2   planning      run_test()
Step 3   planning      read_file(calc.py)
Step 4   planning      write_file → BLOCKED
Step 5   planning      transition(PLAN_READY)
Step 6   implementing  get_available_actions()
Step 7   implementing  write_file → 1 line changed
Step 8   implementing  run_test → BLOCKED
Step 9   CHECKPOINT    transition(DONE) → MINIMIZER PASSED
Step 10  testing       AUTO-TEST: ALL PASSED → APPROVED → completed
```

**Observation:** gpt-oss used `write_file` successfully (1 line change) without needing `edit_line`. At 20B with native tool calling, it has enough precision to reproduce the file correctly. The auto-test eliminated the testing navigation problem from the previous experiment.

### llama3.3 — REGRESSION (native mode)

**Tool mode:** auto (selected native)  
**Lines changed:** 21/26 → MINIMIZER REJECTED ×2 → FAILED  

```
Step 6   implementing  write_file → 21/26 lines changed → REJECTED
Step 7   implementing  transition(DONE) → testing  
...cycling...
Step 12  implementing  write_file → 23/26 lines changed → REJECTED
Step 13  CHECKPOINT    transition(FAIL)
```

**Root cause:** Native tool calling mode causes llama3.3 to rewrite the entire file. The same model with raw JSON mode (previous experiment) wrote a 1-line fix. The native function calling pathway changes how the model generates file content.

**Fix identified but not applied:** Force raw JSON mode for llama3.3, or add `edit_line` to its implementing toolset. The regression is tool-mode-specific, not model-specific.

---

## The Capability Cliff Has Moved

### Before edit_line + auto-test

```
Surgical fix threshold: somewhere between 9B and 20B
  <9B:  can identify bug, can't write minimal fix
  20B+: can write minimal fix
```

### After edit_line + auto-test

```
Surgical fix threshold: ~9B
  <5B:  can identify bug, won't commit to writing (gemma3: FAIL)
  9B:   can identify bug, can write minimal fix via edit_line (gemma4: SUCCESS)
  20B+: can write minimal fix via write_file OR edit_line (gpt-oss: SUCCESS)
```

The floor dropped by roughly 2x in parameter count. A 9B model achieves what previously required 20B+. The difference is entirely in the tool interface — the model's reasoning capability didn't change.

---

## Architecture Pattern: Tool Complexity as a Capability Adapter

The experiment revealed a hierarchy of tool complexity that maps to model capability:

| Tool | Complexity | What model needs to know | Minimum viable model |
|---|---|---|---|
| `edit_line` (content match) | Low | Old text, new text | ~9B |
| `patch_file` (content match) | Medium | Multiple old/new pairs | ~15B (JSON array serialization) |
| `write_file` (full content) | High | Entire file as JSON string | ~20B (native) or ~70B (raw JSON) |

**The framework can select the right tool complexity for the model:**

- Small models (≤10B): offer only `edit_line`. Hide `write_file` and `patch_file`.
- Medium models (10-30B): offer `edit_line` + `patch_file`. Hide `write_file`.
- Large models (30B+): offer all three. They'll pick what's appropriate.

This is the per-model capability profile concept from the roadmap — implemented through tool availability per model tier, not through prompt changes.

---

## What the Auto-Test Pattern Proves

The auto-test isn't just a convenience — it's a fundamental architecture insight. Some state machine states are:

**Creative states:** The model needs to reason, decide, generate. These are LLM calls.
- planning: read files, identify bugs, form hypotheses
- implementing: write fixes, choose the right tool

**Mechanical states:** The outcome is deterministic given the current state. These should be programmatic.
- testing: run tests, branch on pass/fail
- minimizing: check diff size, branch on threshold

**Human states:** The decision requires judgment beyond the model. These park and wait.
- review: human inspects changes, approves or rejects

The state machine's value increases when each state type uses the right executor: LLM for creative, programmatic for mechanical, human for judgment. Mixing these (asking the LLM to run tests, asking the human to review test output) wastes capability.

---

## Updated Full Scoreboard

| Model | Size | Tool mode | Key tool | Lines | Minimizer | Auto-test | Steps | Outcome |
|---|---|---|---|---|---|---|---|---|
| gemma3 | 3.3GB | raw | N/A | N/A | N/A | N/A | 7 | FAILED — won't commit |
| **gemma4:e2b** | **7.2GB** | **raw** | **edit_line** | **1/26** | **PASSED** | **ALL PASSED** | **17** | **SUCCESS** |
| **gpt-oss** | **13.8GB** | **native** | **write_file** | **1/26** | **PASSED** | **ALL PASSED** | **10** | **SUCCESS** |
| llama3.3 | 42.5GB | native | write_file | 21/26 | REJECTED | FAIL (no fix) | 13 | FAILED (mode regression) |
| llama3.3 | 42.5GB | raw | write_file | 1/26 | PASSED | N/A (prev) | 10 | SUCCESS (prev experiment) |

### The story in one line

A 9B model on a 12GB GPU, constrained by a state machine with content-matching `edit_line` and programmatic auto-test, writes a 1-line surgical bug fix that passes all tests. The same task requires a 70B model without these guardrails.

---

## Next Steps

1. **Per-model tool profiles** — auto-select tool complexity based on model size
2. **Fix llama3.3 native regression** — force raw JSON or add edit_line to its toolset
3. **Rerun gemma3** — with edit_line and auto-test, the 4B model might cross the threshold
4. **Multi-file bug** — test beyond single-file fixes
5. **LLM-generated state machines** — have the model design its own constraints
6. **Benchmark suite** — systematic evaluation across models and tasks
