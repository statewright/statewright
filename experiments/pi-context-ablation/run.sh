#!/usr/bin/env bash
# Pi Context Ablation Experiment
# Tests gemma4:31b on SWE-bench fixtures under three conditions:
#   A: No statewright workflow (raw Pi, full accumulation, no window)
#   B: Flat workflow (all tools, no phase constraints, window active)
#   C: Bugfix workflow (phase constraints + window)
#
# Usage: ./run.sh [A|B|C|all|summary]

set -euo pipefail

FIXTURES_DIR="/Users/ben/dev/statewright/crates/cli/fixtures"
RESULTS_DIR="/Users/ben/dev/statewright/experiments/pi-context-ablation/results"
MODEL="ollama/gemma4:31b"
TIMEOUT=${TIMEOUT:-1200}

# Staging gateway
export STATEWRIGHT_GATEWAY_URL="https://statewright-mcp.casa.enhasa.cloud"
export STATEWRIGHT_API_KEY="sw_live_56662ab8feb1e019c77de0b89744af0f"
export STATEWRIGHT_PB_URL="https://statewright.casa.enhasa.cloud"

# Fixtures with failing tests (skip kvstore — no tests)
FIXTURES=(buggy-calc sympy-20590 sympy-21847 sympy-22914 requests-1963 pytest-5262)

PROMPT="Fix the failing test(s) in this project. Read the test file to understand what's expected, identify the bug, fix it, and verify all tests pass by running pytest. Do not modify the test files."

mkdir -p "$RESULTS_DIR"

