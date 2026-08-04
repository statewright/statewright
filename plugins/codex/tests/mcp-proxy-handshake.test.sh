#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/statewright-mcp-handshake.XXXXXX")"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/home/.statewright"
printf '%s\n' "test-key" > "$TMP/home/.statewright/api_key"

RESPONSE=$(
  printf '%s\n' \
    '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test-client","version":"1"}},"id":"init-1"}' |
    HOME="$TMP/home" \
    STATEWRIGHT_GATEWAY_URL="http://127.0.0.1:1" \
    STATEWRIGHT_TELEMETRY_DIR="$TMP/telemetry" \
    bash "$SCRIPT_DIR/mcp-proxy.sh"
)

echo "$RESPONSE" | jq -e '
  .id == "init-1" and
  .result.protocolVersion == "2024-11-05" and
  .result.capabilities.tools.listChanged == false and
  .result.serverInfo.name == "statewright"
' >/dev/null

[ ! -e "$TMP/telemetry/agent.pid" ]

echo "MCP proxy handshake tests passed"
