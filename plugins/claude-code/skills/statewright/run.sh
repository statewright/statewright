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
    echo "$RESP" | perl -0777 -pe 's/[\x00-\x09\x0b-\x0c\x0e-\x1f]//g' | jq -r '.result.content[0].text // .error.message // empty' 2>/dev/null
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
    HOOK_SCRIPT="$(dirname "$0")/../hook.sh"
    [ ! -f "$HOOK_SCRIPT" ] && HOOK_SCRIPT="$(dirname "$0")/../../hook.sh"
    if [ -f "$HOOK_SCRIPT" ]; then
      echo '{"tool_name":"statewright_deactivate"}' | bash "$HOOK_SCRIPT" post-tool >/dev/null 2>&1
    fi
    echo "Workflow deactivated. All tools available."
    ;;
  status)
    mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}'
    ;;
  start|*)
    [ "$CMD" != "start" ] && WORKFLOW="$CMD"
    [ -z "$WORKFLOW" ] && echo "Usage: /statewright start <workflow-name>" && exit 0
    # Session-scoped state
    SESSION_KEY="${CLAUDE_SESSION_ID:-$(printf '%s' "$PWD" | shasum -a 256 2>/dev/null | cut -c1-8 || echo "default")}"
    SESSION_KEY="${SESSION_KEY:0:12}"
    SW_DIR="$HOME/.statewright/sessions/$SESSION_KEY"
    mkdir -p "$SW_DIR"
    rm -f "$SW_DIR/.active" "$SW_DIR/.state_cache" "$SW_DIR/.session_hinted" "$SW_DIR/.discovered_commands" "$SW_DIR/.capture_enabled" "$SW_DIR/.run_id" "$SW_DIR/.log_seq"
    # Load workflow on gateway
    # Load workflow on gateway
    LOAD_RESP=$(mcp_call "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"statewright_load_workflow\",\"arguments\":{\"name\":\"$WORKFLOW\",\"session_id\":\"$SESSION_KEY\"}},\"id\":1}")
    echo "$LOAD_RESP"

    # Trigger PostToolUse hook to write state files (run.sh can't persist files directly)
    HOOK_SCRIPT="$(dirname "$0")/../hook.sh"
    [ ! -f "$HOOK_SCRIPT" ] && HOOK_SCRIPT="$(dirname "$0")/../../hook.sh"
    if [ -f "$HOOK_SCRIPT" ]; then
      echo "{\"tool_name\":\"statewright_load_workflow\",\"tool_result\":$(echo "$LOAD_RESP" | jq -Rs .)}" | bash "$HOOK_SCRIPT" post-tool >/dev/null 2>&1
    fi

    # Output context for the agent
    STATE=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}')
    if [ -n "$STATE" ]; then
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
