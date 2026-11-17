#!/usr/bin/env bash

# Pass bearer credentials to curl through a config stream, not argv (ps).
# Reject CR/LF so a legacy env token cannot inject additional curl config.
statewright_bearer_config() {
  local value="$1"
  case "$value" in
    *$'\n'*|*$'\r'*) return 1 ;;
  esac
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf 'header = "Authorization: Bearer %s"\n' "$value"
}

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${STATEWRIGHT_ADAPTER_URL:-}" ]; then
  exec bash "${SCRIPT_DIR}/../executor/mcp-proxy.sh"
fi

GW_URL="${STATEWRIGHT_GATEWAY_URL:-https://mcp.statewright.ai}"
CLIENT_ID="${STATEWRIGHT_CLIENT_ID:-statewright-cursor}"
SESSION_ID="${STATEWRIGHT_MCP_SESSION_ID:-}"
STATEWRIGHT_DIR="${HOME}/.statewright"
MISSING_KEY_SENTINEL="${STATEWRIGHT_DIR}/missing_api_key_prompted"

read_api_key() {
  local key
  key="${STATEWRIGHT_API_KEY:-$(cat "${STATEWRIGHT_DIR}/api_key" 2>/dev/null || true)}"
  key="${key%"${key##*[![:space:]]}"}"
  printf '%s' "$key"
}

open_keys_page() {
  local url="${1:-https://statewright.ai/keys}"
  local -a browser_command=()
  [ "${STATEWRIGHT_NO_BROWSER:-false}" = "true" ] && return 1
  if [ "${OS:-}" = "Windows_NT" ] && command -v powershell.exe >/dev/null 2>&1; then
    if [ -n "${STATEWRIGHT_BROWSER_OPEN_PROBE:-}" ]; then
      # Use an explicit PowerShell argument array so query strings survive
      # Windows Start-Process parsing (notably the `=` in redirect=/keys).
      browser_command=(powershell.exe -NoProfile -NonInteractive -Command "Start-Process -FilePath '${STATEWRIGHT_BROWSER_OPEN_PROBE}' -ArgumentList @('\"$url\"') -Wait")
    else
      browser_command=(powershell.exe -NoProfile -NonInteractive -Command "Start-Process -FilePath '$url'")
    fi
  elif command -v open >/dev/null 2>&1; then browser_command=(open "$url")
  elif command -v xdg-open >/dev/null 2>&1; then browser_command=(xdg-open "$url")
  elif command -v wslview >/dev/null 2>&1; then browser_command=(wslview "$url")
  elif command -v powershell.exe >/dev/null 2>&1; then browser_command=(powershell.exe -NoProfile -NonInteractive -Command "Start-Process -FilePath '$url'")
  fi
  [ ${#browser_command[@]} -gt 0 ] || return 1
  if [ -n "${STATEWRIGHT_BROWSER_OPEN_CAPTURE_PATH:-}" ]; then
    printf '%s\n' "${browser_command[@]}" >> "$STATEWRIGHT_BROWSER_OPEN_CAPTURE_PATH"
  else
    "${browser_command[@]}" >/dev/null 2>&1
  fi
}

prompt_missing_key() {
  mkdir -p "$STATEWRIGHT_DIR" 2>/dev/null || return 0
  if [ ! -f "$MISSING_KEY_SENTINEL" ]; then
    if open_keys_page 'https://statewright.ai/signup?redirect=%2Fkeys'; then
      : > "$MISSING_KEY_SENTINEL"
      chmod 600 "$MISSING_KEY_SENTINEL"
    fi
  fi
}

while IFS= read -r line; do
  [ -z "$line" ] && continue
  API_KEY="$(read_api_key)"
  method=$(printf '%s' "$line" | jq -r '.method // empty' 2>/dev/null)
  id=$(printf '%s' "$line" | jq -r '.id // null' 2>/dev/null)
  if [ -z "$API_KEY" ]; then
    [ "$method" = "notifications/initialized" ] || prompt_missing_key
    if [ "$method" = "initialize" ]; then
      printf '{"jsonrpc":"2.0","result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"statewright","version":"0.1.0"}},"id":%s}\n' "$id"
    elif [ "$method" = "tools/list" ]; then
      printf '{"jsonrpc":"2.0","result":{"tools":[]},"id":%s}\n' "$id"
    elif [ "$method" != "notifications/initialized" ]; then
      printf '{"jsonrpc":"2.0","error":{"code":-1,"message":"Statewright API key not configured. Visit https://statewright.ai/keys to generate one."},"id":%s}\n' "$id"
    fi
    continue
  fi
  rm -f "$MISSING_KEY_SENTINEL"
  headers=(-H 'Content-Type: application/json' -H "X-Statewright-Client-Id: ${CLIENT_ID}")
  [ -n "$SESSION_ID" ] && headers+=(-H "Mcp-Session-Id: ${SESSION_ID}")
  response=$(curl -sf --max-time 15 -X POST "${GW_URL%/}/mcp" -K <(statewright_bearer_config "$API_KEY") "${headers[@]}" --data-binary "$line" 2>/dev/null || true)
  if [ -n "$response" ]; then
    printf '%s\n' "$response"
  else
    printf '{"jsonrpc":"2.0","error":{"code":-32603,"message":"Statewright gateway unavailable."},"id":%s}\n' "$id"
  fi
done
