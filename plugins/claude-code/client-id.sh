#!/usr/bin/env bash

# Resolve one opaque identity shared by the host's MCP proxy and hooks.
# Never use cwd: concurrent sessions commonly operate in the same checkout.
statewright_hash_client_material() {
  local material="$1"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$material" | shasum -a 256 | awk '{print substr($1, 1, 32)}'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$material" | sha256sum | awk '{print substr($1, 1, 32)}'
  else
    printf '%s' "$material" | cksum | awk '{print $1}'
  fi
}

statewright_host_process_material() {
  local pid="${PPID:-0}"
  local depth=0
  local command_name parent_pid started

  while [ "$pid" -gt 1 ] 2>/dev/null && [ "$depth" -lt 12 ]; do
    command_name=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    case "$command_name" in
      *codex*|*claude*|*opencode*|*omx*)
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
  local host="$1"
  local hook_session="${2:-}"
  local material="${STATEWRIGHT_CLIENT_ID:-}"

  if [ -z "$material" ]; then
    case "$host" in
      claude)
        material="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
        ;;
      *)
        material="${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-}}"
        ;;
    esac
  fi

  # Process ancestry is visible to both the stdio proxy and one-shot hooks.
  # The hook payload is a final fallback because the proxy may not receive it.
  if [ -z "$material" ]; then
    material=$(statewright_host_process_material || true)
  fi
  if [ -z "$material" ]; then
    material="${hook_session:-process:${PPID:-0}}"
  fi

  printf 'swc_%s' "$(statewright_hash_client_material "$material")"
}
