#!/bin/bash
# DeepSWE Mixture-of-Models runner: retry-first, then cross-architecture escalation.
#
# Strategy:
#   1. Run qwen3:8b up to MAX_RETRIES times (fresh clone each attempt)
#   2. If all retries fail, escalate to gemma4:12b (cross-architecture)
#   3. Report per-task and aggregate results
#
# Usage:
#   ./deepswe-mom.sh <tasks_dir> [max_retries]
#
# Example:
#   ./deepswe-mom.sh /tmp/deep-swe/tasks/psd-tools-blend-range-api 3

set -euo pipefail

TASK_DIR="${1:?Usage: deepswe-mom.sh <task_dir> [max_retries]}"
MAX_RETRIES="${2:-3}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_SCRIPT="$SCRIPT_DIR/deepswe-run.sh"

BASE_URL="https://qwen2-5-coder-14b.ollama.casa.enhasa.cloud/v1"
BASE_MODEL="qwen3:8b"
ESCALATION_MODEL="gemma4:12b"
STEPS=50
WORKFLOW="tdd-greenfield"

TASK_NAME=$(basename "$TASK_DIR")

echo "=== MoM: $TASK_NAME ==="
echo "Strategy: ${BASE_MODEL} x${MAX_RETRIES}, then ${ESCALATION_MODEL}"
echo ""

# Try base model up to MAX_RETRIES times
for attempt in $(seq 1 "$MAX_RETRIES"); do
  echo "--- Attempt $attempt/$MAX_RETRIES: $BASE_MODEL ---"
  "$RUN_SCRIPT" "$TASK_DIR" "$BASE_URL" "$BASE_MODEL" "$STEPS" "$WORKFLOW" 2>&1 | \
    grep -E "COMPLETED|ABORT|file\(s\)|Escalation"

  # Check if completed
  latest=$(ls -t $TASK_DIR/results/*/harness.log 2>/dev/null | head -1)
  if [ -n "$latest" ] && grep -q "=== COMPLETED" "$latest" 2>/dev/null; then
    echo ""
    echo "=== SOLVED by $BASE_MODEL (attempt $attempt) ==="
    exit 0
  fi
  echo ""
done

# All retries exhausted — escalate to cross-architecture model
echo "--- Escalation: $ESCALATION_MODEL ---"
"$RUN_SCRIPT" "$TASK_DIR" "$BASE_URL" "$ESCALATION_MODEL" "$STEPS" "$WORKFLOW" 2>&1 | \
  grep -E "COMPLETED|ABORT|file\(s\)|Escalation"

latest=$(ls -t "$TASK_DIR/results/*/harness.log" 2>/dev/null | head -1)
if [ -n "$latest" ] && grep -q "=== COMPLETED" "$latest" 2>/dev/null; then
  echo ""
  echo "=== SOLVED by $ESCALATION_MODEL (after $MAX_RETRIES $BASE_MODEL failures) ==="
  exit 0
fi

echo ""
echo "=== UNSOLVED after $MAX_RETRIES retries + escalation ==="
exit 1
