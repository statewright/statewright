#!/usr/bin/env bash
# Stdio MCP proxy — forwards JSON-RPC to statewright gateway with auth from disk
# Used as `type: "command"` MCP server in plugin .mcp.json
# No OAuth, no static auth headers — reads key dynamically from ~/.statewright/api_key

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATEWRIGHT_DIR="${HOME}/.statewright"
GW_URL="${STATEWRIGHT_GATEWAY_URL:-}"
[ -n "$GW_URL" ] || GW_URL=$(cat "$STATEWRIGHT_DIR/gateway_url" 2>/dev/null || true)
GW_URL="${GW_URL:-https://mcp.statewright.ai}"
PB_URL="${STATEWRIGHT_PB_URL:-https://statewright.ai}"
KEY_FILE="$STATEWRIGHT_DIR/api_key"
# shellcheck source=client-id.sh
source "${SCRIPT_DIR}/client-id.sh"

# A managed client owns this loopback bridge across CLI child restarts. Use it
# before deriving a standalone identity or opening direct gateway traffic.
if [ -n "${STATEWRIGHT_MANAGED_MCP_URL:-}" ]; then
  managed_session_id="${STATEWRIGHT_MANAGED_MCP_SESSION_ID:-}"
  managed_tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/statewright-claude-mcp.XXXXXX")
  trap 'rm -rf "$managed_tmpdir"' EXIT
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    method=$(printf '%s' "$line" | jq -r '.method // empty' 2>/dev/null)
    request_headers=(
      -H 'Content-Type: application/json'
      -H "Authorization: Bearer ${STATEWRIGHT_MANAGED_MCP_TOKEN:-}"
    )
    [ -n "$managed_session_id" ] && request_headers+=(-H "Mcp-Session-Id: ${managed_session_id}")
    response_headers="$managed_tmpdir/headers"
    response_body="$managed_tmpdir/body"
    if curl -sS --max-time 15 -D "$response_headers" -o "$response_body" -X POST "${STATEWRIGHT_MANAGED_MCP_URL%/}/mcp" \
      "${request_headers[@]}" --data-binary "$line" 2>/dev/null; then
      response=$(cat "$response_body")
      response_session_id=$(awk 'BEGIN { IGNORECASE=1 } /^Mcp-Session-Id:/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/[\r\n]/, ""); print; exit }' "$response_headers")
      [ -n "$response_session_id" ] && managed_session_id="$response_session_id"
    else
      response=""
    fi
    case "$method" in notifications/*) continue ;; esac
    if [ -n "$response" ]; then
      printf '%s\n' "$response"
    else
      id=$(printf '%s' "$line" | jq -c '.id // null' 2>/dev/null || echo null)
      printf '{"jsonrpc":"2.0","error":{"code":-32603,"message":"Statewright managed MCP bridge unavailable."},"id":%s}\n' "$id"
    fi
  done
  exit 0
fi

if [ -n "${STATEWRIGHT_ADAPTER_URL:-}" ]; then
  exec bash "${SCRIPT_DIR}/../executor/mcp-proxy.sh"
fi

CLIENT_ID=$(statewright_client_id)
SESSION_HEADER_ARGS=(-H "X-Statewright-Client-Id: ${CLIENT_ID}")
if [ -n "${STATEWRIGHT_MCP_SESSION_ID:-}" ]; then
  SESSION_HEADER_ARGS+=(-H "Mcp-Session-Id: ${STATEWRIGHT_MCP_SESSION_ID}")
fi

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
        " 2>/dev/null | LC_ALL=C perl -0777 -pe 's/[\x00-\x09\x0b-\x0c\x0e-\x1f]//g' \
          | jq -s '[.[] | select(.id == 2) | .result.tools[]? | {name: .name, source: "MCP:'"$server"'", category: "MCP", description: (.description // "")[:120]}]' 2>/dev/null)
      fi

      if [ -n "$server_tools" ] && [ "$server_tools" != "null" ] && [ "$server_tools" != "[]" ]; then
        tools=$(echo "$tools" | jq ". + $server_tools")
      fi
    done
  done

  # Discover Taskfile/Makefile commands, namespaced by directory basename
  local commands='[]'
  local project_name=$(basename "$(pwd)")
  if command -v task &>/dev/null && { [ -f "Taskfile.yml" ] || [ -f "Taskfile.yaml" ] || [ -f "taskfile.yml" ]; }; then
    local task_cmds=$(task --list-all 2>/dev/null | grep '^\*' | awk '{print $2}' | sed 's/:$//' | head -30)
    if [ -n "$task_cmds" ]; then
      commands=$(echo "$task_cmds" | jq -R '.' | jq -s --arg proj "$project_name" '[.[] | {name: ., source: "Taskfile", category: "task", project: $proj}]')
    fi
  fi
  if [ -f "Makefile" ] || [ -f "makefile" ]; then
    local make_cmds=$(make -pRrq 2>/dev/null | awk -F: '/^[a-zA-Z0-9][^$#\/\t=]*:([^=]|$)/ {split($1,a," ");print a[1]}' | sort -u | grep -v '^\.' | head -30)
    if [ -n "$make_cmds" ]; then
      local make_json=$(echo "$make_cmds" | jq -R '.' | jq -s --arg proj "$project_name" '[.[] | {name: ., source: "Makefile", category: "make", project: $proj}]')
      commands=$(echo "$commands" | jq ". + $make_json")
    fi
  fi

  # Upload tools + commands to PB
  curl -sf --max-time 10 -X POST "$PB_URL/api/client-tools" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $key" \
    -d "{\"tools\": $tools, \"commands\": $commands}" >/dev/null 2>&1
}

# --- Main proxy loop ---
while IFS= read -r line; do
  [ -z "$line" ] && continue

  API_KEY="${STATEWRIGHT_API_KEY:-$(cat "$KEY_FILE" 2>/dev/null || true)}"
  API_KEY="${API_KEY%"${API_KEY##*[![:space:]]}"}"  # trim trailing whitespace/newlines

  if [ -z "$API_KEY" ]; then
    METHOD=$(echo "$line" | jq -r '.method // empty' 2>/dev/null)
    ID=$(echo "$line" | jq -r '.id // null' 2>/dev/null)

    if [ "$METHOD" = "initialize" ]; then
      echo '{"jsonrpc":"2.0","result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"statewright","version":"0.1.0"}},"id":'"$ID"'}'
    elif [ "$METHOD" = "tools/list" ]; then
      echo '{"jsonrpc":"2.0","result":{"tools":[{"name":"statewright_start","description":"Activate a statewright workflow for this session. Tools will be restricted per state.","inputSchema":{"type":"object","properties":{"workflow":{"type":"string","description":"Workflow name (e.g. bugfix, etl-pipeline, code-review)"}},"required":["workflow"]}},{"name":"statewright_stop","description":"Deactivate the current workflow. All tools become available again.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_get_state","description":"Get the current workflow state, allowed tools, and available transitions.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_transition","description":"Transition to the next state in the workflow.","inputSchema":{"type":"object","properties":{"event":{"type":"string","description":"Transition event name (e.g. READY, DONE, PASS, FAIL)"}},"required":["event"]}},{"name":"statewright_list_workflows","description":"List all available workflows for this user.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_search_docs","description":"Search statewright documentation for workflow schema fields, MCP tools, patterns, and troubleshooting.","inputSchema":{"type":"object","properties":{"query":{"type":"string","description":"Search query (e.g. guard operators, allowed_tools, approval gate)"}},"required":["query"]}},{"name":"statewright_pause","description":"Pause the current workflow. State and context are saved. Resume later with statewright_load_workflow(name, resume=true).","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_get_status","description":"Get gateway status: active workflow, current state, available workflows.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_force_state","description":"Force the state machine to a specific state, bypassing guards and transitions. Only works when meta.debug is true in the workflow.","inputSchema":{"type":"object","properties":{"state":{"type":"string","description":"Target state name to jump to"},"context":{"type":"object","description":"Optional context to merge (e.g. set guard fields)"}},"required":["state"]}}]},"id":'"$ID"'}'
    elif [ "$METHOD" = "notifications/initialized" ]; then
      : # notification, no response
    else
      echo '{"jsonrpc":"2.0","error":{"code":-1,"message":"Statewright API key not configured. Visit https://statewright.ai/keys to generate one."},"id":'"$ID"'}'
    fi
    continue
  fi

  METHOD=$(echo "$line" | jq -r '.method // empty' 2>/dev/null)

  # Notifications: no response needed, trigger side effects
  if [ "$METHOD" = "notifications/initialized" ]; then
    if [ -n "$API_KEY" ]; then
      (upload_client_tools "$API_KEY" &)
    fi
    continue
  fi

  # Handle statewright_search_docs locally (no gateway round-trip)
  TOOL_NAME=$(echo "$line" | jq -r '.params.name // empty' 2>/dev/null)
  if [ "$METHOD" = "tools/call" ] && [ "$TOOL_NAME" = "statewright_search_docs" ]; then
    ID=$(echo "$line" | jq -r '.id // null' 2>/dev/null)
    QUERY=$(echo "$line" | jq -r '.params.arguments.query // empty' 2>/dev/null)
    if [ -z "$QUERY" ]; then
      echo '{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Missing required parameter: query"}]},"id":'"$ID"'}'
    else
      # Fetch search index and do keyword matching
      INDEX=$(curl -sf --max-time 5 "https://docs.statewright.ai/search-index.json" 2>/dev/null)
      if [ -n "$INDEX" ]; then
        RESULTS=$(echo "$INDEX" | jq --arg q "$QUERY" '
          ($q | ascii_downcase | split(" ")) as $terms |
          [.[] | . as $chunk |
            ($chunk.title | ascii_downcase) as $t |
            ($chunk.section | ascii_downcase) as $s |
            ($chunk.content | ascii_downcase) as $c |
            ([$terms[] | select(($t | contains(.)) or ($s | contains(.)))] | length) as $title_hits |
            ([$terms[] | select($c | contains(.))] | length) as $content_hits |
            select(($title_hits + $content_hits) > 0) |
            {url, title, section, content: $chunk.content, score: (($title_hits * 3) + $content_hits)}
          ] | sort_by(-.score) | unique_by(.url + .section) | .[0:5] |
          [.[] | {url, title, section, snippet: .content[0:500]}]
        ' 2>/dev/null)
        # Always include the full schema if query mentions schema/definition/create
        if echo "$QUERY" | grep -qiE 'schema|definition|create workflow'; then
          SCHEMA_CHUNK=$(echo "$INDEX" | jq -c '[.[] | select(.title == "Workflow JSON Schema")] | .[0] // empty' 2>/dev/null)
          if [ -n "$SCHEMA_CHUNK" ] && [ "$SCHEMA_CHUNK" != "null" ]; then
            SCHEMA_ENTRY=$(echo "$SCHEMA_CHUNK" | jq -c '{url, title, section, snippet: .content}')
            RESULTS=$(echo "$RESULTS" | jq --argjson s "$SCHEMA_ENTRY" '. | if any(.title == "Workflow JSON Schema") then . else [$s] + .[0:4] end')
          fi
        fi
        if [ -n "$RESULTS" ] && [ "$RESULTS" != "[]" ]; then
          RESULT_TEXT=$(echo "$RESULTS" | jq -r '.[] | "## \(.title) > \(.section)\nURL: https://statewright.ai\(.url)\n\(.snippet)\n"' 2>/dev/null)
          RESULT_JSON=$(jq -cn --arg text "$RESULT_TEXT" '{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":$text}]},"id":'"$ID"'}')
          echo "$RESULT_JSON"
        else
          echo '{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"No results found for: '"$QUERY"'"}]},"id":'"$ID"'}'
        fi
      else
        echo '{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Search index unavailable"}]},"id":'"$ID"'}'
      fi
    fi
    continue
  fi

  # Forward to gateway with auth
  RESPONSE=$(curl -sf --max-time 10 -X POST "$GW_URL/" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $API_KEY" \
    "${SESSION_HEADER_ARGS[@]}" \
    -d "$line" 2>/dev/null)

  if [ -n "$RESPONSE" ]; then
    # Inject local tools into tools/list responses from gateway
    if [ "$METHOD" = "tools/list" ]; then
      SEARCH_TOOL='{"name":"statewright_search_docs","description":"Search statewright documentation for workflow schema fields, MCP tools, patterns, and troubleshooting. Returns relevant doc snippets.","inputSchema":{"type":"object","properties":{"query":{"type":"string","description":"Search query (e.g. guard operators, allowed_tools, approval gate)"}},"required":["query"]}}'
      PAUSE_TOOL='{"name":"statewright_pause","description":"Pause the current workflow. State and context are saved. Resume later with statewright_load_workflow(name, resume=true).","inputSchema":{"type":"object","properties":{}}}'
      FORCE_TOOL='{"name":"statewright_force_state","description":"Force the state machine to a specific state, bypassing guards and transitions. Only works when meta.debug is true.","inputSchema":{"type":"object","properties":{"state":{"type":"string","description":"Target state name to jump to"},"context":{"type":"object","description":"Optional context to merge (e.g. set guard fields)"}},"required":["state"]}}'
      RESPONSE=$(echo "$RESPONSE" | jq -c --argjson s "$SEARCH_TOOL" --argjson p "$PAUSE_TOOL" --argjson f "$FORCE_TOOL" '.result.tools = ([.result.tools[] | select(.name != "statewright_search_docs" and .name != "statewright_pause" and .name != "statewright_force_state")] + [$s, $p, $f])' 2>/dev/null || echo "$RESPONSE")
    fi
    echo "$RESPONSE"
  else
    ID=$(echo "$line" | jq -r '.id // null' 2>/dev/null)
    echo '{"jsonrpc":"2.0","error":{"code":-2,"message":"Gateway unreachable"},"id":'"$ID"'}'
  fi

done
