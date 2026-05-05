#!/usr/bin/env bash
# Stdio MCP proxy — forwards JSON-RPC to statewright gateway with auth from disk
# Used as `type: "command"` MCP server in plugin .mcp.json
# No OAuth, no static auth headers — reads key dynamically from ~/.statewright/api_key

GW_URL="${STATEWRIGHT_GATEWAY_URL:-https://mcp.statewright.ai}"
KEY_FILE="${HOME}/.statewright/api_key"

# Read each line from stdin (JSON-RPC messages)
while IFS= read -r line; do
  [ -z "$line" ] && continue

  # Read API key fresh each time (supports key rotation mid-session)
  API_KEY=$(cat "$KEY_FILE" 2>/dev/null || true)

  if [ -z "$API_KEY" ]; then
    # No key — return error for any method except initialize
    METHOD=$(echo "$line" | jq -r '.method // empty' 2>/dev/null)
    ID=$(echo "$line" | jq -r '.id // null' 2>/dev/null)

    if [ "$METHOD" = "initialize" ]; then
      echo '{"jsonrpc":"2.0","result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"statewright","version":"0.1.0"}},"id":'"$ID"'}'
    elif [ "$METHOD" = "tools/list" ]; then
      echo '{"jsonrpc":"2.0","result":{"tools":[{"name":"statewright_start","description":"Activate a statewright workflow for this session. Tools will be restricted per state.","inputSchema":{"type":"object","properties":{"workflow":{"type":"string","description":"Workflow name (e.g. bugfix, etl-pipeline, code-review)"}},"required":["workflow"]}},{"name":"statewright_stop","description":"Deactivate the current workflow. All tools become available again.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_get_state","description":"Get the current workflow state, allowed tools, and available transitions.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_transition","description":"Transition to the next state in the workflow.","inputSchema":{"type":"object","properties":{"event":{"type":"string","description":"Transition event name (e.g. READY, DONE, PASS, FAIL)"}},"required":["event"]}},{"name":"statewright_list_workflows","description":"List all available workflows for this user.","inputSchema":{"type":"object","properties":{}}}]},"id":'"$ID"'}'
    elif [ "$METHOD" = "notifications/initialized" ]; then
      : # notification, no response
    else
      echo '{"jsonrpc":"2.0","error":{"code":-1,"message":"Statewright API key not configured. Visit https://statewright.ai/keys to generate one."},"id":'"$ID"'}'
    fi
    continue
  fi

  # Forward to gateway with auth
  RESPONSE=$(curl -sf --max-time 10 -X POST "$GW_URL/" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $API_KEY" \
    -d "$line" 2>/dev/null)

  if [ -n "$RESPONSE" ]; then
    echo "$RESPONSE"
  else
    ID=$(echo "$line" | jq -r '.id // null' 2>/dev/null)
    echo '{"jsonrpc":"2.0","error":{"code":-2,"message":"Gateway unreachable"},"id":'"$ID"'}'
  fi
done
