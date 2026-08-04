#!/usr/bin/env bash
# Stdio MCP proxy — forwards JSON-RPC to statewright gateway with auth from disk
# Used as `type: "command"` MCP server in plugin .mcp.json
# No OAuth, no static auth headers — reads key dynamically from ~/.statewright/api_key

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# A managed client owns this loopback bridge for the lifetime of the terminal
# session. The bridge keeps MCP identity stable while the supervisor replaces
# the Codex child at a routed model boundary.
if [ -n "${STATEWRIGHT_MANAGED_MCP_URL:-}" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    method=$(printf '%s' "$line" | jq -r '.method // empty' 2>/dev/null)
    response=$(curl -sf --max-time 15 -X POST "${STATEWRIGHT_MANAGED_MCP_URL%/}/mcp" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer ${STATEWRIGHT_MANAGED_MCP_TOKEN:-}" \
      --data-binary "$line" 2>/dev/null || true)
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

# Executor-owned runs keep the remote credential and workflow session in the
# host-neutral executor. Forward MCP before starting standalone telemetry or
# deriving an independent client identity.
if [ -n "${STATEWRIGHT_ADAPTER_URL:-}" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    method=$(printf '%s' "$line" | jq -r '.method // empty' 2>/dev/null)
    response=$(curl -sf --max-time 15 -X POST "${STATEWRIGHT_ADAPTER_URL%/}/mcp" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer ${STATEWRIGHT_ADAPTER_TOKEN:-}" \
      --data-binary "$line" 2>/dev/null || true)
    case "$method" in notifications/*) continue ;; esac
    if [ -n "$response" ]; then
      printf '%s\n' "$response"
    else
      id=$(printf '%s' "$line" | jq -c '.id // null' 2>/dev/null || echo null)
      printf '{"jsonrpc":"2.0","error":{"code":-32603,"message":"Statewright executor bridge unavailable."},"id":%s}\n' "$id"
    fi
  done
  exit 0
fi

GW_URL="${STATEWRIGHT_GATEWAY_URL:-https://mcp.statewright.ai}"
PB_URL="${STATEWRIGHT_PB_URL:-https://statewright.ai}"
KEY_FILE="${HOME}/.statewright/api_key"
REFERENCE_SEARCH="${SCRIPT_DIR}/reference-search.mjs"
TELEMETRY_AGENT="${SCRIPT_DIR}/scripts/local-telemetry-agent.mjs"
TELEMETRY_BOOTSTRAP="${SCRIPT_DIR}/scripts/bootstrap-native-token-telemetry.mjs"
TELEMETRY_DIR="${STATEWRIGHT_TELEMETRY_DIR:-${HOME}/.statewright/telemetry/native-codex}"
MANAGED_CLIENT_BOOTSTRAP="${SCRIPT_DIR}/../executor/statewright-managed-client.mjs"
# shellcheck source=client-id.sh
source "${SCRIPT_DIR}/client-id.sh"

# This is intentionally opt-in through Statewright configuration. Codex reads
# its OTel configuration at startup, so a newly created exporter applies after
# the next Codex restart. Existing user-owned [otel] configuration is untouched.
bootstrap_native_token_telemetry() {
  command -v node >/dev/null 2>&1 || return 0
  [ -f "$TELEMETRY_BOOTSTRAP" ] || return 0
  mkdir -p "$TELEMETRY_DIR"
  local result action
  result=$(node "$TELEMETRY_BOOTSTRAP" 2>/dev/null || true)
  action=$(printf '%s' "$result" | jq -r '.action // empty' 2>/dev/null || true)
  case "$action" in
    created)
      printf '%s\n' 'restart-required' > "$TELEMETRY_DIR/otel-restart-required"
      chmod 600 "$TELEMETRY_DIR/otel-restart-required"
      rm -f "$TELEMETRY_DIR/otel-config-conflict"
      ;;
    already_enabled|disabled)
      rm -f "$TELEMETRY_DIR/otel-restart-required" "$TELEMETRY_DIR/otel-config-conflict"
      ;;
    conflict)
      rm -f "$TELEMETRY_DIR/otel-restart-required"
      printf '%s\n' 'user-otel-config-conflict' > "$TELEMETRY_DIR/otel-config-conflict"
      chmod 600 "$TELEMETRY_DIR/otel-config-conflict"
      ;;
  esac
}

bootstrap_native_token_telemetry

# This prepares transparent shims for the next terminal launch. It is quiet,
# idempotent, and only touches a shell profile when a supported client exists.
if command -v node >/dev/null 2>&1 && [ -f "$MANAGED_CLIENT_BOOTSTRAP" ]; then
  node "$MANAGED_CLIENT_BOOTSTRAP" --bootstrap >/dev/null 2>&1 || true
fi

CLIENT_ID=$(statewright_client_id codex)
SESSION_HEADER_ARGS=(-H "X-Statewright-Client-Id: ${CLIENT_ID}")
if [ -n "${STATEWRIGHT_MCP_SESSION_ID:-}" ]; then
  SESSION_HEADER_ARGS+=(-H "Mcp-Session-Id: ${STATEWRIGHT_MCP_SESSION_ID}")
fi

telemetry_pid_matches() {
  local pid="$1" command
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  command=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$command" in *"$TELEMETRY_AGENT"*) return 0 ;; *) return 1 ;; esac
}

stop_managed_telemetry_agent() {
  local pid
  pid=$(cat "$TELEMETRY_DIR/agent.pid" 2>/dev/null || true)
  if telemetry_pid_matches "$pid"; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    telemetry_pid_matches "$pid" && return 1
  fi
  rm -f "$TELEMETRY_DIR/agent.pid"
}

acquire_telemetry_lock() {
  local lock_dir="$TELEMETRY_DIR/agent-start.lock" owner
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" > "$lock_dir/owner.pid"
    return 0
  fi
  owner=$(cat "$lock_dir/owner.pid" 2>/dev/null || true)
  case "$owner" in
    ''|*[!0-9]*) ;;
    *) kill -0 "$owner" 2>/dev/null && return 1 ;;
  esac
  rm -f "$lock_dir/owner.pid"
  rmdir "$lock_dir" 2>/dev/null || return 1
  mkdir "$lock_dir" 2>/dev/null || return 1
  printf '%s\n' "$$" > "$lock_dir/owner.pid"
}

release_telemetry_lock() {
  rm -f "$TELEMETRY_DIR/agent-start.lock/owner.pid"
  rmdir "$TELEMETRY_DIR/agent-start.lock" 2>/dev/null || true
}

health_matches_telemetry_identity() {
  local current="$1" expected="$2"
  [ -n "$current" ] && echo "$current" | jq -e --argjson expected "$expected" \
    '.protocol_version == $expected.protocol_version and
     .agent_build_id == $expected.agent_build_id and
     .config_identity == $expected.config_identity' >/dev/null 2>&1
}

start_local_telemetry_agent() {
  local key expected current pid candidate_pid started=false
  command -v node >/dev/null 2>&1 || return 0
  [ -f "$TELEMETRY_AGENT" ] || return 0
  mkdir -p "$TELEMETRY_DIR"
  chmod 700 "$TELEMETRY_DIR"
  acquire_telemetry_lock || return 0

  key="${STATEWRIGHT_API_KEY:-$(cat "$KEY_FILE" 2>/dev/null || true)}"
  key="${key%"${key##*[![:space:]]}"}"
  if [ -z "$key" ]; then
    stop_managed_telemetry_agent || true
    release_telemetry_lock
    return 0
  fi
  expected=$(STATEWRIGHT_API_KEY="$key" \
    STATEWRIGHT_PB_URL="$PB_URL" \
    STATEWRIGHT_TELEMETRY_DIR="$TELEMETRY_DIR" \
    node "$TELEMETRY_AGENT" --identity 2>/dev/null || true)
  if [ -z "$expected" ]; then
    release_telemetry_lock
    return 0
  fi
  current=$(curl -sf --max-time 1 \
    "http://127.0.0.1:${STATEWRIGHT_TELEMETRY_PORT:-4318}/health" 2>/dev/null || true)
  if health_matches_telemetry_identity "$current" "$expected"; then
    release_telemetry_lock
    return 0
  fi

  pid=$(cat "$TELEMETRY_DIR/agent.pid" 2>/dev/null || true)
  if telemetry_pid_matches "$pid"; then
    if ! stop_managed_telemetry_agent; then
      release_telemetry_lock
      return 0
    fi
    current=$(curl -sf --max-time 1 \
      "http://127.0.0.1:${STATEWRIGHT_TELEMETRY_PORT:-4318}/health" 2>/dev/null || true)
  fi
  if [ -n "$current" ]; then
    echo "[statewright] incompatible token telemetry listener has no managed pid; leaving it untouched" >&2
    release_telemetry_lock
    return 0
  fi

  STATEWRIGHT_API_KEY="$key" \
    STATEWRIGHT_PB_URL="$PB_URL" \
    STATEWRIGHT_TELEMETRY_DIR="$TELEMETRY_DIR" \
    nohup node "$TELEMETRY_AGENT" \
      >>"$TELEMETRY_DIR/agent.log" 2>&1 &
  candidate_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    current=$(curl -sf --max-time 1 \
      "http://127.0.0.1:${STATEWRIGHT_TELEMETRY_PORT:-4318}/health" 2>/dev/null || true)
    if telemetry_pid_matches "$candidate_pid" &&
        health_matches_telemetry_identity "$current" "$expected"; then
      started=true
      break
    fi
    sleep 0.1
  done
  if [ "$started" = "true" ]; then
    printf '%s\n' "$candidate_pid" > "$TELEMETRY_DIR/agent.pid"
    chmod 600 "$TELEMETRY_DIR/agent.pid"
  else
    telemetry_pid_matches "$candidate_pid" && kill "$candidate_pid" 2>/dev/null || true
  fi
  release_telemetry_lock
}

if [ "${STATEWRIGHT_TELEMETRY_SUPERVISE_ONLY:-false}" = "true" ]; then
  start_local_telemetry_agent
  exit 0
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
        " 2>/dev/null | perl -0777 -pe 's/[\x00-\x09\x0b-\x0c\x0e-\x1f]//g' \
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

  METHOD=$(echo "$line" | jq -r '.method // empty' 2>/dev/null)
  ID=$(echo "$line" | jq -c '.id // null' 2>/dev/null)

  # The stdio proxy owns the MCP transport handshake. Do not make Codex
  # startup depend on gateway reachability or telemetry supervision.
  if [ "$METHOD" = "initialize" ]; then
    echo '{"jsonrpc":"2.0","result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"statewright","version":"0.1.0"}},"id":'"$ID"'}'
    continue
  fi

  API_KEY="${STATEWRIGHT_API_KEY:-$(cat "$KEY_FILE" 2>/dev/null || true)}"
  API_KEY="${API_KEY%"${API_KEY##*[![:space:]]}"}"  # trim trailing whitespace/newlines

  if [ -z "$API_KEY" ]; then
    if [ "$METHOD" = "tools/list" ]; then
      echo '{"jsonrpc":"2.0","result":{"tools":[{"name":"statewright_start","description":"Activate a statewright workflow for this session. Tools will be restricted per state.","inputSchema":{"type":"object","properties":{"workflow":{"type":"string","description":"Workflow name (e.g. bugfix, etl-pipeline, code-review)"}},"required":["workflow"]}},{"name":"statewright_stop","description":"Deactivate the current workflow. All tools become available again.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_get_state","description":"Get the current workflow state, allowed tools, and available transitions.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_transition","description":"Transition to the next state in the workflow.","inputSchema":{"type":"object","properties":{"event":{"type":"string","description":"Transition event name (e.g. READY, DONE, PASS, FAIL)"}},"required":["event"]}},{"name":"statewright_list_workflows","description":"List all available workflows for this user.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_search_docs","description":"Search statewright documentation for workflow schema fields, MCP tools, patterns, and troubleshooting.","inputSchema":{"type":"object","properties":{"query":{"type":"string","description":"Search query (e.g. guard operators, allowed_tools, approval gate)"}},"required":["query"]}},{"name":"statewright_pause","description":"Pause the current workflow. State and context are saved. Resume later with statewright_load_workflow(name, resume=true).","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_get_status","description":"Get gateway status: active workflow, current state, available workflows.","inputSchema":{"type":"object","properties":{}}},{"name":"statewright_force_state","description":"Force the state machine to a specific state, bypassing guards and transitions. Only works when meta.debug is true in the workflow.","inputSchema":{"type":"object","properties":{"state":{"type":"string","description":"Target state name to jump to"},"context":{"type":"object","description":"Optional context to merge (e.g. set guard fields)"}},"required":["state"]}}]},"id":'"$ID"'}'
    elif [ "$METHOD" = "notifications/initialized" ]; then
      : # notification, no response
    else
      echo '{"jsonrpc":"2.0","error":{"code":-1,"message":"Statewright API key not configured. Visit https://statewright.ai/keys to generate one."},"id":'"$ID"'}'
    fi
    continue
  fi

  # Notifications: no response needed, trigger side effects
  if [ "$METHOD" = "notifications/initialized" ]; then
    if [ -n "$API_KEY" ]; then
      start_local_telemetry_agent >/dev/null 2>&1 &
      (upload_client_tools "$API_KEY" &)
    fi
    continue
  fi

  # Handle statewright_search_docs locally (no gateway round-trip)
  TOOL_NAME=$(echo "$line" | jq -r '.params.name // empty' 2>/dev/null)
  if [ "$METHOD" = "tools/call" ] && [ "$TOOL_NAME" = "statewright_search_docs" ]; then
    ID=$(echo "$line" | jq -c '.id // null' 2>/dev/null)
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

  # Repository artifacts stay local; only bounded index hits are returned.
  if [ "$METHOD" = "tools/call" ] && [ "$TOOL_NAME" = "statewright_search_references" ]; then
    ID=$(echo "$line" | jq -c '.id // null' 2>/dev/null)
    QUERY=$(echo "$line" | jq -r '.params.arguments.query // empty' 2>/dev/null)
    LIMIT=$(echo "$line" | jq -r '.params.arguments.limit // 8' 2>/dev/null)
    RESULT=$(node "$REFERENCE_SEARCH" --root "$(pwd)" --query "$QUERY" --limit "$LIMIT" 2>/dev/null)
    if [ -n "$RESULT" ]; then
      RESULT_TEXT=$(echo "$RESULT" | jq -r 'if .error then .error else (.results | if length == 0 then "No provenance-addressable references found." else .[] | "## [\(.source_kind)] \(.path):\(.line_start)-\(.line_end)\ncommit: \(.commit_sha // "uncommitted")\nhash: \(.source_hash)\nrank: \(.rank) [\(.rank_reasons | join(", "))]\n\(.excerpt)\n" end) end' 2>/dev/null)
      jq -cn --arg text "$RESULT_TEXT" '{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":$text}]},"id":'$ID'}'
    else
      echo '{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Reference search unavailable"}]},"id":'"$ID"'}'
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
      REFERENCE_TOOL='{"name":"statewright_search_references","description":"Search the incremental local repository index with deterministic lexical ranking. Returns read-only provenance, source hashes, rank reasons, and excerpts; ignored and secret material is excluded.","inputSchema":{"type":"object","properties":{"query":{"type":"string","description":"Task, identifier, changed path, failed hypothesis, or validation signature to find"},"limit":{"type":"integer","minimum":1,"maximum":20,"default":8}},"required":["query"]}}'
      PAUSE_TOOL='{"name":"statewright_pause","description":"Pause the current workflow. State and context are saved. Resume later with statewright_load_workflow(name, resume=true).","inputSchema":{"type":"object","properties":{}}}'
      FORCE_TOOL='{"name":"statewright_force_state","description":"Force the state machine to a specific state, bypassing guards and transitions. Only works when meta.debug is true.","inputSchema":{"type":"object","properties":{"state":{"type":"string","description":"Target state name to jump to"},"context":{"type":"object","description":"Optional context to merge (e.g. set guard fields)"}},"required":["state"]}}'
      RESPONSE=$(echo "$RESPONSE" | jq -c --argjson s "$SEARCH_TOOL" --argjson r "$REFERENCE_TOOL" --argjson p "$PAUSE_TOOL" --argjson f "$FORCE_TOOL" '.result.tools = ([.result.tools[] | select(.name != "statewright_search_docs" and .name != "statewright_search_references" and .name != "statewright_pause" and .name != "statewright_force_state")] + [$s, $r, $p, $f])' 2>/dev/null || echo "$RESPONSE")
    fi
    echo "$RESPONSE"
  else
    ID=$(echo "$line" | jq -c '.id // null' 2>/dev/null)
    echo '{"jsonrpc":"2.0","error":{"code":-2,"message":"Gateway unreachable"},"id":'"$ID"'}'
  fi

done
