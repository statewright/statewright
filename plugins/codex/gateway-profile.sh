#!/usr/bin/env bash
# Resolve non-secret gateway configuration and access the platform credential
# store through the packaged Node adapter and native Rust helper.
statewright_gateway_profile() {
  local script_dir node_runtime profile
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  node_runtime="${STATEWRIGHT_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
  [ -n "$node_runtime" ] && [ -x "$node_runtime" ] || return 1
  profile="$($node_runtime "$script_dir/scripts/lib/desktop-runtime/gateway-profile.mjs" --profile-json 2>/dev/null)" || return 1
  STATEWRIGHT_GATEWAY_URL="$(printf '%s' "$profile" | jq -r '.gateway_url // empty')"
  STATEWRIGHT_PB_URL="$(printf '%s' "$profile" | jq -r '.auth_url // empty')"
  STATEWRIGHT_GATEWAY_IDENTITY="$(printf '%s' "$profile" | jq -r '.identity // empty')"
  STATEWRIGHT_CREDENTIAL_ADAPTER="$script_dir/scripts/lib/desktop-runtime/credential-store.mjs"
  STATEWRIGHT_NODE_RUNTIME="$node_runtime"
  [ -n "$STATEWRIGHT_GATEWAY_URL" ] && [ -n "$STATEWRIGHT_GATEWAY_IDENTITY" ]
}

statewright_load_api_key() {
  if [ -n "${STATEWRIGHT_API_KEY:-}" ]; then
    printf '%s' "$STATEWRIGHT_API_KEY"
    return 0
  fi
  "$STATEWRIGHT_NODE_RUNTIME" "$STATEWRIGHT_CREDENTIAL_ADAPTER" get "$STATEWRIGHT_GATEWAY_URL" 2>/dev/null
}

statewright_store_api_key() {
  "$STATEWRIGHT_NODE_RUNTIME" "$STATEWRIGHT_CREDENTIAL_ADAPTER" set "$STATEWRIGHT_GATEWAY_URL"
}
