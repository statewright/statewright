# Experiment 011: Capability Inflection Point

**Date:** 2026-04-26
**Models tested:** llama3.1:8b (4.9GB), mistral-nemo (7.1GB), gemma4:e2b (7.2GB), gemma3:12b (8GB), gpt-oss:20b (13.8GB)
**Key result:** The inflection point is between 8GB and 13.8GB. Below ~10GB, models produce valid tool calls and navigate the state machine, but can't retain enough context from file reads to produce accurate edits. Two new guardrail mechanisms (path resolver, line-number edit fallback) were discovered — they move small models from "can't read files" to "reads files, edits wrong content." Progress, but not enough to cross the threshold.

---

## The Gap

Prior experiments established: gemma4:e2b (7.2GB) scores 0/5, gpt-oss:20b (13.8GB) scores 5/5. A 6GB gap with no data. This experiment probes the gap with four models in the 5-8GB range.

## Results

| Model | Size | Statewright | Valid JSON? | Path Resolver Helps? | Core Failure |
|---|---|---|---|---|---|
| llama3.1:8b | 4.9GB | 0/5 | Yes | Partially | Hallucinates paths beyond basename, edits wrong files |
| gemma4:e2b | 7.2GB | 0/5 | No | N/A | Can't close JSON structures |
| mistral-nemo | 7.1GB | 0/5 | Yes | Yes | Correct location, wrong replacement content |
| gemma3:12b | 8GB | 0/5 | Mostly | Yes | Hallucinates file content in edit args |
| gpt-oss:20b | 13.8GB | 5/5 | Yes | N/A | No issues |

## Failure Mode Taxonomy by Model Size

### Tier 1: Can't produce tool calls (< 7GB)
**gemma4:e2b (7.2GB):** Valid JSON structure starts but can't maintain nested braces through complex tool arguments. Every edit attempt is a parse failure. The model understands the fix (truncated output shows correct old/new content) but can't serialize it.

### Tier 2: Valid calls, wrong targets (5-8GB)
**llama3.1:8b (4.9GB):** Produces valid JSON reliably. But hallucinates paths from training data (e.g. full repo paths like `sympy/sympy/printing.py`) that don't match any file even after basename resolution. Edits the reproduce script instead of the source file. The model can't distinguish "files I know from training" from "files in this directory."

### Tier 3: Valid calls, right targets, wrong content (7-8GB)
**mistral-nemo (7.1GB), gemma3:12b (8GB):** Both produce valid tool calls and (with path resolver) navigate to the correct files. Both read the files successfully. But when constructing edit arguments, they hallucinate content — inventing dict entries that don't exist, using wrong variable names, or producing edits that are semantically wrong. The model reads 640 lines, but by the time it generates the edit, it's lost the exact content.

### Tier 4: Reliable (13GB+)
**gpt-oss:20b (13.8GB):** Reads files, retains content accurately, produces correct edits. No path issues, no content hallucination.

## New Guardrail Mechanisms

### 13. Path Resolver

**Discovery:** gemma3:12b and llama3.1:8b both hallucinate repo-structure paths (`sympy/printing/pycode.py`) when the file is just `pycode.py` in the fixture directory. The localizer tells them the correct filenames, but training data overrides context.

**Fix:** Before any tool executes, `resolve_path()` checks if the requested path exists. If not, tries the basename in the workdir. `sympy/printing/pycode.py` resolves to `pycode.py`.

**Impact:** Unblocks the read phase for all models below 13GB. gemma3:12b went from "file not found" errors to successfully reading 640-line files. Doesn't fix the edit phase — the model still hallucinate content.

### 14. Line-Number Edit Fallback

**Discovery:** mistral-nemo uses `start_line`/`end_line`/`new_content` arguments for `edit_block` instead of `old`/`new`. This is a valid editing paradigm (line-number-based) that the content-matching tools don't support.

**Fix:** `edit_block` now accepts `start_line`/`end_line` as fallback when `old` is missing. Reads the file, replaces the specified line range with `new_content`.

**Impact:** Unblocks mistral-nemo's edit attempts entirely. The model went from "missing 'old' argument" errors to executing edits. The edits are wrong (content hallucination), but the tool no longer blocks the attempt.

## The Reasoning Threshold

The data reveals three distinct capability layers:

1. **Structured output** (~5GB+): Producing valid JSON with correct field names
2. **Context navigation** (~7GB+, with path resolver): Finding and reading the right files
3. **Context retention for editing** (~13GB+): Remembering what was read accurately enough to produce correct edits

Statewright's guardrails can push each threshold lower — path resolver extends navigation to 7GB models, line-number fallback extends tool compatibility to models with different calling conventions. But no structural intervention can fix a model that reads 640 lines and forgets the content by the time it generates the edit. That's a parameter count / context window limitation.

The practical minimum for SWE-bench tasks with statewright is **~13GB**. The path resolver and line-number fallback are still valuable — they improve robustness for models above the threshold too (fewer wasted steps on path errors).

---

## Infrastructure Changes

1. **`resolve_path()`** — basename fallback for hallucinated repo-structure paths
2. **`resolve_args_paths()`** — applies path resolution to `path` and `file` args before tool execution
3. **Line-number edit fallback** — `edit_block` accepts `start_line`/`end_line`/`new_content` when `old` is missing
4. **`new_content` alias** — `edit_block` accepts `new_content` as alias for `new`

Total guardrail count: 14 mechanisms, each discovered through failure analysis.
