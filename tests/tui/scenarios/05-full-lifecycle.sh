#!/usr/bin/env bash
# Scenario 5: Full lifecycle — planning through validation gate
# This is the comprehensive test: load, transition through states, verify DB artifacts

echo "=== Scenario 5: Full Lifecycle ==="

NAME="sw-05-lifecycle"
SID=$(spawn_claude "$NAME" "load the statewright-dev-v2 workflow and work through it autonomously. The feature is: add a comment to src/main.rs. Work through planning, scoping, branching (create a test branch), implementing (edit the file), then trigger validation. Report each state transition." "$FIXTURE_DIR")

# Wait for the agent to get through multiple states
agent_wait "$NAME" "validation_gate\|VALIDATE\|fork\|FORK" 120

assert_screen "$NAME" "planning" "passed through planning"

# Extract run_id from screen if visible, or check DB
# The workflow name + recent timestamp should find the run
sleep 5

echo "  Checking database artifacts..."

# Query recent runs for statewright-dev-v2
RECENT_RUNS=$(curl -sf --max-time 5 \
  "${STAGING_PB}/api/collections/workflow_runs/records?filter=workflow_name='statewright-dev-v2'&sort=-created&perPage=1" \
  -H "Authorization: Bearer $STAGING_KEY" 2>/dev/null)

RUN_ID=$(echo "$RECENT_RUNS" | jq -r '.items[0].id // empty' 2>/dev/null)
if [ -n "$RUN_ID" ]; then
  assert_run_exists "$RUN_ID" "run record exists in DB"
  assert_run_has_transitions "$RUN_ID" 2 "at least 2 transitions recorded"
else
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "  FAIL: no run found in DB for statewright-dev-v2"
fi

agent_stop "$NAME"
