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
mkdir -p "$TMP/bin"
printf '%s\n' '#!/usr/bin/env sh' 'exit 0' > "$TMP/bin/codex"
chmod +x "$TMP/bin/codex"
printf '%s\n' '#!/usr/bin/env sh' 'printf "%s\\n" "$*" >> "$STATEWRIGHT_DESKTOP_NODE_CAPTURE"' 'exit 0' > "$TMP/bin/desktop-node"
chmod +x "$TMP/bin/desktop-node"
printf '%s\n' '#!/usr/bin/env sh' 'exit 0' > "$TMP/bin/ChatGPT"
chmod +x "$TMP/bin/ChatGPT"

RESPONSE=$(
  printf '%s\n' \
    '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test-client","version":"1"}},"id":"init-1"}' |
    HOME="$TMP/home" \
    SHELL="/bin/zsh" \
    PATH="$TMP/bin:$PATH" \
    STATEWRIGHT_GATEWAY_URL="http://127.0.0.1:1" \
    STATEWRIGHT_ADAPTER_URL="" \
    STATEWRIGHT_ADAPTER_TOKEN="" \
    STATEWRIGHT_MANAGED_MCP_URL="" \
    STATEWRIGHT_MANAGED_MCP_TOKEN="" \
    STATEWRIGHT_TELEMETRY_DIR="$TMP/telemetry" \
    STATEWRIGHT_DESKTOP_PLATFORM="Darwin" \
    STATEWRIGHT_DESKTOP_APP_EXECUTABLE="$TMP/bin/ChatGPT" \
    STATEWRIGHT_DESKTOP_BUNDLED_NODE="$TMP/bin/desktop-node" \
    STATEWRIGHT_DESKTOP_NODE_CAPTURE="$TMP/desktop-node.log" \
    bash "$SCRIPT_DIR/mcp-proxy.sh"
)

echo "$RESPONSE" | jq -e '
  .id == "init-1" and
  .result.protocolVersion == "2024-11-05" and
  .result.capabilities.tools.listChanged == false and
  (.result.serverInfo.name == "statewright" or .result.serverInfo.name == "statewright-gateway")
' >/dev/null

[ ! -e "$TMP/telemetry/agent.pid" ]
[ -x "$TMP/home/.statewright/bin/codex" ]
grep -q 'statewright managed clients' "$TMP/home/.zshrc"
node -e 'const fs = require("fs"); const config = JSON.parse(fs.readFileSync(process.argv[1])); if (config.routing?.managed_clients?.hosts?.codex !== true) process.exit(1)' "$TMP/home/.statewright/config.json"
grep -q 'statewright-desktop-setup.mjs provision-all --app' "$TMP/desktop-node.log"

echo "MCP proxy handshake tests passed"
