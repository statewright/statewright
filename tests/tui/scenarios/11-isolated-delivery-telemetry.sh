#!/usr/bin/env bash
# Scenario 11: Real Codex adapter delivery lifecycle and staging token telemetry.

echo "=== Scenario 11: Isolated Delivery + Telemetry ==="

if [ "$AGENT" != "codex" ]; then
  echo "  SKIP: isolated delivery telemetry requires --agent codex"
  return 0
fi

NAME="sw-11-delivery"
WORKFLOW="isolated-delivery-smoke-v1"
RUN_ID="tui-e2e-$(date +%Y%m%d%H%M%S)"
DELIVERY_FIXTURE=$(setup_delivery_fixture)
DELIVERY_CONFIG="$DELIVERY_FIXTURE/.statewright/delivery.json"
WORKFLOW_FILE="$SCRIPT_DIR/fixtures/isolated-delivery-smoke-v1.json"
TELEMETRY_FILE="$DELIVERY_FIXTURE/adapter-telemetry.jsonl"
DELIVERY_CLI="$SCRIPT_DIR/../../plugins/codex/scripts/statewright-delivery.mjs"

cleanup_delivery_scenario() {
  node "$DELIVERY_CLI" discard \
    --delivery-config "$DELIVERY_CONFIG" \
    --run-id "$RUN_ID" >/dev/null 2>&1 || true
  teardown_delivery_fixture "$DELIVERY_FIXTURE"
}

REGISTERED=$(STATEWRIGHT_GATEWAY_URL="$STAGING_GW" \
  STATEWRIGHT_PB_URL="$STAGING_PB" \
  STATEWRIGHT_API_KEY="$STAGING_KEY" \
  STATEWRIGHT_NO_UPDATE_CHECK=1 \
  node "$SCRIPT_DIR/lib/register-workflow.mjs" \
  "$WORKFLOW" "$WORKFLOW_FILE" "$DELIVERY_FIXTURE" \
  2>"$DELIVERY_FIXTURE/workflow-registration.err")
assert_json "$REGISTERED" \
  '.ok == true and .statewright_servers == ["statewright_adapter"] and .meta.workspace.version == 1 and .meta.preview.version == 1' \
  "one launcher-owned MCP server round-tripped delivery policies"
if ! printf '%s' "$REGISTERED" | jq -e \
  '.ok == true and .statewright_servers == ["statewright_adapter"] and .meta.workspace.version == 1 and .meta.preview.version == 1' \
  >/dev/null 2>&1; then
  printf '%s\n' "$REGISTERED" | jq -c '{state, meta}' 2>/dev/null | sed 's/^/    /'
  sed 's/^/    /' "$DELIVERY_FIXTURE/workflow-registration.err"
  cleanup_delivery_scenario
  return 0
fi

spawn_statewright_codex "$NAME" \
  "Complete the exact smoke task in the active workflow. Keep working until it reaches a final state." \
  "$DELIVERY_FIXTURE" "$WORKFLOW" "$RUN_ID" "$DELIVERY_CONFIG" "$TELEMETRY_FILE" >/dev/null

assert_screen_wait "$NAME" "workflow complete in 'completed'" \
  "Codex adapter completed the isolated workflow" 360 5

MANIFEST="$DELIVERY_FIXTURE-runs/$RUN_ID/manifest.json"
WORKTREE=$(jq -r '.repositories[] | select(.primary) | .worktree_path' "$MANIFEST" 2>/dev/null)
EVIDENCE=$(jq -r '.evidence_path' "$MANIFEST" 2>/dev/null)
assert_file_exact "$DELIVERY_FIXTURE/RESULT.txt" "TODO" \
  "canonical checkout remained untouched"
assert_file_exact "$WORKTREE/RESULT.txt" "DELIVERED" \
  "isolated worktree contains the agent change"
assert_file_contains "$EVIDENCE/hook-actions.log" '^prepare$' \
  "trusted prepare hook ran"
assert_file_contains "$EVIDENCE/hook-actions.log" '^deploy$' \
  "trusted deploy hook ran"
assert_file_contains "$EVIDENCE/hook-actions.log" '^validate$' \
  "trusted validation hook ran"
assert_file_contains "$EVIDENCE/delivery-actions.jsonl" '"action":"validate"' \
  "delivery controller recorded validation evidence"

THREAD_ID=$(jq -r 'select(.event == "session_started") | .thread_id' \
  "$TELEMETRY_FILE" 2>/dev/null | tail -1)
RUN_RESPONSE=$(curl -sf --max-time 10 --get \
  "$STAGING_PB/api/collections/workflow_runs/records" \
  -H "Authorization: Bearer $STAGING_KEY" \
  --data-urlencode "filter=session_id='${THREAD_ID}'" \
  --data-urlencode 'sort=-created' \
  --data-urlencode 'perPage=1' 2>/dev/null)
PB_RUN_ID=$(printf '%s' "$RUN_RESPONSE" | jq -r '.items[0].id // empty')
assert_json "$RUN_RESPONSE" '.items[0].status == "completed"' \
  "workflow completion persisted to staging"

USAGE_RESPONSE=$(curl -sf --max-time 10 \
  "$STAGING_PB/api/gateway/runs/$PB_RUN_ID/usage" \
  -H "Authorization: Bearer $STAGING_KEY" 2>/dev/null)
assert_json "$USAGE_RESPONSE" \
  'any(.states[]?; .state.precision == "exact" and ((.state.token_usage.total_tokens // 0) > 0))' \
  "exact provider token totals persisted by state"
assert_json "$USAGE_RESPONSE" \
  'any(.states[]?; ((.tools // []) | length) > 0)' \
  "tool attribution persisted with state usage"

agent_stop "$NAME"
cleanup_delivery_scenario
