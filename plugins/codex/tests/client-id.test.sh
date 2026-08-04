#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../client-id.sh
source "$SCRIPT_DIR/client-id.sh"

export STATEWRIGHT_MCP_SESSION_ID=br_codex_isolation-a
proxy_id=$(statewright_client_id codex)
hook_id=$(statewright_client_id codex hook-session-a)
[ "$proxy_id" = "$hook_id" ]

unset STATEWRIGHT_MCP_SESSION_ID
first_hook_id=$(statewright_client_id codex stable-hook-session)
second_hook_id=$(statewright_client_id codex stable-hook-session)
[ "$first_hook_id" = "$second_hook_id" ]

hook_thread=$(printf '%s' '{"thread_id":"thread-a","session_id":"thread-a-turn-a"}' | jq -r '.thread_id // .session_id // empty')
[ "$hook_thread" = "thread-a" ]
[ "$(statewright_codex_resume_material 'node codex resume durable-thread continue')" = "codex-thread:durable-thread" ]

managed_root=$(mktemp -d)
export STATEWRIGHT_ROUTE_CONTROL_DIR="$managed_root"
printf '%s\n' '{"client_id":"swc_0123456789abcdef0123456789abcdef"}' > "$managed_root/identity.json"
[ "$(statewright_client_id codex unexpected-hook-thread)" = "swc_0123456789abcdef0123456789abcdef" ]
unset STATEWRIGHT_ROUTE_CONTROL_DIR
rm -f "$managed_root/identity.json"
rmdir "$managed_root"

export STATEWRIGHT_CLIENT_ID=explicit-client-a
client_a=$(statewright_client_id codex hook-session-a)
export STATEWRIGHT_CLIENT_ID=explicit-client-b
client_b=$(statewright_client_id codex hook-session-a)
[ "$client_a" != "$client_b" ]

case "$client_a" in
  swc_????????????????????????????????) ;;
  *) echo "unexpected client ID format: $client_a" >&2; exit 1 ;;
esac

echo "client identity tests: ok"
