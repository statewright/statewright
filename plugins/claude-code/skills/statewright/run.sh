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
WORKFLOW="$*"

case "$CMD" in
  list)
    mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_list_workflows","arguments":{}},"id":1}'
    ;;
  stop)
    mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_stop","arguments":{}},"id":1}'
    ;;
  status)
    mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}'
    ;;
  start)
    [ -z "$WORKFLOW" ] && echo "Usage: /statewright start <workflow-name>" && exit 0
    mcp_call "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"statewright_start\",\"arguments\":{\"workflow\":\"$WORKFLOW\"}},\"id\":1}"
    ;;
  *)
    WORKFLOW="$CMD"
    mcp_call "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"statewright_start\",\"arguments\":{\"workflow\":\"$WORKFLOW\"}},\"id\":1}"
    ;;
esac

exit 0
