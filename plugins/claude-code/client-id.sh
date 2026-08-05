#!/usr/bin/env bash

# Resolve one opaque identity shared by Claude's long-lived MCP proxy and its
# one-shot hooks. Cwd is not an identity: concurrent sessions may share it.
statewright_hash_client_material() {
  local material="$1"
  local digest=""
  if command -v shasum >/dev/null 2>&1; then
    digest=$(printf '%s' "$material" | LC_ALL=C shasum -a 256 2>/dev/null | awk '{print substr($1, 1, 32)}' || true)
  fi
  if [ -z "$digest" ] && command -v sha256sum >/dev/null 2>&1; then
    digest=$(printf '%s' "$material" | LC_ALL=C sha256sum 2>/dev/null | awk '{print substr($1, 1, 32)}' || true)
  fi
  if [ -z "$digest" ]; then
    digest=$(printf '%s' "$material" | LC_ALL=C cksum | awk '{print $1}')
  fi
  printf '%s' "$digest"
}

# A managed supervisor owns a stable identity across CLI restarts. Its control
# file is the source of truth for hooks; hashing STATEWRIGHT_CLIENT_ID would
# produce a different identity and make the supervisor reject the route.
statewright_managed_client_id() {
  local control_dir="${STATEWRIGHT_ROUTE_CONTROL_DIR:-}"
  local identity_file client_id
  [ -n "$control_dir" ] || return 1
  identity_file="$control_dir/identity.json"
  [ -r "$identity_file" ] || return 1
  client_id=$(jq -r 'if .host == "claude" and (.client_id | type) == "string" and (.client_id | test("^swc_[0-9a-f]{32}$")) then .client_id else empty end' "$identity_file" 2>/dev/null || true)
  [ -n "$client_id" ] || return 1
  printf '%s' "$client_id"
}

statewright_host_process_material() {
  local pid="${PPID:-0}"
  local depth=0
  local command_name parent_pid started

  while [ "$pid" -gt 1 ] 2>/dev/null && [ "$depth" -lt 12 ]; do
    command_name=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    case "$command_name" in
      *claude*)
        started=$(ps -p "$pid" -o lstart= 2>/dev/null || true)
        printf 'process:%s:%s:%s' "$command_name" "$pid" "$started"
        return 0
        ;;
    esac
    parent_pid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ' || true)
    [ -n "$parent_pid" ] || break
    pid="$parent_pid"
    depth=$((depth + 1))
  done

  return 1
}

statewright_client_id() {
  local hook_session="${1:-}"
  local managed_id material=""

  # Do not inherit another TUI's managed transport identity when Claude is
  # launched from a shell that was itself started by Codex (or vice versa).
  if [ -z "${STATEWRIGHT_MANAGED_CLIENT_HOST:-}" ] || [ "$STATEWRIGHT_MANAGED_CLIENT_HOST" = "claude" ]; then
    material="${STATEWRIGHT_CLIENT_ID:-${STATEWRIGHT_MCP_SESSION_ID:-}}"
  fi

  managed_id=$(statewright_managed_client_id || true)
  if [ -n "$managed_id" ]; then
    printf '%s' "$managed_id"
    return 0
  fi

  if [ -z "$material" ]; then
    material="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
  fi
  if [ -z "$material" ]; then
    material=$(statewright_host_process_material || true)
  fi
  if [ -z "$material" ]; then
    material="${hook_session:-process:${PPID:-0}}"
  fi

  printf 'swc_%s' "$(statewright_hash_client_material "$material")"
}
