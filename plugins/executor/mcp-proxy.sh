#!/usr/bin/env bash
set -o pipefail

GW_URL="${STATEWRIGHT_GATEWAY_URL:-https://mcp.statewright.ai}"
API_KEY="${STATEWRIGHT_API_KEY:-$(cat "${HOME}/.statewright/api_key" 2>/dev/null || true)}"
API_KEY="${API_KEY%"${API_KEY##*[![:space:]]}"}"
CLIENT_ID="${STATEWRIGHT_CLIENT_ID:-statewright-executor}"
SESSION_ID="${STATEWRIGHT_MCP_SESSION_ID:-}"

while IFS= read -r line; do
  [ -z "$line" ] && continue
  if [ -z "$API_KEY" ]; then
    id=$(printf '%s' "$line" | jq -r '.id // null' 2>/dev/null)
    printf '{"jsonrpc":"2.0","error":{"code":-1,"message":"Statewright API key is not configured."},"id":%s}\n' "$id"
    continue
  fi
  headers=(-H 'Content-Type: application/json' -H "Authorization: Bearer ${API_KEY}" -H "X-Statewright-Client-Id: ${CLIENT_ID}")
  [ -n "$SESSION_ID" ] && headers+=(-H "Mcp-Session-Id: ${SESSION_ID}")
  response=$(curl -sf --max-time 15 -X POST "${GW_URL%/}/mcp" "${headers[@]}" --data-binary "$line" 2>/dev/null || true)
  if [ -n "$response" ]; then
    printf '%s\n' "$response"
  else
    id=$(printf '%s' "$line" | jq -r '.id // null' 2>/dev/null)
    printf '{"jsonrpc":"2.0","error":{"code":-32603,"message":"Statewright gateway unavailable."},"id":%s}\n' "$id"
  fi
done
