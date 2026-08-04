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
    echo "$RESP" | LC_ALL=C perl -0777 -pe 's/[\x00-\x09\x0b-\x0c\x0e-\x1f]//g' | jq -r '.result.content[0].text // .error.message // empty' 2>/dev/null
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
    # Verify workflow exists (don't load — the MCP tool call handles that)
    LIST_RESP=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_list_workflows","arguments":{}},"id":1}')
    if [ -n "$LIST_RESP" ] && echo "$LIST_RESP" | jq -e ".workflows | index(\"$WORKFLOW\")" >/dev/null 2>&1; then
      echo "Workflow '$WORKFLOW' found. Call statewright_load_workflow to activate it."
    elif [ -n "$LIST_RESP" ]; then
      AVAILABLE=$(echo "$LIST_RESP" | jq -r '.workflows | join(", ")' 2>/dev/null)
      echo "Workflow '$WORKFLOW' not found. Available: $AVAILABLE"
    else
      echo "Gateway unreachable. Workflow '$WORKFLOW' cannot be verified."
    fi
    ;;
esac

exit 0
