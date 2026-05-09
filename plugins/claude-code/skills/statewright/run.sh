#!/usr/bin/env bash
# /statewright slash command — calls MCP gateway directly

GW_URL="${STATEWRIGHT_GATEWAY_URL:-https://mcp.statewright.ai}"
API_KEY="${STATEWRIGHT_API_KEY:-$(cat "$HOME/.statewright/api_key" 2>/dev/null)}"

if [ -z "$API_KEY" ]; then
  echo "No API key configured. Visit https://statewright.ai/keys to generate one."
  exit 0
fi

mcp_call() {
  local RESP
  RESP=$(curl -s --max-time 5 -X POST "$GW_URL/" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $API_KEY" \
    -d "$1" 2>/dev/null)
  if [ -n "$RESP" ]; then
    echo "$RESP" | jq -r '.result.content[0].text // .error.message // empty' 2>/dev/null
  else
    echo "Gateway unreachable at $GW_URL"
  fi
}

CMD="${1:-list}"
shift 2>/dev/null || true
# First remaining arg is workflow name, rest is task prompt
WORKFLOW="${1:-}"
shift 2>/dev/null || true
TASK_PROMPT="$*"

case "$CMD" in
  list)
    mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_list_workflows","arguments":{}},"id":1}'
    ;;
  stop)
    mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_deactivate","arguments":{}},"id":1}'
    PROJECT_HASH=$(printf '%s' "$PWD" | shasum -a 256 2>/dev/null | cut -c1-8 || echo "default")
    SW_PROJECT="$HOME/.statewright/projects/$PROJECT_HASH"
    rm -f "$SW_PROJECT/.active" "$SW_PROJECT/.state_cache" "$SW_PROJECT/.session_hinted" "$SW_PROJECT/.discovered_commands"
    echo "Workflow deactivated. All tools available."
    ;;
  status)
    mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}'
    ;;
  start|*)
    [ "$CMD" != "start" ] && WORKFLOW="$CMD"
    [ -z "$WORKFLOW" ] && echo "Usage: /statewright start <workflow-name>" && exit 0
    # Clean slate — project-scoped state files
    PROJECT_HASH=$(printf '%s' "$PWD" | shasum -a 256 2>/dev/null | cut -c1-8 || echo "default")
    SW_DIR="$HOME/.statewright/projects/$PROJECT_HASH"
    mkdir -p "$SW_DIR"
    rm -f "$SW_DIR/.active" "$SW_DIR/.state_cache" "$SW_DIR/.session_hinted" "$SW_DIR/.discovered_commands" "$SW_DIR/.capture_enabled" "$SW_DIR/.run_id" "$SW_DIR/.log_seq"
    # Load workflow on gateway
    LOAD_RESP=$(mcp_call "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"statewright_load_workflow\",\"arguments\":{\"name\":\"$WORKFLOW\",\"project_id\":\"$PROJECT_HASH\"}},\"id\":1}")
    echo "$LOAD_RESP"
    # Activate local enforcement
    echo "{\"activated\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$SW_DIR/.active"
    # Check if capture_output is enabled and store run_id for log linkage
    RUN_ID=$(echo "$LOAD_RESP" | jq -r '.run_id // empty' 2>/dev/null || true)
    CAPTURE=$(echo "$LOAD_RESP" | jq -r '.capture_output // false' 2>/dev/null || true)
    [ -n "$RUN_ID" ] && echo "$RUN_ID" > "$SW_DIR/.run_id"
    [ "$CAPTURE" = "true" ] && touch "$SW_DIR/.capture_enabled"
    # Fetch and cache state, output context hint
    STATE=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}')
    if [ -n "$STATE" ]; then
      echo "$STATE" > "$SW_DIR/.state_cache"
      PHASE=$(echo "$STATE" | jq -r '.state // empty' 2>/dev/null)
      TOOLS=$(echo "$STATE" | jq -r '.allowed_tools // [] | join(", ")' 2>/dev/null)
      TRANS=$(echo "$STATE" | jq -r '.transitions // [] | map(.event + " -> " + .target) | join(", ")' 2>/dev/null)
      INSTR=$(echo "$STATE" | jq -r '.instructions // empty' 2>/dev/null)
      echo ""
      echo "Phase: $PHASE. Tools: $TOOLS. Transitions: $TRANS."
      [ -n "$INSTR" ] && echo "Instructions: $INSTR"
      [ -n "$TASK_PROMPT" ] && echo "" && echo "Task: $TASK_PROMPT"
    fi
    ;;
esac

exit 0
