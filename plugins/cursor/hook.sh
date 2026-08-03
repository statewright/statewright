#!/usr/bin/env bash
# Cursor hook adapter for a Statewright executor bridge or local hook server.
set -o pipefail

EVENT="${1:-pre-tool}"
INPUT=$(cat 2>/dev/null || true)
PORT_FILE="${STATEWRIGHT_HOOK_PORT_FILE:-/tmp/statewright-hook-port}"

if ! command -v jq >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo '{}'
  exit 0
fi

AUTH_ARGS=()
if [ -n "${STATEWRIGHT_ADAPTER_URL:-}" ]; then
  HOOK_URL="${STATEWRIGHT_ADAPTER_URL%/}/hooks"
  [ -n "${STATEWRIGHT_ADAPTER_TOKEN:-}" ] && \
    AUTH_ARGS=(-H "Authorization: Bearer ${STATEWRIGHT_ADAPTER_TOKEN}")
  STRICT_ADAPTER=true
else
  PORT=$(cat "$PORT_FILE" 2>/dev/null || true)
  case "$PORT" in
    ''|*[!0-9]*) echo '{}'; exit 0 ;;
  esac
  HOOK_URL="http://127.0.0.1:${PORT}/hooks"
  STRICT_ADAPTER=false
fi

get_state() {
  curl -sf --max-time 3 "${HOOK_URL}/state" "${AUTH_ARGS[@]}" 2>/dev/null || true
}

normalize_tool_name() {
  local tool_name="$1" tool_input="$2" server inner
  case "$tool_name" in
    Shell) printf 'Bash' ;;
    ReadFile) printf 'Read' ;;
    ListDirectory) printf 'Glob' ;;
    SearchFiles|SearchCodebase) printf 'Grep' ;;
    StrReplace|ApplyPatch|Delete) printf 'Edit' ;;
    Task) printf 'Agent' ;;
    CallMcpTool)
      server=$(printf '%s' "$tool_input" | jq -r '.server_name // .serverName // empty')
      inner=$(printf '%s' "$tool_input" | jq -r '.tool_name // .toolName // empty')
      if [[ "$inner" == statewright_* ]]; then
        printf '%s' "$inner"
      elif [ -n "$server" ] && [ -n "$inner" ]; then
        printf 'mcp__%s__%s' "$server" "$inner"
      else
        printf '%s' "$tool_name"
      fi
      ;;
    *) printf '%s' "$tool_name" ;;
  esac
}

delivery_owner_missing() {
  local state active delivery
  state=$(get_state)
  [ "$(printf '%s' "$state" | jq -r '.deliveryRequired // false')" != "true" ] && return 1
  active=$(printf '%s' "$state" | jq -r '.executor.active // false')
  delivery=$(printf '%s' "$state" | jq -r '.executor.delivery // false')
  [ "$active" != "true" ] || [ "$delivery" != "true" ]
}

pre_tool() {
  local tool_name="$1" tool_input="$2" response decision reason normalized
  if delivery_owner_missing; then
    reason="This workflow requires isolated delivery. Launch it through the Statewright executor so it owns the delivery lifecycle."
    jq -cn --arg reason "$reason" \
      '{permission:"deny",user_message:$reason,agent_message:$reason}'
    return
  fi
  normalized=$(normalize_tool_name "$tool_name" "$tool_input")
  response=$(jq -cn --arg name "$tool_name" --argjson input "$tool_input" \
    --arg normalized "$normalized" \
    '{tool_name:$normalized,tool_input:$input,host_tool_name:$name}' \
    | curl -sf --max-time 3 -X POST "${HOOK_URL}/pre-tool" \
        -H 'Content-Type: application/json' "${AUTH_ARGS[@]}" --data-binary @- 2>/dev/null || true)
  if [ -z "$response" ] && [ "$STRICT_ADAPTER" = true ]; then
    reason="Statewright executor bridge is unavailable; refusing an unguarded tool call."
    jq -cn --arg reason "$reason" '{permission:"deny",user_message:$reason,agent_message:$reason}'
    return
  fi
  decision=$(printf '%s' "$response" | jq -r '.decision // "allow"' 2>/dev/null || echo allow)
  if [ "$decision" = "deny" ]; then
    reason=$(printf '%s' "$response" | jq -r '.reason // .additionalContext // "Blocked by Statewright"')
    jq -cn --arg reason "$reason" \
      '{permission:"deny",user_message:$reason,agent_message:$reason}'
  else
    echo '{"permission":"allow"}'
  fi
}

