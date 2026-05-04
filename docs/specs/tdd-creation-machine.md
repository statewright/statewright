# Statewright — TDD Software Creation State Machine

## The Insight

Current frontier models create software by brute force: generate the whole thing, run it, debug until it works. This requires holding an entire application in context, reasoning about all interactions simultaneously, and debugging emergent failures across components.

A TDD state machine decomposes "build software" into a cycle of tiny verified steps:
1. Write ONE test for ONE behavior
2. Write the MINIMAL code to pass it
3. Verify programmatically
4. Repeat

Each step is small enough for a 9B model. The state machine sequences them, verifies each one, and tracks progress through a requirements checklist. The model never holds more than one test + one implementation in active context. The test suite IS the memory.

The frontier model's advantage (massive context, parallel reasoning about entire systems) becomes irrelevant. Both the 9B and the 1T model produce the same outcome: a working application with test coverage. But the 9B model's output is incrementally verified at every step. The 1T model's output is verified once at the end — and if it fails, the debugging spiral begins.

---

## The State Machine

```
analyzing → designing → spec_testing
                              ↓
                     ┌→ writing_test (RED)
                     │       ↓
                     │  running_red_test ←──── test passes? (write harder test)
                     │       ↓ (test fails — good)
                     │  implementing (GREEN)
                     │       ↓
                     │  running_green_test ←── still failing? (keep implementing)
                     │       ↓ (all pass)
                     │  refactoring
                     │       ↓
                     │  running_refactor_test ← broke something? (undo)
                     │       ↓ (all pass)
                     └─ checking_coverage ────→ more requirements? (loop back)
                              ↓ (all covered)
                     integration_testing
                              ↓
                         review (human)
                              ↓
                         completed
```

### State Definitions

```json
{
  "id": "tdd-create",
  "initial": "analyzing",
  "states": {
    "analyzing": {
      "allowed_tools": ["read_file", "list_directory", "grep"],
      "instructions": "Read the requirements. List what needs to be built. Create a numbered checklist of behaviors to implement, ordered from simplest to most complex.",
      "max_iterations": 5,
      "on": { "ANALYZED": "designing", "FAIL": "failed" }
    },

    "designing": {
      "allowed_tools": ["read_file", "write_file", "list_directory"],
      "instructions": "Create the project structure. Write stub files with function signatures, types, and docstrings — NO implementation. Write a requirements.md checklist. The stubs define the public API.",
      "max_iterations": 5,
      "on": { "DESIGNED": "spec_testing", "FAIL": "failed" }
    },

    "spec_testing": {
      "PROGRAMMATIC": true,
      "action": "Verify stubs exist and are syntactically valid. Check that requirements.md exists with a numbered checklist.",
      "on": { "STUBS_VALID": "writing_test", "STUBS_INVALID": "designing" }
    },

    "writing_test": {
      "allowed_tools": ["read_file", "write_file", "edit_line", "grep"],
      "instructions": "Write ONE test for the NEXT uncovered requirement from the checklist. The test MUST fail — it tests behavior that doesn't exist yet. Import from the stubs. Use the simplest assertion that captures the requirement.",
      "max_iterations": 3,
      "safe_next": "running_red_test",
      "on": { "TEST_WRITTEN": "running_red_test", "DONE": "running_red_test", "FAIL": "failed" }
    },

    "running_red_test": {
      "PROGRAMMATIC": true,
      "action": "Run the test suite. The new test MUST fail (RED). If all tests pass, the test doesn't test new behavior — go back to writing_test.",
      "on": {
        "TESTS_FAIL": "implementing",
        "TESTS_PASS": "writing_test"
      }
    },

    "implementing": {
      "allowed_tools": ["read_file", "edit_line", "patch_file", "write_file", "grep"],
      "instructions": "Write the MINIMAL code to make the failing test pass. Do NOT add functionality beyond what the test requires. Do NOT handle edge cases that aren't tested. The goal is GREEN, not PERFECT.",
      "max_iterations": 5,
      "safe_next": "running_green_test",
      "on": { "IMPLEMENTED": "running_green_test", "DONE": "running_green_test", "FAIL": "failed" }
    },

    "running_green_test": {
      "PROGRAMMATIC": true,
      "action": "Run the full test suite. ALL tests must pass (GREEN). If any fail, go back to implementing.",
      "on": {
        "ALL_PASS": "refactoring",
        "SOME_FAIL": "implementing"
      }
    },

    "refactoring": {
      "allowed_tools": ["read_file", "edit_line", "patch_file", "grep"],
      "instructions": "Improve code quality WITHOUT changing behavior. Remove duplication, improve naming, simplify logic. All tests must still pass. If nothing needs refactoring, skip.",
      "max_iterations": 3,
      "on": {
        "REFACTORED": "running_refactor_test",
        "SKIP_REFACTOR": "checking_coverage",
        "DONE": "checking_coverage",
        "FAIL": "failed"
      }
    },

    "running_refactor_test": {
      "PROGRAMMATIC": true,
      "action": "Run full test suite. If all pass, refactoring was clean. If any fail, refactoring broke something — restore and skip.",
      "on": {
        "ALL_PASS": "checking_coverage",
        "SOME_FAIL": "refactoring"
      }
    },

    "checking_coverage": {
      "PROGRAMMATIC": true,
      "action": "Parse requirements.md checklist. Compare against existing test names. If uncovered requirements remain, go back to writing_test. If all covered, proceed to integration.",
      "on": {
        "MORE_REQUIREMENTS": "writing_test",
        "ALL_COVERED": "integration_testing"
      }
    },

    "integration_testing": {
      "PROGRAMMATIC": true,
      "action": "Run the full test suite one final time. All tests must pass.",
      "on": {
        "ALL_PASS": "review",
        "SOME_FAIL": "implementing"
      }
    },

    "review": {
      "on": { "APPROVED": "completed", "REJECTED": "writing_test" }
    },

    "completed": { "type": "final" },
    "failed": { "type": "final" }
  }
}
```

