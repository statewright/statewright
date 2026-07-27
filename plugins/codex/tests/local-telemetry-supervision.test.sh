#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/statewright-supervision.XXXXXX")"
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
printf '%s\n' "test-key" > "$TMP/home/.statewright/api_key"
mkdir -p "$TELEMETRY_DIR/agent-start.lock"
printf '%s\n' "999999" > "$TELEMETRY_DIR/agent-start.lock/owner.pid"

supervise() {
  env -u STATEWRIGHT_API_KEY \
    HOME="$TMP/home" \
    STATEWRIGHT_PB_URL="$1" \
    STATEWRIGHT_TELEMETRY_DIR="$TELEMETRY_DIR" \
    STATEWRIGHT_TELEMETRY_PORT="$PORT" \
    STATEWRIGHT_TELEMETRY_SUPERVISE_ONLY=true \
    bash "$SCRIPT_DIR/mcp-proxy.sh"
}

supervise "https://first.invalid" &
FIRST_SUPERVISOR=$!
supervise "https://first.invalid" &
SECOND_SUPERVISOR=$!
wait "$FIRST_SUPERVISOR"
wait "$SECOND_SUPERVISOR"
FIRST_PID=$(cat "$TELEMETRY_DIR/agent.pid")
FIRST_ID=$(curl -sf "http://127.0.0.1:$PORT/health" | jq -r '.config_identity')
[ -n "$FIRST_ID" ]

supervise "https://first.invalid"
[ "$(cat "$TELEMETRY_DIR/agent.pid")" = "$FIRST_PID" ]

supervise "https://second.invalid"
SECOND_PID=$(cat "$TELEMETRY_DIR/agent.pid")
SECOND_ID=$(curl -sf "http://127.0.0.1:$PORT/health" | jq -r '.config_identity')
[ "$SECOND_PID" != "$FIRST_PID" ]
[ "$SECOND_ID" != "$FIRST_ID" ]

rm -f "$TMP/home/.statewright/api_key"
supervise "https://second.invalid"
[ ! -f "$TELEMETRY_DIR/agent.pid" ]
! curl -sf --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null

echo "local telemetry supervision tests passed"
