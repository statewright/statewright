#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/statewright-managed-telemetry.XXXXXX")"
PORT=$((30000 + ($$ % 10000)))
TELEMETRY_DIR="$TMP/telemetry"

cleanup() {
  local pid
  pid=$(cat "$TELEMETRY_DIR/agent.pid" 2>/dev/null || true)
  case "$pid" in ''|*[!0-9]*) ;; *) kill "$pid" 2>/dev/null || true ;; esac
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/home/.statewright"
printf '%s\n' 'test-key' > "$TMP/home/.statewright/api_key"

# The bridge is deliberately unreachable. The proxy may fail over the one
# notification, but it must still start the managed-session collector first.
printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' |
  HOME="$TMP/home" \
  STATEWRIGHT_MANAGED_CLIENT_HOST=codex \
  STATEWRIGHT_MANAGED_MCP_URL='http://127.0.0.1:1' \
  STATEWRIGHT_MANAGED_MCP_TOKEN='test-token' \
  STATEWRIGHT_PB_URL='https://managed.invalid' \
  STATEWRIGHT_TELEMETRY_DIR="$TELEMETRY_DIR" \
  STATEWRIGHT_TELEMETRY_PORT="$PORT" \
  bash "$SCRIPT_DIR/mcp-proxy.sh" >/dev/null

PID=$(cat "$TELEMETRY_DIR/agent.pid")
case "$PID" in ''|*[!0-9]*) exit 1 ;; esac
curl -sf "http://127.0.0.1:$PORT/health" | jq -e '.listener_status == "healthy"' >/dev/null

echo "managed telemetry supervision tests passed"
