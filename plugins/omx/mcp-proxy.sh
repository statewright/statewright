#!/usr/bin/env bash
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${STATEWRIGHT_ADAPTER_URL:-}" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    id=$(printf '%s' "$line" | jq -r '.id // null' 2>/dev/null)
    method=$(printf '%s' "$line" | jq -r '.method // empty' 2>/dev/null)
    [[ "$method" == notifications/* ]] && continue
    printf '{"jsonrpc":"2.0","error":{"code":-32603,"message":"OMX Statewright MCP requires statewright-exec."},"id":%s}\n' "$id"
  done
  exit 0
fi

exec bash "${SCRIPT_DIR}/../executor/mcp-proxy.sh"