post_tool() {
  local tool_name="$1" tool_input="$2" tool_response="$3" is_error="$4" normalized
  normalized=$(normalize_tool_name "$tool_name" "$tool_input")
  jq -cn --arg name "$normalized" --argjson input "$tool_input" \
    --arg response "$tool_response" --argjson is_error "$is_error" \
    '{tool_name:$name,tool_input:$input,tool_response:$response,is_error:$is_error}' \
    | curl -sf --max-time 3 -X POST "${HOOK_URL}/post-tool" \
        -H 'Content-Type: application/json' "${AUTH_ARGS[@]}" --data-binary @- >/dev/null 2>&1 || true
  echo '{}'
}

case "$EVENT" in
  session-start)
    STATE=$(get_state)
    CURRENT=$(printf '%s' "$STATE" | jq -r '.state // empty' 2>/dev/null || true)
    if [ -z "$CURRENT" ] || [ "$CURRENT" = "unknown" ]; then
      echo '{}'
      exit 0
    fi
    DELIVERY_REQUIRED=$(printf '%s' "$STATE" | jq -r '.deliveryRequired // false')
    if delivery_owner_missing; then
      jq -cn '{additional_context:"Statewright blocked this workflow: isolated delivery is required. Launch it through the Statewright executor so it owns the delivery lifecycle."}'
      exit 0
    fi
    MODEL=$(printf '%s' "$STATE" | jq -r '.model // empty')
    EFFORT=$(printf '%s' "$STATE" | jq -r '.thinkingLevel // "default"')
    CONTEXT=$(printf '%s' "$STATE" | jq -r '.additionalContext // empty')
    if [ -n "$MODEL" ]; then
      CONTEXT="${CONTEXT} Recommended route: model ${MODEL}, effort ${EFFORT}. Cursor hooks cannot switch the active model; select this route at session start when possible."
    fi
    jq -cn --arg context "$CONTEXT" '{additional_context:$context}'
    ;;
  pre-tool)
    TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // .toolName // empty')
    TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // .toolInput // {}')
    pre_tool "$TOOL" "$TOOL_INPUT"
    ;;
  before-shell)
    COMMAND=$(printf '%s' "$INPUT" | jq -r '.command // empty')
    TOOL_INPUT=$(jq -cn --arg command "$COMMAND" '{command:$command}')
    pre_tool "Bash" "$TOOL_INPUT"
    ;;
  before-mcp)
    TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
    TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // {}')
    pre_tool "$TOOL" "$TOOL_INPUT"
    ;;
  before-read)
    PATH_VALUE=$(printf '%s' "$INPUT" | jq -r '.file_path // .path // empty')
    TOOL_INPUT=$(jq -cn --arg file_path "$PATH_VALUE" '{file_path:$file_path}')
    pre_tool "Read" "$TOOL_INPUT"
    ;;
  post-tool)
    TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // .toolName // "unknown"')
    TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // .toolInput // {}')
    TOOL_RESPONSE=$(printf '%s' "$INPUT" | jq -r '.tool_response // .toolResponse // .result // empty | tostring')
    post_tool "$TOOL" "$TOOL_INPUT" "$TOOL_RESPONSE" false
    ;;
  after-shell)
    COMMAND=$(printf '%s' "$INPUT" | jq -r '.command // empty')
    TOOL_INPUT=$(jq -cn --arg command "$COMMAND" '{command:$command}')
    TOOL_RESPONSE=$(printf '%s' "$INPUT" | jq -r '.output // .result // empty | tostring')
    post_tool "Bash" "$TOOL_INPUT" "$TOOL_RESPONSE" false
    ;;
  after-mcp)
    TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // "MCP"')
    TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // {}')
    TOOL_RESPONSE=$(printf '%s' "$INPUT" | jq -r '.tool_response // .result // empty | tostring')
    post_tool "$TOOL" "$TOOL_INPUT" "$TOOL_RESPONSE" false
    ;;
  after-edit)
    PATH_VALUE=$(printf '%s' "$INPUT" | jq -r '.file_path // .path // empty')
    TOOL_INPUT=$(jq -cn --arg file_path "$PATH_VALUE" '{file_path:$file_path}')
    post_tool "Edit" "$TOOL_INPUT" "" false
    ;;
  stop)
    RESPONSE=$(curl -sf --max-time 3 -X POST "${HOOK_URL}/stop" \
      -H 'Content-Type: application/json' "${AUTH_ARGS[@]}" -d '{}' 2>/dev/null || true)
    DECISION=$(printf '%s' "$RESPONSE" | jq -r '.decision // "allow"')
    if [ "$DECISION" = "block" ]; then
      REASON=$(printf '%s' "$RESPONSE" | jq -r '.reason // .additionalContext // "Continue the active Statewright workflow."')
      jq -cn --arg reason "$REASON" '{followup_message:$reason}'
    else
      echo '{}'
    fi
    ;;
  *) echo '{}' ;;
esac