---

## Why Each Cycle is Small-Model-Compatible

The RED/GREEN/REFACTOR cycle at its core is:

**RED:** "Here are the existing function stubs. Write a test that calls `create_todo()` and asserts it returns a todo with an id."
→ A 9B model can write a 5-line pytest test.

**GREEN:** "This test fails: `assert result.id is not None`. The function `create_todo()` currently returns `None`. Make it pass."
→ A 9B model can change `return None` to `return Todo(id=uuid4())`. This is `edit_line`.

**REFACTOR:** "All tests pass. The code has two functions that both construct a Todo. Extract a helper."
→ A 9B model can do a simple extraction with `edit_line`.

None of these require holding the entire application in context. Each is a small, focused change with a clear success criterion.

---

## What the Programmatic States Do

Six of the twelve states are programmatic — zero LLM calls:

| State | Action | Why programmatic |
|---|---|---|
| spec_testing | Check stubs exist, syntax valid | File existence + `python -c "import module"` |
| running_red_test | Run pytest, check new test fails | `pytest` exit code + failure parsing |
| running_green_test | Run pytest, check all pass | `pytest` exit code |
| running_refactor_test | Run pytest, verify no regression | `pytest` exit code |
| checking_coverage | Parse requirements vs test names | String matching |
| integration_testing | Final pytest run | `pytest` exit code |

**6 programmatic states, 6 creative states.** Half the execution is mechanical and deterministic. The LLM is only called when reasoning is needed — writing tests, writing implementation, refactoring.

---

## The Requirements Checklist as the Driver

The `analyzing` state produces a numbered checklist:

```markdown
# Requirements: Todo API

1. [ ] GET /todos returns empty list when no todos exist
2. [ ] POST /todos creates a new todo and returns it with an id
3. [ ] GET /todos returns all created todos
4. [ ] GET /todos/:id returns a single todo
5. [ ] GET /todos/:id returns 404 for unknown id
6. [ ] PUT /todos/:id updates a todo
7. [ ] DELETE /todos/:id removes a todo
8. [ ] POST /todos validates required fields (title)
9. [ ] Todos persist across requests (in-memory store)
```

The `checking_coverage` state:
1. Reads `requirements.md`
2. Reads test file names and test function names
3. Checks items off: `test_list_todos_empty` covers requirement 1, `test_create_todo` covers requirement 2, etc.
4. Returns `MORE_REQUIREMENTS` with the next uncovered item, or `ALL_COVERED`

The model sees: "Next requirement: #4 — GET /todos/:id returns a single todo. Write a test for this."

The checklist turns an open-ended task ("build an API") into a sequence of closed-ended tasks ("write test for this specific behavior"). Each closed-ended task is within a small model's capability.

---

## How This Beats Frontier Brute Force

### Frontier approach (1T+ model, no state machine):
```
Step 1: Generate entire application (500 lines)
Step 2: Run → 12 errors
Step 3: Fix error 1 → introduces error 13
Step 4: Fix error 13 → breaks error 2's fix
Step 5-47: Debugging spiral
Step 48: Maybe works. No tests. Untested edge cases. Fragile.
```

**Cost:** 48 inference calls × $0.03/call = $1.44  
**Quality:** Works but untested, full of implicit assumptions  
**Time:** ~10 minutes of inference  

### Statewright TDD approach (9-31B model, state machine):
```
Cycle 1: test_empty_list → implement GET /todos → pass ✓
Cycle 2: test_create → implement POST /todos → pass ✓
Cycle 3: test_list_with_items → verify integration → pass ✓
...
Cycle 9: test_validation → implement validation → pass ✓
Integration: 9/9 tests pass ✓
```

