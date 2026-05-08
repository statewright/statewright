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

  # Claude Code built-in tools + statewright MCP tools (can't self-scan)
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
    {"name":"NotebookEdit","source":"Claude Code","category":"Notebook"},
    {"name":"statewright_start","source":"MCP:statewright","category":"MCP","description":"Activate a workflow for this session"},
    {"name":"statewright_stop","source":"MCP:statewright","category":"MCP","description":"Deactivate the current workflow"},
    {"name":"statewright_transition","source":"MCP:statewright","category":"MCP","description":"Transition to the next state"},
    {"name":"statewright_get_state","source":"MCP:statewright","category":"MCP","description":"Get current state, allowed tools, and transitions"},
    {"name":"statewright_list_workflows","source":"MCP:statewright","category":"MCP","description":"List available workflows"}
  ]')

  # Scan configured MCP servers for additional tools
  # Collect all MCP config files: user global + plugin caches
  local mcp_configs="$MCP_CONFIG"
  for pconf in "$HOME/.claude/plugins/cache"/*/*/*/.mcp.json; do
    [ -f "$pconf" ] && mcp_configs="$mcp_configs $pconf"
  done

  local seen_servers=""
  for conf_file in $mcp_configs; do
    [ -f "$conf_file" ] || continue
    for server in $(jq -r '.mcpServers // {} | keys[]' "$conf_file" 2>/dev/null); do
      [ "$server" = "statewright" ] && continue
      # Skip duplicates across config files
      case " $seen_servers " in *" $server "*) continue ;; esac
      seen_servers="$seen_servers $server"
      local server_url=$(jq -r ".mcpServers[\"$server\"].url // empty" "$conf_file" 2>/dev/null)
      local server_cmd=$(jq -r ".mcpServers[\"$server\"].command // empty" "$conf_file" 2>/dev/null)
      local server_tools=""

      if [ -n "$server_url" ]; then
        # HTTP MCP server — single POST
        local auth_header=$(jq -r ".mcpServers[\"$server\"].headers.Authorization // empty" "$conf_file" 2>/dev/null)
        local extra_headers=""
        [ -n "$auth_header" ] && extra_headers="-H \"Authorization: $auth_header\""

        server_tools=$(eval curl -sf --max-time 5 -X POST "\"$server_url\"" \
          -H "'Content-Type: application/json'" \
          $extra_headers \
          -d "'{"jsonrpc":"2.0","method":"tools/list","params":{},"id":99}'" 2>/dev/null \
          | jq "[.result.tools[]? | {name: .name, source: \"MCP:$server\", category: \"MCP\", description: .description}]" 2>/dev/null)

      elif [ -n "$server_cmd" ]; then
        # Stdio MCP server — launch, handshake, query, kill
        local server_args=$(jq -r ".mcpServers[\"$server\"].args // [] | join(\" \")" "$conf_file" 2>/dev/null)
        local server_env=$(jq -r ".mcpServers[\"$server\"].env // {} | to_entries | map(\"export \" + .key + \"=\" + (.value | @sh) + \";\") | join(\" \")" "$conf_file" 2>/dev/null)

        server_tools=$(timeout 15 bash -c "
          ${server_env}
          { echo '{\"jsonrpc\":\"2.0\",\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"statewright-scanner\",\"version\":\"0.1\"}},\"id\":1}'; \
            sleep 0.5; \
            echo '{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}'; \
            echo '{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"params\":{},\"id\":2}'; \
            sleep 2; \
          } | $server_cmd $server_args 2>/dev/null
        " 2>/dev/null | perl -0777 -pe 's/[\x00-\x09\x0b-\x0c\x0e-\x1f]//g' \
          | jq -s '[.[] | select(.id == 2) | .result.tools[]? | {name: .name, source: "MCP:'"$server"'", category: "MCP", description: (.description // "")[:120]}]' 2>/dev/null)
      fi

      if [ -n "$server_tools" ] && [ "$server_tools" != "null" ] && [ "$server_tools" != "[]" ]; then
        tools=$(echo "$tools" | jq ". + $server_tools")
      fi
    done
  done

  # Upload to PB directly (hook accepts API key auth)
  curl -sf --max-time 10 -X POST "$PB_URL/api/client-tools" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $key" \
    -d "{\"tools\": $tools}" >/dev/null 2>&1
}

# --- Main proxy loop ---
while IFS= read -r line; do
  [ -z "$line" ] && continue

  API_KEY="${STATEWRIGHT_API_KEY:-$(cat "$KEY_FILE" 2>/dev/null || true)}"

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