run_task() {
  local fixture=$1
  local condition=$2
  local fixture_dir="$FIXTURES_DIR/$fixture"
  local work_dir=$(mktemp -d "/tmp/pi-ablation-${fixture}-${condition}-XXXXXX")
  local result_file="$RESULTS_DIR/${condition}_${fixture}.json"
  local log_file="$RESULTS_DIR/${condition}_${fixture}.log"

  # Fresh copy of fixture
  cp -r "$fixture_dir"/* "$work_dir/"
  cd "$work_dir"
  git init -q 2>/dev/null && git add -A 2>/dev/null && git commit -q -m "initial" 2>/dev/null || true

  local start_ts=$(date +%s)

  # Build Pi command
  local -a pi_cmd=(pi --model "$MODEL" -p "$PROMPT")

  # Condition-specific env
  case $condition in
    A)
      # No workflow — raw Pi, statewright extension loads but no workflow = no window
      unset STATEWRIGHT_WORKFLOW 2>/dev/null || true
      ;;
    B)
      # Flat workflow — all tools, no constraints, but window activates
      export STATEWRIGHT_WORKFLOW="flat-ablation"
      ;;
    C)
      # Bugfix workflow — phase constraints + window
      export STATEWRIGHT_WORKFLOW="${STATEWRIGHT_C_WORKFLOW:-bugfix-v2}"
      ;;
  esac

  # Run — audit trace extension writes JSONL directly to disk (bypasses Node buffering)
  local stderr_file="$RESULTS_DIR/${condition}_${fixture}.stderr"
  local trace_file="$RESULTS_DIR/${condition}_${fixture}.trace.jsonl"
  local session_id="${condition}_${fixture}_$(date +%s)"
  export AUDIT_TRACE_DIR="$RESULTS_DIR"
  export PI_SESSION_ID="$session_id"
  echo "[$condition] $fixture: starting... (trace: $trace_file)"
  timeout "$TIMEOUT" "${pi_cmd[@]}" > "$log_file" 2>"$stderr_file" || true
  # Rename audit trace to expected path
  mv "$RESULTS_DIR/pi-audit-${session_id}.jsonl" "$trace_file" 2>/dev/null || true
  local end_ts=$(date +%s)
  local duration=$((end_ts - start_ts))

  # Check test results
  cd "$work_dir"
  local test_output
  test_output=$(python3 -m pytest --tb=no -q 2>&1) || true
  local passed=$(echo "$test_output" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo "0")
  local failed=$(echo "$test_output" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo "0")
  local success="false"
  [ "${failed:-1}" = "0" ] && [ "${passed:-0}" -gt "0" ] && success="true"

  # Count tool invocations from audit trace
  local tool_calls=0
  if [ -f "$trace_file" ]; then
    tool_calls=$(grep -c '"event":"tool_call"' "$trace_file" 2>/dev/null || echo "0")
  fi

  # Check for git diff (did it actually edit something?)
  local files_changed=$(cd "$work_dir" && git diff --name-only 2>/dev/null | wc -l | tr -d ' ')

  cat > "$result_file" <<EOF
{
  "fixture": "$fixture",
  "condition": "$condition",
  "model": "gemma4:31b",
  "success": $success,
  "tests_passed": $passed,
  "tests_failed": $failed,
  "tool_calls": $tool_calls,
  "files_changed": $files_changed,
  "duration_seconds": $duration,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

  local status="FAIL"
  $success && status="PASS"
  echo "[$condition] $fixture: $status (passed=$passed failed=$failed calls=$tool_calls time=${duration}s)"

  rm -rf "$work_dir"
}

run_condition() {
  local condition=$1
  local concurrency=${2:-3}
  echo ""
  echo "════════════════════════════════════"
  echo "  CONDITION $condition (concurrency=$concurrency)"
  echo "════════════════════════════════════"
  echo ""

  local pids=()
  local running=0

  for fixture in "${FIXTURES[@]}"; do
    run_task "$fixture" "$condition" &
    pids+=($!)
    running=$((running + 1))

    # Throttle to $concurrency parallel
    if [ $running -ge $concurrency ]; then
      wait "${pids[0]}" 2>/dev/null || true
      pids=("${pids[@]:1}")
      running=$((running - 1))
    fi
  done

  # Wait for remaining
  for pid in "${pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}

summarize() {
  echo ""
  echo "════════════════════════════════════"
  echo "  RESULTS SUMMARY"
  echo "════════════════════════════════════"
  echo ""
  printf "%-12s %-18s %-8s %-8s %-8s\n" "Condition" "Fixture" "Result" "Calls" "Time"
  printf "%-12s %-18s %-8s %-8s %-8s\n" "---------" "-------" "------" "-----" "----"
  for f in "$RESULTS_DIR"/*.json; do
    [ -f "$f" ] || continue
    python3 -c "
import json
with open('$f') as fh:
    d = json.load(fh)
r = 'PASS' if d['success'] else 'FAIL'
print(f'{d[\"condition\"]:<12} {d[\"fixture\"]:<18} {r:<8} {d[\"tool_calls\"]:<8} {d[\"duration_seconds\"]}s')
" 2>/dev/null
  done

  echo ""
  echo "Aggregate:"
  printf "%-12s %-15s\n" "Condition" "Success Rate"
  printf "%-12s %-15s\n" "---------" "------------"
  for cond in A B C; do
    total=0
    ok=0
    for f in "$RESULTS_DIR"/${cond}_*.json; do
      [ -f "$f" ] || continue
      total=$((total + 1))
      s=$(python3 -c "import json; print(json.load(open('$f'))['success'])" 2>/dev/null)
      [ "$s" = "true" ] && ok=$((ok + 1))
    done
    [ $total -gt 0 ] && printf "%-12s %d/%d\n" "$cond" "$ok" "$total"
  done
}

CONCURRENCY="${2:-3}"  # default 3 parallel, override with second arg

case "${1:-all}" in
  A|B|C) run_condition "$1" "$CONCURRENCY"; summarize ;;
  all)   run_condition A "$CONCURRENCY"; run_condition B "$CONCURRENCY"; run_condition C "$CONCURRENCY"; summarize ;;
  AC)    run_condition A "$CONCURRENCY"; run_condition C "$CONCURRENCY"; summarize ;;
  summary) summarize ;;
  *) echo "Usage: $0 [A|B|C|AC|all|summary] [concurrency=3]"; exit 1 ;;
esac
