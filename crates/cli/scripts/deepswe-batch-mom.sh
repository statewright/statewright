#!/bin/bash
# Batch runner for DeepSWE MoM strategy across multiple tasks.
# Runs tasks in parallel, each with retry-then-escalate logic.
#
# Usage:
#   ./deepswe-batch-mom.sh <task1> <task2> ... [-- max_retries]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOM_SCRIPT="$SCRIPT_DIR/deepswe-mom.sh"
TASKS_DIR="/tmp/deep-swe/tasks"
MAX_RETRIES=3
RESULTS_DIR="/tmp/deepswe-mom-results"
mkdir -p "$RESULTS_DIR"

TASKS=(
  psd-tools-blend-range-api
  adaptix-name-mapping-aliases
  anko-default-function-arguments
  termenv-preserve-ansi-resets
  true-myth-iterable-collection-combinators
  koota-deferred-mutation-buffer
  testem-bail-on-test-failure
  csstree-shorthand-expansion-compression
  oxvg-structural-selector-preservation
  pest-character-class-coalescing
)

echo "=== DeepSWE MoM Batch ==="
echo "Tasks: ${#TASKS[@]}"
echo "Strategy: qwen3:8b x${MAX_RETRIES}, then gemma4:12b"
echo "Results: $RESULTS_DIR"
echo ""

# Launch all tasks in parallel
for task in "${TASKS[@]}"; do
  (
    "$MOM_SCRIPT" "$TASKS_DIR/$task" "$MAX_RETRIES" > "$RESULTS_DIR/${task}.log" 2>&1
    echo $? > "$RESULTS_DIR/${task}.exit"
  ) &
done

echo "Launched ${#TASKS[@]} tasks. Waiting..."
wait

# Collect results
echo ""
echo "=== RESULTS ==="
echo ""
solved=0
solved_base=0
solved_esc=0
unsolved=0

for task in "${TASKS[@]}"; do
  logf="$RESULTS_DIR/${task}.log"
  exitf="$RESULTS_DIR/${task}.exit"
  lang=$(grep 'language = ' "$TASKS_DIR/$task/task.toml" 2>/dev/null | head -1 | sed 's/.*= "//' | sed 's/"//')

  if [ -f "$exitf" ] && [ "$(cat "$exitf")" = "0" ]; then
    solver=$(grep "=== SOLVED" "$logf" 2>/dev/null | head -1)
    if echo "$solver" | grep -q "gemma4"; then
      result="SOLVED (gemma4:12b)"
      solved=$((solved + 1))
      solved_esc=$((solved_esc + 1))
    else
      attempt=$(echo "$solver" | grep -oE "attempt [0-9]+" | grep -oE "[0-9]+")
      result="SOLVED (qwen3:8b, attempt $attempt)"
      solved=$((solved + 1))
      solved_base=$((solved_base + 1))
    fi
  else
    result="UNSOLVED"
    unsolved=$((unsolved + 1))
  fi

  printf "%-45s %4s  %s\n" "$task" "$lang" "$result"
done

echo ""
echo "--- Summary ---"
echo "Solved: $solved/${#TASKS[@]} ($((solved * 100 / ${#TASKS[@]}))%)"
echo "  by qwen3:8b: $solved_base"
echo "  by gemma4:12b: $solved_esc"
echo "Unsolved: $unsolved"
