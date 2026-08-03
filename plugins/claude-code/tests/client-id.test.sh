#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../client-id.sh
source "$SCRIPT_DIR/client-id.sh"

export STATEWRIGHT_MCP_SESSION_ID=br_claude_isolation-a
proxy_id=$(statewright_client_id)
hook_id=$(statewright_client_id hook-session-a)
[ "$proxy_id" = "$hook_id" ]

unset STATEWRIGHT_MCP_SESSION_ID
export STATEWRIGHT_CLIENT_ID=explicit-client-a
client_a=$(statewright_client_id hook-session-a)
export STATEWRIGHT_CLIENT_ID=explicit-client-b
client_b=$(statewright_client_id hook-session-a)
[ "$client_a" != "$client_b" ]

case "$client_a" in
  swc_????????????????????????????????) ;;
  *) echo "unexpected client ID format: $client_a" >&2; exit 1 ;;
esac

echo "claude client identity tests: ok"