**Cost:** 9 cycles × ~5 LLM calls × $0 (local) = $0  
**Quality:** 9 tests, each verified, incremental, minimal diffs  
**Time:** ~5 minutes of inference (model is smaller, but cycles are parallel-safe)  

### The critical difference

The frontier model's failure mode is **emergent complexity**: 500 lines of interdependent code where changing line 47 breaks line 312. The debugging spiral is the model fighting its own generated complexity.

The TDD state machine's invariant: **at every step, all existing tests pass.** New behavior is added one test at a time. If a new implementation breaks an old test, the model knows exactly what changed (the minimal diff from this GREEN phase) and what broke (the specific old test that failed). Debugging is constrained to the interaction between the new change and the old behavior — not a 500-line mystery.

---

## The running_red_test Gate

This state is the most counterintuitive and most important guardrail. It verifies that the new test FAILS before allowing implementation. Why?

**Without RED verification:**
- Model writes a test that already passes (tests the stub's default behavior)
- Model "implements" something that was already working
- The cycle produces no new functionality
- Coverage appears to advance but actually stalls

**With RED verification:**
- Test must fail → proves it tests genuinely new behavior
- Implementation must make exactly this test pass → proves the implementation does exactly what was needed
- No phantom progress, no false coverage

This is the TDD discipline that even experienced developers skip. The state machine enforces it mechanically.

---

## Context Management: The Test Suite as Memory

The key problem in large software creation: the model loses track of what it built.

The TDD state machine solves this structurally:
- The model doesn't need to remember the architecture — the stubs define it
- The model doesn't need to remember edge cases — the tests encode them
- The model doesn't need to remember what works — the test suite verifies it
- The model only needs to hold: current test + current implementation + test output

Each cycle starts with: "Here's your test file (what's expected), here's your implementation file (what exists), here's the next requirement (what to add)." This is bounded context, regardless of how large the application grows.

A 9B model on cycle 20 has the same cognitive load as on cycle 1. A frontier model on iteration 20 of brute-force generation is drowning in context.

---

## Relationship to Existing Work

### vs. Test-Driven Agents (e.g., SWE-agent with test writing)

SWE-agent can write tests, but it writes them as part of a flat agent loop. There's no structural enforcement of RED→GREEN→REFACTOR ordering. The model might write a test, implement, write another test, implement both at once, or skip testing entirely. The loop is advisory, not enforced.

Statewright's TDD machine makes the cycle structural. You cannot implement without a failing test. You cannot advance without all tests passing. The model is constrained to the TDD discipline even if it would "prefer" to skip steps.

### vs. Agentless (localize → patch)

Agentless operates on existing code (bug fixes). The TDD machine operates on new code (creation). Different problem, complementary approaches. The same Statewright framework supports both — the state machine definition determines which pattern.

### vs. Cursor/Copilot inline completion

Inline completion generates code at the cursor. The TDD machine generates code at the *requirement level*. It decides what to build next based on uncovered requirements, not based on cursor position. The scope is a feature, not a line.

### vs. Devin / OpenHands full-project agents

Full-project agents attempt to build everything at once with a single planning step. The TDD machine builds incrementally with verified steps. The planning overhead is lower (one requirement at a time) and the verification is continuous (tests after every change).

---

## Estimated Impact on Model Requirements

| Task | Without TDD machine | With TDD machine |
|---|---|---|
| Build a 200-line CLI tool | 70B+ (brute force, debugging) | 20B (incremental, verified) |
| Build a REST API with 5 endpoints | 70B+ (integration complexity) | 9B (one endpoint per cycle) |
| Build a library with 10 functions | 30B+ (interface consistency) | 9B (one function per cycle, stubs enforce interface) |
| Build a full-stack app | Frontier only | 31B (frontend/backend can be separate cycles) |

The reduction isn't guaranteed — complex architectural decisions still benefit from larger models. But the mechanical parts (writing individual tests, implementing individual functions, running verification) are brought within small model range.

---

## Implementation Plan

### Phase 1: Hardcoded TDD machine for a specific task type

Pick: "Build a Python CLI calculator with basic operations."
- Requirements: add, subtract, multiply, divide, input parsing, error handling
- 6-8 TDD cycles
- Verify gemma4:e2b (9B) can build it cycle-by-cycle

### Phase 2: Requirements-driven TDD machine

- Model generates requirements checklist in analyzing state
- checking_coverage state programmatically tracks progress
- Test on: "Build a REST API for bookmarks" (medium complexity)

### Phase 3: gen_sm for TDD

- The pipeline generates a TDD-specific state machine per task
- Number of cycles, tool selection, max_iterations per state — all task-dependent
- "Build a web scraper" gets different TDD cycles than "Build a game engine"

### Phase 4: Multi-file TDD

- extend the cycle to handle multiple source files
- The designing state creates a module structure
- Each cycle may touch one or more files
- Integration testing verifies cross-module behavior
