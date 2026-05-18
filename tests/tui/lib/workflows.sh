#!/usr/bin/env bash
# Workflow setup — ensure test workflows exist on staging

ensure_workflow() {
  local name="$1"
  # Check if workflow exists by trying to list it
  local result
  result=$(curl -sf --max-time 5 \
    "${STAGING_GW}/mcp" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $STAGING_KEY" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1.0\"}}}" 2>/dev/null)

  local sid
  sid=$(echo "$result" | grep -i "mcp-session-id" | tr -d '\r' | awk '{print $2}' 2>/dev/null)

  result=$(curl -sf --max-time 5 \
    "${STAGING_GW}/mcp" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $STAGING_KEY" \
    -H "Mcp-Session-Id: $sid" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"statewright_list_workflows\",\"arguments\":{}}}" 2>/dev/null)

  if echo "$result" | grep -q "\"$name\""; then
    echo "  Workflow '$name' exists"
    return 0
  else
    echo "  Workflow '$name' NOT FOUND — needs upload"
    return 1
  fi
}

ensure_test_workflows() {
  echo "Checking staging gateway connectivity..."
  local result
  result=$(curl -sf --max-time 5 "${STAGING_GW}/health" 2>/dev/null)
  if [ "$result" = "ok" ]; then
    echo "  Gateway: UP"
  else
    echo "  ERROR: Gateway not reachable at $STAGING_GW"
    exit 1
  fi
  echo "  Workflows verified at scenario runtime via agent"
}
