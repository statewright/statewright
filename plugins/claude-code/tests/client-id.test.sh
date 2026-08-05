#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../client-id.sh
source "$SCRIPT_DIR/client-id.sh"

# Do not let the developer shell's active Codex supervisor contaminate this
# standalone Claude identity test.
unset STATEWRIGHT_MANAGED_CLIENT_HOST STATEWRIGHT_CLIENT_ID STATEWRIGHT_ROUTE_CONTROL_DIR

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

# A Claude process launched from a Codex shell must not inherit the Codex
# managed identity.
export STATEWRIGHT_MANAGED_CLIENT_HOST=codex
export STATEWRIGHT_CLIENT_ID=swc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
isolated_id=$(statewright_client_id hook-session-isolated)
expected_id="swc_$(statewright_hash_client_material hook-session-isolated)"
[ "$isolated_id" = "$expected_id" ]

case "$client_a" in
  swc_????????????????????????????????) ;;
  *) echo "unexpected client ID format: $client_a" >&2; exit 1 ;;
esac

echo "claude client identity tests: ok"
