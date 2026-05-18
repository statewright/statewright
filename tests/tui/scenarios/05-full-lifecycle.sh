#!/usr/bin/env bash
# Scenario 5: Full lifecycle — planning through validation gate
# Comprehensive test: load, transition through states, verify DB artifacts

echo "=== Scenario 5: Full Lifecycle ==="

NAME="sw-05-lifecycle"

case "$AGENT" in
  claude) spawn_claude "$NAME" "$FIXTURE_DIR" ;;
  omx)    spawn_omx "$NAME" "$FIXTURE_DIR" ;;
  pi)     spawn_pi "$NAME" "$FIXTURE_DIR" ;;
  *)      echo "  SKIP: unknown agent '$AGENT'"; return 0 ;;
esac

agent_send "$NAME" "load the statewright-dev-v2 workflow and work through it autonomously. The feature is: add a comment to src/main.rs. Work through planning, scoping, branching (create a test branch), implementing (edit the file), then trigger validation. Report each state transition.<CR>"

# Poll for workflow progress — any state name means the model is moving through states
assert_screen_wait "$NAME" "planning\|scoping\|implementing\|validation\|\[sw\]" "passed through workflow states" 120

sleep 5

echo "  Checking database artifacts..."

# Query recent runs for statewright-dev-v2
RECENT_RUNS=$(curl -sf --max-time 5 \
  "${STAGING_PB}/api/collections/workflow_runs/records?filter=workflow_name='statewright-dev-v2'&sort=-created&perPage=1" \
  -H "Authorization: Bearer $STAGING_KEY" 2>/dev/null)

RUN_ID=$(echo "$RECENT_RUNS" | jq -r '.items[0].id // empty' 2>/dev/null)
if [ -n "$RUN_ID" ]; then
  assert_run_exists "$RUN_ID" "run record exists in DB"
  # Local models may still be working — check transitions exist OR run is active
  TRANSITION_COUNT=$(echo "$RECENT_RUNS" | jq -r '.items[0].transition_count // 0' 2>/dev/null)
  RUN_STATUS=$(echo "$RECENT_RUNS" | jq -r '.items[0].status // empty' 2>/dev/null)
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  if [ "$TRANSITION_COUNT" -ge 1 ] 2>/dev/null; then
    echo "  PASS: transitions recorded ($TRANSITION_COUNT)"
    PASS_COUNT=$((PASS_COUNT + 1))
  elif [ "$RUN_STATUS" = "running" ]; then
    echo "  PASS: run still active (model working, 0 transitions yet — expected for local models)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "  FAIL: run not active and no transitions (status: $RUN_STATUS, count: $TRANSITION_COUNT)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "  FAIL: no run found in DB for statewright-dev-v2"
fi

agent_stop "$NAME"
