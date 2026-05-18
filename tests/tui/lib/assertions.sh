#!/usr/bin/env bash
# Assertion helpers for screen + database verification

PASS_COUNT=0
FAIL_COUNT=0
TOTAL_COUNT=0

assert_screen() {
  local name="$1" pattern="$2" label="$3"
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  if agent_view "$name" | grep -q "$pattern"; then
    echo "  PASS: $label"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $label (expected: $pattern)"
    echo "  Screen:"
    agent_view "$name" | tail -5 | sed 's/^/    /'
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# Poll-based assertion: check screen every interval until pattern appears or timeout
# Adapts to model speed — fast models pass instantly, slow models get patience
assert_screen_wait() {
  local name="$1" pattern="$2" label="$3" timeout="${4:-120}" interval="${5:-5}"
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if agent_view "$name" | grep -q "$pattern"; then
      echo "  PASS: $label (${elapsed}s)"
      PASS_COUNT=$((PASS_COUNT + 1))
      return 0
    fi
    sleep $interval
    elapsed=$((elapsed + interval))
  done
  echo "  FAIL: $label (expected: $pattern, timeout: ${timeout}s)"
  echo "  Screen:"
  agent_view "$name" | tail -8 | sed 's/^/    /'
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

assert_screen_not() {
  local name="$1" pattern="$2" label="$3"
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  if ! agent_view "$name" | grep -q "$pattern"; then
    echo "  PASS: $label"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $label (should NOT contain: $pattern)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# --- Database assertions (PocketBase) ---

pb_query() {
  local collection="$1" filter="$2"
  curl -sf --max-time 5 \
    "${STAGING_PB}/api/collections/${collection}/records?filter=${filter}" \
    -H "Authorization: Bearer $STAGING_KEY" 2>/dev/null
}

assert_run_exists() {
  local run_id="$1" label="$2"
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  local result
  result=$(pb_query "workflow_runs" "id='${run_id}'")
  if echo "$result" | jq -r '.items[0].id // empty' 2>/dev/null | grep -q "$run_id"; then
    echo "  PASS: $label"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $label (run_id $run_id not in DB)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

assert_run_status() {
  local run_id="$1" expected_status="$2" label="$3"
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  local result
  result=$(pb_query "workflow_runs" "id='${run_id}'")
  local actual
  actual=$(echo "$result" | jq -r '.items[0].status // empty' 2>/dev/null)
  if [ "$actual" = "$expected_status" ]; then
    echo "  PASS: $label"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $label (expected: $expected_status, got: $actual)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

assert_run_has_transitions() {
  local run_id="$1" min_count="$2" label="$3"
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  local result
  result=$(pb_query "workflow_runs" "id='${run_id}'")
  local count
  count=$(echo "$result" | jq -r '.items[0].transition_count // 0' 2>/dev/null)
  if [ "$count" -ge "$min_count" ] 2>/dev/null; then
    echo "  PASS: $label ($count transitions)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $label (expected >= $min_count transitions, got $count)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

assert_logs_exist() {
  local run_id="$1" min_count="$2" label="$3"
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  local result
  result=$(pb_query "workflow_logs" "run='${run_id}'&perPage=1&skipTotal=0")
  local total
  total=$(echo "$result" | jq -r '.totalItems // 0' 2>/dev/null)
  if [ "$total" -ge "$min_count" ] 2>/dev/null; then
    echo "  PASS: $label ($total logs)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $label (expected >= $min_count logs, got $total)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

assert_transition_event() {
  local run_id="$1" event_name="$2" label="$3"
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  local result
  result=$(pb_query "workflow_runs" "id='${run_id}'")
  local transitions
  transitions=$(echo "$result" | jq -r '.items[0].transitions // "[]"' 2>/dev/null)
  if echo "$transitions" | grep -q "$event_name"; then
    echo "  PASS: $label"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: $label (event '$event_name' not in transitions)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

report() {
  echo ""
  echo "=== Results: $PASS_COUNT passed, $FAIL_COUNT failed, $TOTAL_COUNT total ==="
  if [ "$FAIL_COUNT" -gt 0 ]; then
    return 1
  fi
  return 0
}
