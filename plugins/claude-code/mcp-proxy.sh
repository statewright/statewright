#!/usr/bin/env bash
# Stdio MCP proxy — forwards JSON-RPC to statewright gateway with auth from disk
# Used as `type: "command"` MCP server in plugin .mcp.json
# No OAuth, no static auth headers — reads key dynamically from ~/.statewright/api_key

GW_URL="${STATEWRIGHT_GATEWAY_URL:-https://mcp.statewright.ai}"
PB_URL="${STATEWRIGHT_PB_URL:-https://statewright.ai}"
KEY_FILE="${HOME}/.statewright/api_key"

# --- Tool discovery (defined before main loop) ---
upload_client_tools() {
  local key="$1"
  local MCP_CONFIG="$HOME/.claude/.mcp.json"
  local tools

  # Claude Code built-in tools
  tools=$(jq -n '[
    {"name":"Read","source":"Claude Code","category":"File"},
    {"name":"Edit","source":"Claude Code","category":"File"},
    {"name":"Write","source":"Claude Code","category":"File"},
    {"name":"MultiEdit","source":"Claude Code","category":"File"},
    {"name":"Glob","source":"Claude Code","category":"File"},
    {"name":"Grep","source":"Claude Code","category":"File"},
    {"name":"LS","source":"Claude Code","category":"File"},
    {"name":"Bash","source":"Claude Code","category":"Execute"},
    {"name":"Agent","source":"Claude Code","category":"Execute"},
    {"name":"WebFetch","source":"Claude Code","category":"Web"},
    {"name":"WebSearch","source":"Claude Code","category":"Web"},
    {"name":"NotebookEdit","source":"Claude Code","category":"Notebook"}
  ]')

  # Scan configured MCP servers for additional tools
  if [ -f "$MCP_CONFIG" ]; then
    for server in $(jq -r '.mcpServers // {} | keys[]' "$MCP_CONFIG" 2>/dev/null); do
      [ "$server" = "statewright" ] && continue
      local server_url=$(jq -r ".mcpServers[\"$server\"].url // empty" "$MCP_CONFIG" 2>/dev/null)

      # Only scan HTTP MCP servers (can't easily query stdio servers)
      if [ -n "$server_url" ]; then
        local auth_header=$(jq -r ".mcpServers[\"$server\"].headers.Authorization // empty" "$MCP_CONFIG" 2>/dev/null)
        local extra_headers=""
        [ -n "$auth_header" ] && extra_headers="-H \"Authorization: $auth_header\""

        local server_tools=$(eval curl -sf --max-time 5 -X POST "\"$server_url\"" \
          -H "'Content-Type: application/json'" \
          $extra_headers \
          -d "'{"jsonrpc":"2.0","method":"tools/list","params":{},"id":99}'" 2>/dev/null \
          | jq "[.result.tools[]? | {name: .name, source: \"MCP:$server\", category: \"MCP\", description: .description}]" 2>/dev/null)

        if [ -n "$server_tools" ] && [ "$server_tools" != "null" ] && [ "$server_tools" != "[]" ]; then
          tools=$(echo "$tools" | jq ". + $server_tools")
        fi
      fi
    done
  fi

  # Upload to PB directly (hook accepts API key auth)
  curl -sf --max-time 10 -X POST "$PB_URL/api/client-tools" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $key" \
    -d "{\"tools\": $tools}" >/dev/null 2>&1
}

# --- Main proxy loop ---
while IFS= read -r line; do
  [ -z "$line" ] && continue

  API_KEY=$(cat "$KEY_FILE" 2>/dev/null || true)

  if [ -z "$API_KEY" ]; then
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

  # After notifications/initialized, scan and upload client tools (background)
  METHOD=$(echo "$line" | jq -r '.method // empty' 2>/dev/null)
  if [ "$METHOD" = "notifications/initialized" ] && [ -n "$API_KEY" ]; then
    (upload_client_tools "$API_KEY" &)
  fi
done
