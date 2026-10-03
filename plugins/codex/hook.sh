#!/usr/bin/env bash
# Statewright Codex CLI plugin hook
# Dormant by default — only enforces when a workflow is explicitly activated
# via MCP tool (statewright_start) or slash command (/statewright)
set -o pipefail

ENDPOINT="${1:-user-prompt}"
HOOK_INPUT=$(cat 2>/dev/null || true)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Codex may launch hooks with a narrower PATH than the interactive shell that
# started the app server. Resolve the JavaScript runtime once from an explicit
# override, the hook PATH, or the standard per-user/system install locations.
# The hook remains fail-closed when no executable runtime can be found.
statewright_resolve_node() {
  local candidate
  for candidate in \
    "${STATEWRIGHT_NODE_BIN:-}" \
    "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "${HOME}/.volta/bin/node" \
    "${HOME}/.asdf/shims/node" \
    "${HOME}/.local/share/mise/shims/node" \
    "${HOME}/.local/bin/node"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && [ ! -d "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

STATEWRIGHT_NODE_RUNTIME=$(statewright_resolve_node || true)

# Executor-owned runs must use the authenticated loopback bridge before any
# standalone bootstrap, credential lookup, cache mutation, or telemetry setup.
if [ -n "${STATEWRIGHT_ADAPTER_URL:-}" ]; then
  EXECUTOR_HOOK="${SCRIPT_DIR}/scripts/executor-hook.mjs"
  if [ -n "$STATEWRIGHT_NODE_RUNTIME" ] && [ -f "$EXECUTOR_HOOK" ]; then
    printf '%s' "$HOOK_INPUT" | "$STATEWRIGHT_NODE_RUNTIME" "$EXECUTOR_HOOK" "$ENDPOINT"
    exit $?
  fi
  case "$ENDPOINT" in
    pre-tool)
      echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Statewright executor hook is unavailable."}}'
      ;;
    post-tool)
      echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Statewright executor hook is unavailable. Stop before issuing another tool call."}}'
      ;;
    *)
      echo '{"decision":"block","reason":"Statewright executor hook is unavailable."}'
      ;;
  esac
  exit 0
fi

# jq is required for JSON processing — prompt install if missing
if ! command -v jq &>/dev/null; then
  if [ "$ENDPOINT" = "user-prompt" ]; then
    INSTALL_CMD="brew install jq"
    command -v apt-get &>/dev/null && INSTALL_CMD="sudo apt-get install -y jq"
    command -v apk &>/dev/null && INSTALL_CMD="apk add jq"
    echo "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"Statewright requires jq (JSON processor) but it is not installed. Install it by running: ${INSTALL_CMD}\"}}"
  fi
  exit 0
fi

STATEWRIGHT_DIR="${HOME}/.statewright"
API_KEY="${STATEWRIGHT_API_KEY:-$(cat "$STATEWRIGHT_DIR/api_key" 2>/dev/null || true)}"
API_KEY="${API_KEY%"${API_KEY##*[![:space:]]}"}"  # trim trailing whitespace/newlines
GW_URL="${STATEWRIGHT_GATEWAY_URL:-https://mcp.statewright.ai}"
PB_URL="${STATEWRIGHT_PB_URL:-https://statewright.ai}"
LOCAL_TELEMETRY_URL="${STATEWRIGHT_LOCAL_TELEMETRY_URL:-http://127.0.0.1:${STATEWRIGHT_TELEMETRY_PORT:-4318}}"
TELEMETRY_AGENT="${SCRIPT_DIR}/scripts/local-telemetry-agent.mjs"
TELEMETRY_DIR="${STATEWRIGHT_TELEMETRY_DIR:-${HOME}/.statewright/telemetry/native-codex}"
# shellcheck source=tool-policy.sh
source "${SCRIPT_DIR}/tool-policy.sh"
# shellcheck source=client-id.sh
source "${SCRIPT_DIR}/client-id.sh"

# Thread identity is durable across resumed Codex turns. `session_id` may be a
# turn-local hook invocation, so use it only for older hosts that omit a thread.
HOOK_SESSION=$(echo "$HOOK_INPUT" | jq -r '.thread_id // .session_id // empty' 2>/dev/null || true)
CLIENT_ID=$(statewright_client_id codex "$HOOK_SESSION")
if [ "$ENDPOINT" = "user-prompt" ]; then
  statewright_register_codex_root_session "$HOOK_SESSION" "$CLIENT_ID"
fi
SESSION_KEY="${CLIENT_ID#swc_}"
SESSION_KEY="${SESSION_KEY:0:16}"
PROJECT_DIR="$STATEWRIGHT_DIR/sessions/$SESSION_KEY"
ACTIVE_FILE="$PROJECT_DIR/.active"
CACHE_FILE="$PROJECT_DIR/.state_cache"
GATEWAY_UNAVAILABLE_FILE="$PROJECT_DIR/.gateway_unavailable"
SESSION_HEADER_ARGS=(-H "X-Statewright-Client-Id: ${CLIENT_ID}")
if [ -n "${STATEWRIGHT_MCP_SESSION_ID:-}" ]; then
  SESSION_HEADER_ARGS+=(-H "Mcp-Session-Id: ${STATEWRIGHT_MCP_SESSION_ID}")
fi

# --- Auto-bootstrap settings.json + MCP config ---
SETTINGS="$HOME/.claude/settings.json"
MCP_CONFIG="$HOME/.claude/.mcp.json"
NEEDS_BOOTSTRAP=false

# Check hooks + MCP permission
if [ ! -f "$SETTINGS" ] || ! grep -q "mcp__plugin_statewright_statewright" "$SETTINGS" 2>/dev/null; then
  NEEDS_BOOTSTRAP=true
fi

# Check MCP config (only if key exists)
if [ -n "$API_KEY" ] && { [ ! -f "$MCP_CONFIG" ] || ! grep -q "statewright" "$MCP_CONFIG" 2>/dev/null; }; then
  NEEDS_BOOTSTRAP=true
fi

if [ "$NEEDS_BOOTSTRAP" = true ]; then
  SETUP=$(find "$HOME/.claude/plugins/cache" -path "*/statewright*/setup.sh" -type f 2>/dev/null | head -1)
  if [ -n "$SETUP" ]; then
    bash "$SETUP" >/dev/null 2>&1
  fi
fi

# --- Helpers: call the configured local MCP gateway ---
# Keep the JSON-RPC envelope until the caller has established whether a reply
# is an authoritative active state, an explicit inactive state, or a transport
# failure.  Flattening it here used to turn all three into the same empty text.
mcp_raw_call() {
  local response
  response=$(printf '%s' "$1" | curl -sf --max-time 5 -X POST "$GW_URL/" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $API_KEY" \
    "${SESSION_HEADER_ARGS[@]}" \
    --data-binary @- 2>/dev/null) || return 0
  printf '%s' "$response"
}

mcp_call() {
  mcp_raw_call "$1" | jq -r '.result.content[0].text // empty' 2>/dev/null || true
}

# Only the locally installed Statewright MCP server owns this hook's local
# enforcement state.  Connector/server names are part of the trust boundary:
# mcp__codex_apps__statewright_staging_* is deliberately not a local control
# tool even though it contains the same operation names.
is_local_statewright_tool() {
  case "$1" in
    mcp__statewright__statewright_*|mcp__plugin_statewright_statewright__statewright_*) return 0 ;;
    *) return 1 ;;
  esac
}

is_valid_state_snapshot() {
  printf '%s' "$1" | jq -e '
    type == "object"
    and (.state | type == "string" and length > 0)
    and (if has("workflow") then (.workflow | type == "string" and length > 0) else true end)
    and (if has("run_id") then (.run_id | type == "string" and length > 0) else true end)
    and (if has("run_session_id") then (.run_session_id | type == "string" and length > 0) else true end)
    and (if has("is_final") then (.is_final | type == "boolean") else true end)
    and (if has("allowed_tools") and .allowed_tools != null then (.allowed_tools | type == "array" and all(.[]; type == "string" and length > 0)) else true end)
    and (if has("disallowed_tools") and .disallowed_tools != null then (.disallowed_tools | type == "array" and all(.[]; type == "string" and length > 0)) else true end)
    and (if has("transitions") and .transitions != null then (.transitions | type == "array" and all(.[]; type == "object" and (.event | type == "string" and length > 0) and (.target | type == "string" and length > 0))) else true end)
    and (if has("context") and .context != null then (.context | type == "object") else true end)
    and (if (.context? | type) == "object" and (.context | has("tool_policy_mode")) then (.context.tool_policy_mode == null or (.context.tool_policy_mode | type == "string")) else true end)
    and (if has("tool_policy_mode") and .tool_policy_mode != null then (.tool_policy_mode | type == "string") else true end)
  ' >/dev/null 2>&1
}

is_valid_cached_state() {
  is_valid_state_snapshot "$1" || return 1
  printf '%s' "$1" | jq -e '
    (.allowed_tools == null or (.allowed_tools | type) == "array")
    and (.disallowed_tools == null or (.disallowed_tools | type) == "array")
    and (.transitions == null or (.transitions | type) == "array")
  ' >/dev/null 2>&1
}

local_statewright_action() {
  case "$1" in
    mcp__statewright__statewright_start|mcp__plugin_statewright_statewright__statewright_start|mcp__statewright__statewright_load_workflow|mcp__plugin_statewright_statewright__statewright_load_workflow) printf 'start' ;;
    mcp__statewright__statewright_stop|mcp__plugin_statewright_statewright__statewright_stop|mcp__statewright__statewright_deactivate|mcp__plugin_statewright_statewright__statewright_deactivate|mcp__statewright__statewright_pause|mcp__plugin_statewright_statewright__statewright_pause) printf 'stop' ;;
    mcp__statewright__statewright_transition|mcp__plugin_statewright_statewright__statewright_transition|mcp__statewright__statewright_force_state|mcp__plugin_statewright_statewright__statewright_force_state) printf 'transition' ;;
    mcp__statewright__statewright_get_state|mcp__plugin_statewright_statewright__statewright_get_state) printf 'refresh_cache' ;;
  esac
}

tool_response_is_error() {
  printf '%s' "$1" | jq -e '
    type == "object" and (
      .isError == true or .error != null or .result?.isError == true or .result?.error != null
    )
  ' >/dev/null 2>&1
}

managed_root_is_owned() {
  local registration="${STATEWRIGHT_ROUTE_CONTROL_DIR:-}/codex-root-session.json"
  [ -n "${STATEWRIGHT_ROUTE_CONTROL_DIR:-}" ] || return 0
  [ -e "$registration" ] || return 0
  jq -e --arg session_id "$HOOK_SESSION" --arg client_id "$CLIENT_ID" '
    .version == 1 and .session_id == $session_id and .client_id == $client_id
  ' "$registration" >/dev/null 2>&1
}

state_matches_local_binding() {
  local state_json="$1" local_run local_session state_run state_session cached_run cached_session active_run active_session
  if [ -f "$ACTIVE_FILE" ] && ! jq -e --arg client_id "$CLIENT_ID" --arg thread_id "$HOOK_SESSION" '
    if has("version") then
      .version == 1 and .client_id == $client_id and .thread_id == $thread_id
      and (if has("run_id") then (.run_id | type == "string" and length > 0) else true end)
      and (if has("run_session_id") then (.run_session_id | type == "string" and length > 0) else true end)
    else
      type == "object" and (.activated | type == "string" and length > 0)
    end
  ' "$ACTIVE_FILE" >/dev/null 2>&1; then
    return 1
  fi
  active_run=$(jq -r '.run_id // empty' "$ACTIVE_FILE" 2>/dev/null || true)
  active_session=$(jq -r '.run_session_id // empty' "$ACTIVE_FILE" 2>/dev/null || true)
  state_run=$(printf '%s' "$state_json" | jq -r '.run_id // empty' 2>/dev/null || true)
  state_session=$(printf '%s' "$state_json" | jq -r '.run_session_id // empty' 2>/dev/null || true)
  if [ -n "$active_run" ] && { [ -z "$state_run" ] || [ "$state_run" != "$active_run" ]; }; then
    return 1
  fi
  if [ -n "$active_session" ] && { [ -z "$state_session" ] || [ "$state_session" != "$active_session" ]; }; then
    return 1
  fi
  local_run=$(cat "$PROJECT_DIR/.run_id" 2>/dev/null || true)
  if [ -z "$local_run" ] && [ -f "$CACHE_FILE" ] && is_valid_cached_state "$(cat "$CACHE_FILE")"; then
    cached_run=$(jq -r '.run_id // empty' "$CACHE_FILE" 2>/dev/null || true)
    local_run="$cached_run"
  fi
  if [ -n "$local_run" ] && { [ -z "$state_run" ] || [ "$state_run" != "$local_run" ]; }; then
    return 1
  fi
  local_session=$(cat "$PROJECT_DIR/.run_session_id" 2>/dev/null || true)
  if [ -z "$local_session" ] && [ -f "$CACHE_FILE" ] && is_valid_cached_state "$(cat "$CACHE_FILE")"; then
    cached_session=$(jq -r '.run_session_id // empty' "$CACHE_FILE" 2>/dev/null || true)
    local_session="$cached_session"
  fi
  if [ -n "$local_session" ] && { [ -z "$state_session" ] || [ "$state_session" != "$local_session" ]; }; then
    return 1
  fi
  return 0
}

# Emit a compact typed result.  Inactive is intentionally narrow: the exact
# gateway no-active result must be corroborated by status from the same local
# endpoint and client/session headers.  Everything else fails closed.
fetch_local_state() {
  local state_raw state_text status_raw status_text state_json
  state_raw=$(mcp_raw_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}')
  state_text=$(printf '%s' "$state_raw" | jq -r '
    if .jsonrpc == "2.0" and .id == 1 and (.error | not)
      and ((.result | type) == "object") and ((.result.isError // false) == false)
      and ((.result.content | type) == "array")
    then ([.result.content[]? | select(.type == "text") | .text | strings][0] // empty)
    else empty end
  ' 2>/dev/null || true)
  if managed_root_is_owned && [ -n "$state_text" ] && is_valid_state_snapshot "$state_text" && state_matches_local_binding "$state_text"; then
    state_json=$(printf '%s' "$state_text" | jq -c . 2>/dev/null || true)
    jq -cn --argjson state "$state_json" '{kind:"active",state:$state}'
    return 0
  fi

  if ! printf '%s' "$state_raw" | jq -e '
    .jsonrpc == "2.0" and .id == 1 and (.error | not)
    and (.result | type) == "object" and .result.isError == true
    and (.result.content | type) == "array" and (.result.content | length) == 1
    and .result.content[0] == {
      type:"text", text:"No active workflow. Load a workflow before requesting state."
    }
  ' >/dev/null 2>&1; then
    printf '%s\n' '{"kind":"unavailable"}'
    return 0
  fi

  status_raw=$(mcp_raw_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_status","arguments":{}},"id":1}')
  status_text=$(printf '%s' "$status_raw" | jq -r '
    if .jsonrpc == "2.0" and .id == 1 and (.error | not)
      and ((.result | type) == "object") and ((.result.isError // false) == false)
      and ((.result.content | type) == "array")
    then ([.result.content[]? | select(.type == "text") | .text | strings][0] // empty)
    else empty end
  ' 2>/dev/null || true)
  if managed_root_is_owned && printf '%s' "$status_text" | jq -e '
    type == "object" and has("active_workflow") and has("current_state")
    and .active_workflow == null and .current_state == null
  ' >/dev/null 2>&1; then
    printf '%s\n' '{"kind":"inactive"}'
  else
    printf '%s\n' '{"kind":"unavailable"}'
  fi
}

statewright_tools_label() {
  local state_json="$1"
  local policy_mode allowed disallowed
  policy_mode=$(printf '%s' "$state_json" | jq -r '.context.tool_policy_mode // .tool_policy_mode // empty' 2>/dev/null || true)
  allowed=$(printf '%s' "$state_json" | jq -r '.allowed_tools // [] | join(", ")' 2>/dev/null || true)
  disallowed=$(printf '%s' "$state_json" | jq -r '.disallowed_tools // [] | join(", ")' 2>/dev/null || true)
  if statewright_policy_mode_is_denylist "$policy_mode"; then
    printf 'unrestricted except explicit blocks: %s' "${disallowed:-(none)}"
  elif [ -n "$allowed" ]; then
    printf '%s' "$allowed"
  else
    printf 'unrestricted'
  fi
}

statewright_command_supports_local_evidence() {
  local command="$1"
  [[ "$command" =~ ^[[:space:]]*(task|npm|pnpm|npx|vitest)([[:space:]]|$) ]]
}

adapter_pre_tool_call() {
  local tool_name="$1"
  local tool_input request command_evidence evidence_request evidence_reason command
  tool_input=$(printf '%s' "$HOOK_INPUT" | jq -c '
    (.tool_input // .input // {}) as $input
    | if ($input | type) == "object" then $input else {} end
  ' 2>/dev/null || true)
  [ -n "$tool_input" ] || tool_input='{}'
  command_evidence=null
  evidence_reason="node_runtime_unavailable"
  if [ -n "$STATEWRIGHT_NODE_RUNTIME" ] && [ -f "${SCRIPT_DIR}/scripts/lib/command-evidence.mjs" ]; then
    evidence_reason="collector_returned_null"
    evidence_request=$(jq -cn --arg tool_name "$tool_name" --arg cwd "$PWD" \
      --argjson tool_input "$tool_input" '{tool_name:$tool_name,cwd:$cwd,tool_input:$tool_input}')
    command_evidence=$(printf '%s' "$evidence_request" | "$STATEWRIGHT_NODE_RUNTIME" "${SCRIPT_DIR}/scripts/lib/command-evidence.mjs" 2>/dev/null) || command_evidence=null
    printf '%s' "$command_evidence" | jq -e 'type == "object" or type == "null"' >/dev/null 2>&1 || command_evidence=null
  elif [ -n "$STATEWRIGHT_NODE_RUNTIME" ]; then
    evidence_reason="collector_missing"
  fi
  # Preserve a redacted, typed failure signal for command families that the
  # gateway can structurally expand. This keeps an unavailable local runtime
  # distinguishable from an ordinary semantic-classifier denial without
  # weakening the fail-closed decision.
  if [ "$command_evidence" = "null" ] && statewright_is_shell_tool "$tool_name"; then
    command=$(printf '%s' "$tool_input" | jq -r '.command // .cmd // empty' 2>/dev/null || true)
    if statewright_command_supports_local_evidence "$command"; then
      command_evidence=$(jq -cn \
        --arg schema "statewright/local-command-evidence/v1" \
        --arg tool_name "$tool_name" \
        --arg command "$command" \
        --arg cwd "$PWD" \
        --arg reason "$evidence_reason" \
        --argjson requested_cwd "$(printf '%s' "$tool_input" | jq -c '.workdir // .cwd // null')" \
        --argjson collected_at_ms "$(( $(date +%s) * 1000 ))" \
        '{schema:$schema,tool_name:$tool_name,command:$command,requested_cwd:$requested_cwd,
          cwd:$cwd,collected_at_ms:$collected_at_ms,complete:false,commands:[],files:[],reason:$reason}')
    fi
  fi
  request=$(jq -cn \
    --arg tool_name "$tool_name" \
    --argjson tool_input "$tool_input" \
    --argjson command_evidence "$command_evidence" \
    '{jsonrpc:"2.0",method:"tools/call",params:{name:"statewright_adapter_pre_tool",arguments:({tool_name:$tool_name,tool_input:$tool_input} + (if $command_evidence == null then {} else {command_evidence:$command_evidence} end))},id:1}')
  mcp_call "$request"
}

# Codex has emitted MCP results as a raw text value, a ContentBlock array, and
# a {content:[ContentBlock]} envelope. Normalize those transport forms before
# interpreting Statewright's JSON payload.
extract_mcp_result_text() {
  local response="$1"
  [ -n "$response" ] || return 0
  printf '%s' "$response" | jq -r '
    def first_text:
      [ .[]? | select(.type? == "text") | .text? | strings ][0] // empty;
    def result_value:
      if type == "string" then . else tojson end;
    if type == "string" then .
    elif type == "array" then first_text
    elif type == "object" then
      if .structuredContent? != null then (.structuredContent | result_value)
      elif .result?.structuredContent? != null then (.result.structuredContent | result_value)
      elif (.content? | type) == "array" then (.content | first_text)
      elif (.result?.content? | type) == "array" then (.result.content | first_text)
      elif (.text? | type) == "string" then .text
      else tojson
      end
    else empty
    end
  ' 2>/dev/null || true
}

# Emit sanitized native-hook telemetry for an already-authoritative workflow
# state. Hooks do not receive provider token counts, so those remain explicitly
# unavailable; tool-result byte and token estimates are kept separate.
emit_native_telemetry() {
  local event_type="$1"
  local state_json="$2"
  local run_id state epoch seq event_id timestamp effective_at model tool_bytes tool_count current_tool_bytes
  local prior_bytes prior_count is_tool=false payload session_id conversation_id child_id run_session_id
  local binding_payload propagate_children=false capture_output=false

  [ -z "$API_KEY" ] && return 0
  [ -z "$state_json" ] && return 0
  run_id=$(echo "$state_json" | jq -r '.run_id // empty' 2>/dev/null || true)
  run_session_id=$(echo "$state_json" | jq -r '.run_session_id // empty' 2>/dev/null || true)
  state=$(echo "$state_json" | jq -r '.state // empty' 2>/dev/null || true)
  [ -z "$run_id" ] || [ -z "$state" ] && return 0

  session_id="${HOOK_SESSION:-$SESSION_KEY}"
  child_id=$(echo "$HOOK_INPUT" | jq -r '.subagent.agent_id // empty' 2>/dev/null || true)
  conversation_id="${child_id:-$session_id}"
  if [ -z "$child_id" ]; then
    case "$event_type" in
      workflow_loaded|state_boundary|workflow_completed) propagate_children=true ;;
    esac
  fi
  epoch=$(cat "$PROJECT_DIR/.state_epoch" 2>/dev/null || echo "1")
  case "$epoch" in ''|*[!0-9]*) epoch=1 ;; esac

  prior_bytes=$(cat "$PROJECT_DIR/.telemetry_tool_bytes" 2>/dev/null || echo "0")
  prior_count=$(cat "$PROJECT_DIR/.telemetry_tool_count" 2>/dev/null || echo "0")
  case "$prior_bytes" in ''|*[!0-9]*) prior_bytes=0 ;; esac
  case "$prior_count" in ''|*[!0-9]*) prior_count=0 ;; esac
  tool_bytes="$prior_bytes"
  tool_count="$prior_count"
  current_tool_bytes=0

  if [ "$event_type" = "tool_observed" ]; then
    is_tool=true
    current_tool_bytes=$(printf '%s' "$TOOL_RESULT" | wc -c | tr -d ' ')
    tool_bytes=$((prior_bytes + current_tool_bytes))
    tool_count=$((prior_count + 1))
    echo "$tool_bytes" > "$PROJECT_DIR/.telemetry_tool_bytes"
    echo "$tool_count" > "$PROJECT_DIR/.telemetry_tool_count"
  fi

  seq=$(cat "$PROJECT_DIR/.telemetry_seq" 2>/dev/null || echo "0")
  case "$seq" in ''|*[!0-9]*) seq=0 ;; esac
  seq=$((seq + 1))
  echo "$seq" > "$PROJECT_DIR/.telemetry_seq"
  event_id=$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
  [ -z "$event_id" ] && event_id=$(printf '%s' "${session_id}:${seq}:$(date -u +%s%N)" | shasum -a 256 | cut -c1-32)
  timestamp=""
  if [ -n "$STATEWRIGHT_NODE_RUNTIME" ]; then
    timestamp=$("$STATEWRIGHT_NODE_RUNTIME" -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || true)
  fi
  [ -z "$timestamp" ] && timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  effective_at=$(cat "$PROJECT_DIR/.state_effective_at" 2>/dev/null || true)
  [ -z "$effective_at" ] && effective_at="$timestamp"
  model=$(echo "$HOOK_INPUT" | jq -r '.model // empty' 2>/dev/null || true)
  [ "$(echo "$state_json" | jq -r '.capture_output // false' 2>/dev/null || true)" = "true" ] && capture_output=true

  binding_payload=$(jq -n \
    --arg conversation_id "$conversation_id" \
    --arg root_session_id "$session_id" \
    --arg run_id "$run_id" \
    --arg run_session_id "$run_session_id" \
    --arg workflow "$(echo "$state_json" | jq -r '.workflow // empty' 2>/dev/null || true)" \
    --arg state "$state" \
    --arg effective_at "$effective_at" \
    --argjson state_epoch "$epoch" \
    --argjson capture_output "$capture_output" \
    --argjson propagate_children "$propagate_children" \
    '{
      conversation_id: $conversation_id,
      root_session_id: $root_session_id,
      run_id: $run_id,
      run_session_id: $run_session_id,
      workflow: $workflow,
      state: $state,
      state_epoch: $state_epoch,
      capture_output: $capture_output,
      effective_at: $effective_at,
      propagate_children: $propagate_children
    }')
  if ! curl -sf --max-time 1 -X POST "$LOCAL_TELEMETRY_URL/v1/state-bindings" \
    -H 'Content-Type: application/json' \
    -d "$binding_payload" >/dev/null 2>&1; then
    if [ -z "$STATEWRIGHT_NODE_RUNTIME" ] || ! printf '%s' "$binding_payload" | \
      STATEWRIGHT_TELEMETRY_DIR="$TELEMETRY_DIR" \
      STATEWRIGHT_API_KEY="$API_KEY" \
      "$STATEWRIGHT_NODE_RUNTIME" "$TELEMETRY_AGENT" --bind-stdin >/dev/null 2>&1; then
      echo "[statewright] failed to durably record workflow token binding" >&2
    fi
  fi

  payload=$(jq -n \
    --arg event_id "$event_id" \
    --arg run_id "$run_id" \
    --arg run_session_id "$run_session_id" \
    --arg session_id "$conversation_id" \
    --arg root_session_id "$session_id" \
    --arg workflow "$(echo "$state_json" | jq -r '.workflow // empty' 2>/dev/null || true)" \
    --arg event_type "$event_type" \
    --arg state "$state" \
    --arg model "$model" \
    --arg tool_name "$TOOL_NAME" \
    --arg timestamp "$timestamp" \
    --argjson sequence "$seq" \
    --argjson epoch "$epoch" \
    --argjson tool_bytes "$tool_bytes" \
    --argjson tool_count "$tool_count" \
    '{events: [{
      event_id: $event_id,
      run_id: $run_id,
      run_session_id: $run_session_id,
      thread_id: $session_id,
      provider_session_id: $session_id,
      root_session_id: $root_session_id,
      workflow: $workflow,
      event: $event_type,
      state: $state,
      provider: "codex",
      source: "native_codex_hook",
      binding_status: "bound",
      model: $model,
      precision: "unavailable",
      timestamp: $timestamp,
      sequence: $sequence,
      state_budget: {
        state: $state,
        state_epoch: $epoch,
        provider: "codex",
        model: $model,
        precision: "unavailable",
        tool_result_bytes: $tool_bytes,
        estimated_tool_output_tokens: ($tool_bytes / 4 | floor),
        tool_result_count: $tool_count
      }
    }]}' \
  )
  [ -z "$payload" ] && return 0
  if [ "$is_tool" = "true" ]; then
    payload=$(echo "$payload" | jq \
      --arg invocation_id "$event_id" \
      --arg tool_name "$TOOL_NAME" \
      --argjson result_bytes "$current_tool_bytes" \
      '.events[0].tool = {
        invocation_id: $invocation_id,
        tool: $tool_name,
        tool_type: "native_codex",
        result_bytes: $result_bytes,
        estimated_input_tokens: ($result_bytes / 4 | floor),
        is_error: false
      }')
  fi
  curl -sf --max-time 2 -X POST "$PB_URL/api/gateway/telemetry/events" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $API_KEY" \
    -d "$payload" >/dev/null 2>&1 || true
}

# A Statewright-owned interactive supervisor watches this directory. The hook
# never kills Codex itself; it only persists the authoritative next route.
request_interactive_route_restart() {
  local state_json="$1"
  local restore_original="${2:-false}"
  local control_dir model effort service_tier model_ladder request_path root_session_id registration
  control_dir="${STATEWRIGHT_ROUTE_CONTROL_DIR:-}"
  [ -n "$control_dir" ] || return 0
  # One-shot Codex children may inherit a managed parent's route directory when
  # a login shell resolves the real binary ahead of the Statewright shim. They
  # may report telemetry, but must never ask the parent TUI supervisor to adopt
  # their ephemeral thread as its restart target.
  statewright_codex_one_shot_ancestor && return 0
  registration="$control_dir/codex-root-session.json"
  [ -r "$registration" ] || return 0
  root_session_id=$(jq -r --arg client_id "$CLIENT_ID" \
    'if .version == 1 and .client_id == $client_id and (.session_id | type) == "string" then .session_id else empty end' \
    "$registration" 2>/dev/null || true)
  [ -n "$root_session_id" ] && [ "$HOOK_SESSION" = "$root_session_id" ] || return 0
  if [ "$restore_original" = "true" ]; then
    model=""
    effort=""
    service_tier=""
    model_ladder='[]'
  else
    model=$(echo "$state_json" | jq -r '.model // empty' 2>/dev/null || true)
    effort=$(echo "$state_json" | jq -r '.thinking_level // empty' 2>/dev/null || true)
    service_tier=$(echo "$state_json" | jq -r '.env_overrides.STATEWRIGHT_CODEX_SERVICE_TIER // empty' 2>/dev/null || true)
    model_ladder=$(echo "$state_json" | jq -c 'if (.model_ladder | type) == "array" then .model_ladder else [] end' 2>/dev/null || echo '[]')
  fi
  mkdir -p "$control_dir" || return 0
  # A thread has one authoritative next route. State transitions in the same
  # turn supersede earlier boundaries instead of accumulating replayable work.
  request_path="$control_dir/current.route.json"
  jq -n \
    --arg session_id "$HOOK_SESSION" \
    --arg turn_id "$(echo "$HOOK_INPUT" | jq -r '.turn_id // empty' 2>/dev/null || true)" \
    --arg root_session_id "$root_session_id" \
    --arg client_id "$CLIENT_ID" \
    --arg run_id "$(echo "$state_json" | jq -r '.run_id // empty' 2>/dev/null || true)" \
    --arg state "$(echo "$state_json" | jq -r '.state // empty' 2>/dev/null || true)" \
    --arg model "$model" \
    --arg effort "$effort" \
    --arg service_tier "$service_tier" \
    --argjson restore_original "$restore_original" \
    --argjson model_ladder "$model_ladder" \
    '{session_id: $session_id, root_session_id: $root_session_id, client_id: $client_id, run_id: $run_id, state: $state, model: $model, effort: $effort, model_ladder: $model_ladder}
      + (if $service_tier != "" then {service_tier: $service_tier} else {} end)
      + (if $restore_original then {restore_original: true} else {} end)
      + (if $turn_id != "" then {turn_id: $turn_id} else {} end)' \
    > "$request_path.$$.tmp" && mv "$request_path.$$.tmp" "$request_path"
}

clear_interactive_route_requests() {
  local control_dir registration root_session_id path route_owner route_session
  control_dir="${STATEWRIGHT_ROUTE_CONTROL_DIR:-}"
  [ -n "$control_dir" ] || return 0
  registration="$control_dir/codex-root-session.json"
  [ -r "$registration" ] || return 0
  root_session_id=$(jq -r --arg client_id "$CLIENT_ID" \
    'if .version == 1 and .client_id == $client_id and (.session_id | type) == "string" then .session_id else empty end' \
    "$registration" 2>/dev/null || true)
  [ -n "$root_session_id" ] || return 0
  while IFS= read -r path; do
    route_owner=$(jq -r '.client_id // empty' "$path" 2>/dev/null || true)
    route_session=$(jq -r '.session_id // empty' "$path" 2>/dev/null || true)
    if [ "$route_owner" = "$CLIENT_ID" ] && [ "$route_session" = "$root_session_id" ]; then
      rm -f -- "$path"
    fi
  done < <(find "$control_dir" -maxdepth 1 -type f -name '*.route.json' -print 2>/dev/null)
}

# This is normal lifecycle cleanup, not a recovery shortcut: it is bounded to
# the current derived thread directory and is called only after a confirmed
# local terminal/inactive result or a successful local deactivate response.
clear_local_enforcement_state() {
  local clear_routes="${1:-true}"
  managed_root_is_owned || return 1
  [ "$clear_routes" = "true" ] && clear_interactive_route_requests
  rm -f "$ACTIVE_FILE" "$CACHE_FILE" "$GATEWAY_UNAVAILABLE_FILE" \
    "$PROJECT_DIR/.session_hinted" "$PROJECT_DIR/.discovered_commands" \
    "$PROJECT_DIR/.capture_enabled" "$PROJECT_DIR/.run_id" \
    "$PROJECT_DIR/.run_session_id" \
    "$PROJECT_DIR/.log_seq" "$PROJECT_DIR/.telemetry_seq" \
    "$PROJECT_DIR/.state_epoch" "$PROJECT_DIR/.state_effective_at" \
    "$PROJECT_DIR/.telemetry_tool_bytes" "$PROJECT_DIR/.telemetry_tool_count" \
    "$PROJECT_DIR/.stop_progress" "$PROJECT_DIR/.stop_nudges"
}

reset_native_telemetry_state() {
  local epoch="$1"
  local effective_at
  effective_at=""
  if [ -n "$STATEWRIGHT_NODE_RUNTIME" ]; then
    effective_at=$("$STATEWRIGHT_NODE_RUNTIME" -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || true)
  fi
  [ -z "$effective_at" ] && effective_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "$epoch" > "$PROJECT_DIR/.state_epoch"
  echo "$effective_at" > "$PROJECT_DIR/.state_effective_at"
  echo "0" > "$PROJECT_DIR/.telemetry_tool_bytes"
  echo "0" > "$PROJECT_DIR/.telemetry_tool_count"
  reset_stop_continuation_state
}

# Stop continuation is local policy, deliberately independent of telemetry and
# gateway availability. A state transition resets the policy epoch; ordinary
# tools advance liveness without granting an unbounded Stop loop.
reset_stop_continuation_state() {
  echo "0" > "$PROJECT_DIR/.stop_progress"
  rm -f "$PROJECT_DIR/.stop_nudges"
}

record_stop_progress() {
  local progress
  progress=$(cat "$PROJECT_DIR/.stop_progress" 2>/dev/null || echo "0")
  case "$progress" in ''|*[!0-9]*) progress=0 ;; esac
  echo $((progress + 1)) > "$PROJECT_DIR/.stop_progress"
}

allow_stop_nudge() {
  local state_json="$1" run_id local_run_id epoch progress prior_run prior_epoch prior_progress prior_nudges nudges
  run_id=$(echo "$state_json" | jq -r '.run_id // empty' 2>/dev/null || true)
  local_run_id=$(cat "$PROJECT_DIR/.run_id" 2>/dev/null || true)
  [ -n "$run_id" ] && [ -n "$local_run_id" ] && [ "$run_id" != "$local_run_id" ] && return 1
  epoch=$(cat "$PROJECT_DIR/.state_epoch" 2>/dev/null || echo "1")
  progress=$(cat "$PROJECT_DIR/.stop_progress" 2>/dev/null || echo "0")
  case "$epoch" in ''|*[!0-9]*) epoch=1 ;; esac
  case "$progress" in ''|*[!0-9]*) progress=0 ;; esac
  if [ -f "$PROJECT_DIR/.stop_nudges" ]; then
    IFS='|' read -r prior_run prior_epoch prior_progress prior_nudges < "$PROJECT_DIR/.stop_nudges" || true
  fi
  if [ "$prior_run" = "$run_id" ] && [ "$prior_epoch" = "$epoch" ]; then
    [ "$prior_progress" = "$progress" ] && return 1
    case "$prior_nudges" in ''|*[!0-9]*) prior_nudges=0 ;; esac
    [ "$prior_nudges" -ge 3 ] && return 1
    nudges=$((prior_nudges + 1))
  else
    nudges=1
  fi
  printf '%s|%s|%s|%s\n' "$run_id" "$epoch" "$progress" "$nudges" > "$PROJECT_DIR/.stop_nudges"
  return 0
}

# ============================================================
# HOOK HANDLERS
# ============================================================

case "$ENDPOINT" in
  user-prompt)
    # --- Plugin update check (once per session) ---
    if [ ! -f "$STATEWRIGHT_DIR/.update_checked" ]; then
      mkdir -p "$STATEWRIGHT_DIR"
      touch "$STATEWRIGHT_DIR/.update_checked"
      LOCAL_VER=$(jq -r '.version // "0.0.0"' "$(dirname "$0")/plugin.json" 2>/dev/null || echo "0.0.0")
      REMOTE_VER=$(curl -sf --max-time 3 "https://raw.githubusercontent.com/statewright/statewright/main/plugins/claude-code/plugin.json" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)
      if [ -n "$REMOTE_VER" ] && [ "$LOCAL_VER" != "$REMOTE_VER" ]; then
        echo "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"Statewright plugin update available: v${LOCAL_VER} → v${REMOTE_VER}. Run: /plugin install statewright to update.\"}}"
      fi
    fi

    # --- No local .active: dormant (no cross-session leak from gateway) ---
    if [ ! -f "$ACTIVE_FILE" ]; then
      HINT_FILE="$PROJECT_DIR/.session_hinted"
      if [ ! -f "$HINT_FILE" ]; then
        mkdir -p "$PROJECT_DIR"
        touch "$HINT_FILE"
        echo "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"Statewright plugin active. No workflow running. Call statewright_list_workflows first, then load only an exact workflow explicitly selected by the user or governing skill. Never guess a workflow name from the task.\"}}"
      fi
      exit 0
    fi

    # --- Active workflow: fetch typed state from the local gateway ---
    FETCHED_STATE=$(fetch_local_state)
    FETCH_KIND=$(printf '%s' "$FETCHED_STATE" | jq -r '.kind // "unavailable"' 2>/dev/null || true)
    if [ "$FETCH_KIND" = "inactive" ]; then
      if clear_local_enforcement_state; then
        echo '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[statewright] Local gateway confirms no active workflow. Stale local enforcement was reconciled for this thread."}}'
      else
        touch "$GATEWAY_UNAVAILABLE_FILE"
        echo '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Statewright ownership could not be reconciled. The active workflow remains fail-closed."}}'
      fi
      exit 0
    fi
    if [ "$FETCH_KIND" != "active" ]; then
      mkdir -p "$PROJECT_DIR"
      touch "$GATEWAY_UNAVAILABLE_FILE"
      echo '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Statewright gateway unreachable. The active workflow remains fail-closed until authoritative state is restored."}}'
      exit 0
    fi
    STATE_JSON=$(printf '%s' "$FETCHED_STATE" | jq -c '.state' 2>/dev/null || true)
    CURRENT=$(echo "$STATE_JSON" | jq -r '.state // empty' 2>/dev/null || true)
    rm -f "$GATEWAY_UNAVAILABLE_FILE"

    # Check for final state — auto-deactivate
    IS_FINAL=$(echo "$STATE_JSON" | jq -r '.is_final // false' 2>/dev/null || true)
    if [ "$IS_FINAL" = "true" ]; then
      if clear_local_enforcement_state false; then
        request_interactive_route_restart "$STATE_JSON" true
        echo "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"[statewright] Workflow complete. Final state: $CURRENT. Enforcement deactivated.\"}}"
      else
        touch "$GATEWAY_UNAVAILABLE_FILE"
        echo '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Statewright ownership could not be reconciled. The active workflow remains fail-closed."}}'
      fi
      exit 0
    fi

    # Write state cache for PreToolUse (zero-network enforcement)
    mkdir -p "$PROJECT_DIR"
    echo "$STATE_JSON" > "$CACHE_FILE"

    # Restore capture files if missing (get_state now includes run_id + capture_output)
    if [ ! -f "$PROJECT_DIR/.run_id" ]; then
      RUN_ID=$(echo "$STATE_JSON" | jq -r '.run_id // empty' 2>/dev/null || true)
      [ -n "$RUN_ID" ] && echo "$RUN_ID" > "$PROJECT_DIR/.run_id"
    fi
    if [ ! -f "$PROJECT_DIR/.capture_enabled" ]; then
      CAPTURE=$(echo "$STATE_JSON" | jq -r '.capture_output // false' 2>/dev/null || true)
      [ "$CAPTURE" = "true" ] && touch "$PROJECT_DIR/.capture_enabled"
    fi

    # Build context
    ITER=$(echo "$STATE_JSON" | jq -r '.iteration // 0' 2>/dev/null || true)
    MAX=$(echo "$STATE_JSON" | jq -r '.max_iterations // "none"' 2>/dev/null || true)
    TOOLS=$(statewright_tools_label "$STATE_JSON")
    INSTRUCTIONS=$(echo "$STATE_JSON" | jq -r '.instructions // empty' 2>/dev/null || true)
    TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event + " -> " + .target) | join(", ")' 2>/dev/null || true)

    BLOCKED_ENV=$(echo "$STATE_JSON" | jq -r '.blocked_env // [] | join(", ")' 2>/dev/null || true)
    ENV_OVERRIDES=$(echo "$STATE_JSON" | jq -r '.env_overrides // {} | to_entries | map(.key + "=" + .value) | join(", ")' 2>/dev/null || true)

    # Command discovery: detect Taskfile/Makefile and list available commands
    AVAILABLE_CMDS=""
    CMDS_FILE="$PROJECT_DIR/.discovered_commands"
    if [ ! -f "$CMDS_FILE" ]; then
      # Discover once per session
      if command -v task &>/dev/null && [ -f "Taskfile.yml" ] || [ -f "Taskfile.yaml" ] || [ -f "taskfile.yml" ]; then
        TASK_CMDS=$(task --list-all 2>/dev/null | grep '^\*' | awk '{print $2}' | sed 's/:$//' | head -30 | tr '\n' ', ' | sed 's/,$//')
        [ -n "$TASK_CMDS" ] && AVAILABLE_CMDS="Taskfile commands ($(basename "$(pwd)")): $TASK_CMDS"
      fi
      if [ -f "Makefile" ] || [ -f "makefile" ]; then
        MAKE_CMDS=$(make -pRrq 2>/dev/null | awk -F: '/^[a-zA-Z0-9][^$#\/\t=]*:([^=]|$)/ {split($1,a," ");print a[1]}' | sort -u | grep -v '^\.' | head -30 | tr '\n' ', ' | sed 's/,$//')
        [ -n "$MAKE_CMDS" ] && AVAILABLE_CMDS="${AVAILABLE_CMDS:+$AVAILABLE_CMDS. }Makefile targets ($(basename "$(pwd)")): $MAKE_CMDS"
      fi
      echo "$AVAILABLE_CMDS" > "$CMDS_FILE"
    else
      AVAILABLE_CMDS=$(cat "$CMDS_FILE")
    fi

    SM_CONTEXT=$(echo "$STATE_JSON" | jq -r '.context // {} | to_entries | map(.key + "=" + (.value | tostring)) | join(", ")' 2>/dev/null || true)
    GUARDS_INFO=$(echo "$STATE_JSON" | jq -r '.guards // {} | to_entries | map(.key + ": " + .value.field + " " + .value.op + " " + (.value.value | tostring)) | join("; ")' 2>/dev/null || true)

    CONTINUATION_STEER="CONTINUATION STEER: You are in autonomous mode. Continue taking state-allowed tool actions and transition through the workflow until a final completion or failure state. Do not send a final response, pause, summarize, or wait for user input at intermediate states."
    CONTEXT="Statewright workflow active. $CONTINUATION_STEER Phase: $CURRENT (iteration $ITER/$MAX). Tools: $TOOLS. MANDATORY: Every statewright_transition call MUST include data.rationale explaining WHY you are transitioning. Format: statewright_transition(event='EVENT', data={'rationale': 'specific reason', ...guard fields}). Available transitions: $TRANSITIONS. Execution preference: use one bounded native operation at a time (for example rg, git diff, or an explicit project task); avoid heredocs, inline interpreters, and compound blobs unless their execution intent is structurally necessary and authorized.${SM_CONTEXT:+ State context: $SM_CONTEXT.}${GUARDS_INFO:+ Guards: $GUARDS_INFO.}${BLOCKED_ENV:+ BLOCKED env vars (do not use): $BLOCKED_ENV.}${ENV_OVERRIDES:+ Use these env vars instead: $ENV_OVERRIDES.}${AVAILABLE_CMDS:+ PREFER these commands over raw shell: $AVAILABLE_CMDS.}${INSTRUCTIONS:+ Instructions: $INSTRUCTIONS.}"
    jq -n --arg ctx "$CONTEXT" '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":$ctx}}'
    exit 0
    ;;

  pre-tool)
    # --- No active workflow: allow everything (dormant) ---
    if [ ! -f "$ACTIVE_FILE" ]; then
      exit 0
    fi

    TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)

    DELEGATION_OPERATION="$TOOL_NAME"
    case "$DELEGATION_OPERATION" in
      mcp__*__*)
        DELEGATION_OPERATION=${DELEGATION_OPERATION#mcp__}
        DELEGATION_OPERATION=${DELEGATION_OPERATION#*__}
        ;;
    esac
    DELEGATION_KEY=$(printf '%s' "$DELEGATION_OPERATION" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]')
    RAW_DELEGATION=false
    case "$DELEGATION_KEY" in
      agent|spawnagent|*collaborationspawnagent) RAW_DELEGATION=true ;;
    esac

    # Always allow system/internal/MCP tools
    if [ "$RAW_DELEGATION" != "true" ]; then
      if is_local_statewright_tool "$TOOL_NAME"; then
        exit 0
      fi
      case "$TOOL_NAME" in
        create_goal|get_goal|update_goal|TodoRead|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskStop|TaskOutput|SendMessage|AskUserQuestion|ExitPlanMode|ToolSearch|Skill) exit 0 ;;
      esac
    fi

    if [ -f "$GATEWAY_UNAVAILABLE_FILE" ]; then
      jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Statewright gateway state is unavailable; the active workflow fails closed."}}'
      exit 0
    fi

    # Read cached state (written by UserPromptSubmit).
    if [ ! -f "$CACHE_FILE" ]; then
      jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Statewright state cache is unavailable; the active workflow fails closed."}}'
      exit 0
    fi

    STATE_JSON=$(cat "$CACHE_FILE")
    if ! is_valid_cached_state "$STATE_JSON"; then
      jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Statewright state cache is invalid; the active workflow fails closed."}}'
      exit 0
    fi
    if ! managed_root_is_owned || ! state_matches_local_binding "$STATE_JSON"; then
      touch "$GATEWAY_UNAVAILABLE_FILE"
      jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Statewright local ownership binding is invalid; the active workflow fails closed."}}'
      exit 0
    fi
    ALLOWED=$(echo "$STATE_JSON" | jq -r '.allowed_tools // [] | .[]' 2>/dev/null || true)
    DISALLOWED=$(echo "$STATE_JSON" | jq -r '.disallowed_tools // [] | .[]' 2>/dev/null || true)
    POLICY_MODE=$(echo "$STATE_JSON" | jq -r '.context.tool_policy_mode // .tool_policy_mode // empty' 2>/dev/null || true)
    CURRENT=$(echo "$STATE_JSON" | jq -r '.state // "unknown"' 2>/dev/null || true)
    TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event) | join(", ")' 2>/dev/null || true)

    STATEWRIGHT_ALLOWED_TOOLS="$ALLOWED"
    STATEWRIGHT_DISALLOWED_TOOLS="$DISALLOWED"
    STATEWRIGHT_TOOL_POLICY_MODE="$POLICY_MODE"

    # A provider-native child receives a fresh tool surface, so it cannot be
    # authorized as an ordinary tool call or by classifier approval. Ask the
    # provider-neutral gateway whether this should stay inline or bind to a
    # workflow-declared fork/subworkflow, then deny the raw spawn either way.
    if [ "$RAW_DELEGATION" = "true" ]; then
      ADAPTER_RESULT=$(adapter_pre_tool_call "$TOOL_NAME")
      if ! printf '%s' "$ADAPTER_RESULT" | jq -e '
        type == "object"
        and (.decision == "deny" or .decision == "block")
        and .risk_assessment.deterministic_source == "unmanaged_agent_delegation"
        and .delegation.schema == "statewright/managed-delegation/v1"
      ' >/dev/null 2>&1; then
        jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Statewright could not bind this raw delegated agent to the current workflow; continue inline."}}'
        exit 0
      fi
      DELEGATION_RECOMMENDATION=$(printf '%s' "$ADAPTER_RESULT" | jq -r '.delegation.recommendation // "continue_inline"')
      MANAGED_EVENTS=$(printf '%s' "$ADAPTER_RESULT" | jq -r ".delegation.managed_transition_candidates // [] | map(.event + \" (\" + .kind + \")\") | join(\", \")")
      if [ "$DELEGATION_RECOMMENDATION" = "statewright_managed_fork" ]; then
        if [ -n "$MANAGED_EVENTS" ]; then
          ADAPTER_DISPLAY="Statewright guard: denied · this delegated task requests a different model or reasoning route. Candidate workflow-managed child transitions: ${MANAGED_EVENTS}. Use one only when its declared child route matches the request; the child remains attached to the parent workflow evidence."
        else
          ADAPTER_DISPLAY="Statewright guard: denied · this delegated task requests a different model or reasoning route, but the current state declares no managed fork or subworkflow transition. Continue inline or transition to a state that declares one."
        fi
      else
        ADAPTER_DISPLAY="Statewright guard: denied · continue inline by default so evidence stays attached to the current workflow. A raw delegated agent would receive a separate, unbounded tool surface."
      fi
      ADAPTER_RECEIPT=$(printf '%s' "$ADAPTER_RESULT" | jq -c '{
        managed_delegation: .delegation,
        classifier_receipt: (.risk_assessment | walk(
          if type == "object" then del(.command, .raw_command, .tool_input, .input, .arguments) else . end
        ))
      }')
      jq -n --arg reason "$ADAPTER_DISPLAY" --arg receipt "$ADAPTER_RECEIPT" \
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason,"additionalContext":("[statewright] Managed delegation receipt: " + $receipt)}}'
      exit 0
    fi

    # Existing workflows that omitted allowed_tools intentionally had no
    # standalone Codex restriction. Preserve that legacy contract; only the
    # explicit deny/heuristic mode activates omission-as-unrestricted logic.
    if ! statewright_denylist_mode && [ -z "$ALLOWED" ]; then
      exit 0
    fi

    if statewright_uses_unsupported_shell "$TOOL_NAME" "$HOOK_INPUT"; then
      jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Zsh is not enabled for guarded shell execution. Use Bash so Statewright can apply its shell policy."}}'
      exit 0
    fi

    # denylist_heuristic_v1 has one authoritative decision path. The gateway
    # combines deterministic classification with the configured System One
    # fallback; duplicating command patterns here can preempt that fallback.
    if statewright_denylist_mode; then
      ADAPTER_RESULT=$(adapter_pre_tool_call "$TOOL_NAME")
      if ! printf '%s' "$ADAPTER_RESULT" | jq -e 'type == "object"' >/dev/null 2>&1; then
        jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Statewright gateway decision unavailable; denylist policy fails closed."}}'
        exit 0
      fi

      ADAPTER_ACTIVE=$(printf '%s' "$ADAPTER_RESULT" | jq -r 'if has("active") then .active else true end' 2>/dev/null || true)
      ADAPTER_DECISION=$(printf '%s' "$ADAPTER_RESULT" | jq -r '.decision // empty' 2>/dev/null || true)
      if [ "$ADAPTER_ACTIVE" = "false" ]; then
        jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Statewright gateway has no active workflow for the locally active denylist policy."}}'
        exit 0
      fi
      if [ "$ADAPTER_DECISION" = "allow" ]; then
        ADAPTER_CONTEXT=$(printf '%s' "$ADAPTER_RESULT" | jq -r '.additional_context // .additionalContext // empty' 2>/dev/null || true)
        if [ -n "$ADAPTER_CONTEXT" ]; then
          jq -n --arg context "$ADAPTER_CONTEXT" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":$context}}'
        fi
        exit 0
      fi

      # Keep the complete, already-redacted receipt available to the agent in
      # additionalContext, but make the native permission surface read like a
      # Statewright supervisor event rather than a JSON/probability dump.
      ADAPTER_REASON=$(printf '%s' "$ADAPTER_RESULT" | jq -r '.reason // "Blocked by Statewright gateway policy."' 2>/dev/null || true)
      [ -n "$ADAPTER_REASON" ] || ADAPTER_REASON="Blocked by Statewright gateway policy."
      UNMANAGED_DELEGATION=$(printf '%s' "$ADAPTER_RESULT" | jq -r \
        '.risk_assessment.deterministic_source == "unmanaged_agent_delegation"' 2>/dev/null || true)
      RUN_ID=$(printf '%s' "$STATE_JSON" | jq -r '.run_id // empty' 2>/dev/null || true)
      RUN_SESSION_ID=$(printf '%s' "$STATE_JSON" | jq -r '.run_session_id // empty' 2>/dev/null || true)
      STATE_EPOCH=$(printf '%s' "$STATE_JSON" | jq -r '.state_epoch // empty' 2>/dev/null || true)
      APPROVAL_REQUEST=""
      if [ "$UNMANAGED_DELEGATION" != "true" ]; then
        APPROVAL_REQUEST=$(printf '%s' "$ADAPTER_RESULT" | jq -c \
          --arg thread_id "$HOOK_SESSION" --arg run_id "$RUN_ID" \
          --arg run_session_id "$RUN_SESSION_ID" --arg state "$CURRENT" \
          --arg state_epoch "$STATE_EPOCH" '
          .risk_assessment? as $risk
          | if ($risk | type) != "object" then empty else {
              schema: "statewright/classifier-approval-request/v2",
              thread_id: $thread_id,
              run_id: $run_id,
              run_session_id: $run_session_id,
              state: $state,
              state_epoch: (if ($state_epoch | test("^[0-9]+$")) then ($state_epoch | tonumber) else null end),
              classifier_receipt: {
                intent_fingerprint: $risk.intent_fingerprint,
                invocation_fingerprint: $risk.invocation_fingerprint,
                final_denial_basis: ($risk.final_denial_basis // $risk.resolution_basis),
                required_authority: $risk.required_authority,
                reformulation_allowed: $risk.reformulation_allowed,
                exact_invocation_retry_allowed: $risk.exact_invocation_retry_allowed,
                separate_approval_allowed: $risk.separate_approval_allowed
              }
            } end
          ' 2>/dev/null || true)
      fi
      APPROVAL_RESULT=""
      if [ -n "$APPROVAL_REQUEST" ] && [ -n "$STATEWRIGHT_NODE_RUNTIME" ]; then
        APPROVAL_RESULT=$(printf '%s' "$APPROVAL_REQUEST" \
          | "$STATEWRIGHT_NODE_RUNTIME" "${SCRIPT_DIR}/scripts/classifier-approval.mjs" 2>/dev/null || true)
      fi
      APPROVAL_ACTION=$(printf '%s' "$APPROVAL_RESULT" | jq -r '.action // empty' 2>/dev/null || true)
      if [ "$APPROVAL_ACTION" = "allow_once" ]; then
        jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"[statewright] Human approval granted for this exact invocation once."}}'
        exit 0
      fi
      if [ "$UNMANAGED_DELEGATION" = "true" ]; then
        ADAPTER_DISPLAY="Statewright guard: denied · a raw delegated agent would receive a separate, unbounded tool surface. Continue inline by default so evidence stays attached to the current workflow. If the task requires a model change or an isolated execution boundary, use a Statewright-managed fork attached to this workflow."
      else
        ADAPTER_DISPLAY=$(printf '%s' "$ADAPTER_RESULT" | jq -r '
        def pct($value): (((($value // 0) * 100) | round | tostring) + "%");
        .risk_assessment? as $risk
        | if ($risk | type) != "object" then empty else
            (($risk.final_denial_basis // $risk.resolution_basis // "unknown") | tostring) as $basis
            | (($risk.required_authority // "approved execution path") | tostring) as $required
            | (if $basis == "semantic_threshold_not_met"
              or $basis == "incomplete_structural_evidence"
              or $basis == "semantic_vector_unavailable"
              or $basis == "semantic_assessment_incomplete"
              then "Statewright guard: denied · System One could not prove a safe local effect. Next: prefer one bounded native operation (for example rg, git diff, or a project task) instead of a heredoc or inline interpreter; use the approved execution path when code must run."
              elif $basis == "deterministic_nonlocal_risk"
              then "Statewright guard: denied · known non-local effect. Next: use the approved execution path."
              elif ($basis | startswith("workflow_capability_"))
              then "Statewright guard: denied · this phase does not allow the resolved effect. Next: transition to a phase that grants " + $required + "."
              elif ($basis | startswith("classifier_policy_"))
              then "Statewright guard: denied · this workflow risk band is too narrow. Next: use a workflow state with " + $required + "."
              else "Statewright guard: denied · classifier policy requires " + $required + "."
              end) as $message
            | if $risk.semantic_status == "Assessed" and (($risk.semantic_vector? | type) == "object")
              then $message + " System One signals: read-only " + pct($risk.semantic_vector.read_only)
                + ", write " + pct($risk.semantic_vector.may_write)
                + ", destructive " + pct($risk.semantic_vector.destructive)
                + ", external " + pct($risk.semantic_vector.external_or_account_effect) + "."
              else $message end
          end
        ' 2>/dev/null || true)
      fi
      if [ -z "$ADAPTER_DISPLAY" ]; then
        ADAPTER_DISPLAY="$ADAPTER_REASON"
      fi
      if [ "$UNMANAGED_DELEGATION" != "true" ] && [ "$APPROVAL_ACTION" = "rework" ]; then
        REWORK_ATTEMPTS=$(printf '%s' "$APPROVAL_RESULT" | jq -r '.attempts // 0' 2>/dev/null || echo 0)
        REWORK_MAX=$(printf '%s' "$APPROVAL_RESULT" | jq -r '.max_reworks // 2' 2>/dev/null || echo 2)
        ADAPTER_DISPLAY="${ADAPTER_DISPLAY} Rework attempt ${REWORK_ATTEMPTS}/${REWORK_MAX}; after this budget, the same classified intent will be sent for native human approval."
      elif [ "$UNMANAGED_DELEGATION" != "true" ] && [ "$APPROVAL_ACTION" = "deny" ]; then
        APPROVAL_REASON=$(printf '%s' "$APPROVAL_RESULT" | jq -r '.reason // empty' 2>/dev/null || true)
        case "$APPROVAL_REASON" in
          human_declined)
            ADAPTER_DISPLAY="${ADAPTER_DISPLAY} Human approval was denied; do not replay this invocation."
            ;;
          human_cancelled)
            ADAPTER_DISPLAY="${ADAPTER_DISPLAY} The native approval dialog was dismissed; the invocation remains denied."
            ;;
          exact_invocation_already_observed)
            ADAPTER_DISPLAY="${ADAPTER_DISPLAY} The exact denied invocation cannot count as rework; change the invocation on the reported structural axis."
            ;;
          approval_already_pending)
            ADAPTER_DISPLAY="${ADAPTER_DISPLAY} One approval request for this intent is already pending; this concurrent invocation remains denied."
            ;;
          approval_previously_denied)
            ADAPTER_DISPLAY="${ADAPTER_DISPLAY} Approval for this intent was already denied or dismissed; reformulate or wait for a new bounded approval window."
            ;;
          native_approval_timeout|approval_request_aborted|provider_connection_closed|native_approval_unavailable)
            ADAPTER_DISPLAY="${ADAPTER_DISPLAY} Native human approval did not complete; the invocation remains denied."
            ;;
          approval_state_unavailable)
            ADAPTER_DISPLAY="${ADAPTER_DISPLAY} Human approval could not revalidate authoritative workflow state; the invocation remains denied."
            ;;
          approval_state_changed)
            ADAPTER_DISPLAY="${ADAPTER_DISPLAY} The workflow run or state changed before approval completed; the stale invocation remains denied."
            ;;
          invalid_redacted_classifier_receipt)
            ADAPTER_DISPLAY="${ADAPTER_DISPLAY} This denial is not eligible for classifier fallback approval."
            ;;
          *)
            ADAPTER_DISPLAY="${ADAPTER_DISPLAY} Native human approval was not granted."
            ;;
        esac
      elif [ "$UNMANAGED_DELEGATION" != "true" ] && [ -n "$APPROVAL_REQUEST" ] \
          && { [ "$APPROVAL_ACTION" = "unavailable" ] || [ -z "$APPROVAL_ACTION" ]; }; then
        ADAPTER_DISPLAY="${ADAPTER_DISPLAY} Native human approval is unavailable in this client or runtime; the invocation remains denied. Use a supported managed local App Server session or reformulate instead of replaying it."
      fi
      ADAPTER_RECEIPT=$(printf '%s' "$ADAPTER_RESULT" | jq -c '
        .risk_assessment? as $risk
        | if ($risk | type) != "object" then empty else
            {
              classifier_receipt: (
                $risk
                | walk(
                    if type == "object" then
                      del(.command, .raw_command, .tool_input, .input, .arguments)
                    else . end
                  )
              )
            }
          end
      ' 2>/dev/null || true)
      if [ -n "$ADAPTER_RECEIPT" ] && printf '%s' "$APPROVAL_RESULT" | jq -e 'type == "object"' >/dev/null 2>&1; then
        ADAPTER_RECEIPT=$(jq -cn --argjson receipt "$ADAPTER_RECEIPT" --argjson approval "$APPROVAL_RESULT" \
          '$receipt + {classifier_approval: $approval}')
      fi
      if [ -n "$ADAPTER_RECEIPT" ]; then
        jq -n --arg reason "$ADAPTER_DISPLAY" --arg receipt "$ADAPTER_RECEIPT" \
          '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason,"additionalContext":("[statewright] Machine classifier receipt: " + $receipt)}}'
      else
        jq -n --arg reason "$ADAPTER_DISPLAY" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
      fi
      exit 0
    fi

    # Legacy workflows retain their local capability and command-prefix
    # behavior. denylist_heuristic_v1 has already exited through the gateway.
    if statewright_tool_allowed "$TOOL_NAME" "$HOOK_INPUT"; then
      # Tool name is in allowed_tools — but if it's Bash, classify the command
      # to prevent bypass of Write/Destructive restrictions via shell redirects
      if [ "$STATEWRIGHT_TOOL_MODE" = "bash" ] || [ "$STATEWRIGHT_TOOL_MODE" = "readonly_shell" ]; then
        COMMAND=$(statewright_input_command "$HOOK_INPUT")
        if [ -n "$COMMAND" ]; then
          # Check for file write operations when Write is explicitly blocked.
          HAS_WRITE=$(statewright_has_capability "Write" && echo "yes" || echo "no")
          if [ "$HAS_WRITE" = "no" ]; then
            if statewright_has_file_write_redirect "$COMMAND"; then
              REASON="Bash command blocked: output redirect detected but Write is not in allowed tools for '$CURRENT' phase."
              jq -n --arg r "$REASON" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
              exit 0
            fi
            if statewright_has_inplace_file_modify "$COMMAND"; then
              REASON="Bash command blocked: in-place file modification detected but Write is not in allowed tools for '$CURRENT' phase."
              jq -n --arg r "$REASON" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
              exit 0
            fi
            if statewright_has_file_write_primitive "$COMMAND"; then
              REASON="Bash command blocked: file-writing command detected but Write is not in allowed tools for '$CURRENT' phase."
              jq -n --arg r "$REASON" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
              exit 0
            fi
            # Block scripting interpreters that can write files
            if echo "$COMMAND" | grep -qE '^\s*(python|python3|ruby|node|perl|php)\s'; then
              REASON="Bash command blocked: scripting interpreter not permitted without Write in '$CURRENT' phase."
              jq -n --arg r "$REASON" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
              exit 0
            fi
          fi
          # Check for destructive operations (always blocked in restricted states)
          if echo "$COMMAND" | grep -qE '^\s*(rm|rmdir|shred|truncate|unlink)\s'; then
            jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Destructive operation not permitted in this phase."}}'
            exit 0
          fi
          if echo "$COMMAND" | grep -qE '(&&|;)\s*(rm|rmdir|shred|truncate|unlink)\s'; then
            jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Destructive operation not permitted in this phase."}}'
            exit 0
          fi
          # Legacy workflows retain the historical command-prefix contract.
          ALLOWED_CMDS=$(echo "$STATE_JSON" | jq -r '.allowed_commands // [] | .[]' 2>/dev/null || true)
          if [ "$STATEWRIGHT_TOOL_MODE" = "bash" ] && [ -n "$ALLOWED_CMDS" ]; then
            CMD_OK=false
            while IFS= read -r pattern; do
              case "$COMMAND" in "$pattern"|"$pattern "*|$pattern) CMD_OK=true; break ;; esac
            done <<< "$ALLOWED_CMDS"
            if [ "$CMD_OK" = false ]; then
              REASON="Bash command blocked: not in allowed commands for '$CURRENT' phase."
              jq -n --arg r "$REASON" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
              exit 0
            fi
          fi
          # Check blocked_env — deny commands referencing blocked environment variables
          BLOCKED_ENVS=$(echo "$STATE_JSON" | jq -r '.blocked_env // [] | .[]' 2>/dev/null || true)
          if [ -n "$BLOCKED_ENVS" ]; then
            while IFS= read -r bvar; do
              if echo "$COMMAND" | grep -qE "\\\$$bvar|\\\$\{$bvar\}|^$bvar=| $bvar="; then
                REASON="Bash command blocked: references restricted env var in this phase."
                jq -n --arg r "$REASON" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
                exit 0
              fi
            done <<< "$BLOCKED_ENVS"
          fi
        fi
      fi
      exit 0  # Allowed — silent pass
    fi

    # Tool denied by an explicit capability denylist or opaque-tool gate.
    if [ "$STATEWRIGHT_TOOL_MODE" = "opaque" ]; then
      REASON="Tool '$TOOL_NAME' has opaque mutation semantics in the '$CURRENT' phase. Use an executor-owned semantic-risk approval gate before running it."
      jq -n --arg r "$REASON" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
      exit 0
    fi
    BLOCKED_LIST=$(echo "$DISALLOWED" | tr '\n' ', ' | sed 's/,$//')
    REASON="Tool '$TOOL_NAME' is blocked in the '$CURRENT' phase. Explicitly blocked: ${BLOCKED_LIST:-none}.${TRANSITIONS:+ To advance, use statewright_transition with: $TRANSITIONS.}"
    jq -n --arg r "$REASON" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
    exit 0
    ;;

  post-tool)
    # Detect statewright MCP tool calls and manage local state
    TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
    TOOL_RESULT=$(echo "$HOOK_INPUT" | jq -r '.tool_response // .tool_response // empty' 2>/dev/null || true)

    # Only exact local MCP names may mutate this hook's local lifecycle.
    # Cloud connector calls are ordinary foreign tools from this hook's view.
    SW_ACTION=""
    if is_local_statewright_tool "$TOOL_NAME"; then
      SW_ACTION=$(local_statewright_action "$TOOL_NAME")
    fi

    # capture.sh is deliberately opt-in and skips Statewright control tools.
    # Dispatch ordinary tool completions here; merely creating
    # .capture_enabled does not persist a log by itself.
    if [ -f "$PROJECT_DIR/.capture_enabled" ] && [ -z "$SW_ACTION" ]; then
      printf '%s' "$HOOK_INPUT" | bash "${STATEWRIGHT_CAPTURE_SCRIPT:-$SCRIPT_DIR/capture.sh}" >/dev/null 2>&1 &
    fi

    # --- Interrupt detection for file-changing tools (normalized as Write) ---
    if [ -f "$ACTIVE_FILE" ] && [ -z "$SW_ACTION" ] && [ -f "$CACHE_FILE" ]; then
      FILE_PATH=""
      case "$TOOL_NAME" in
        Edit|Write|MultiEdit|apply_patch|patch_file|edit_file|write_file|create_file|create_or_update_file)
          FILE_PATH=$(echo "$HOOK_INPUT" | jq -r '.tool_input.file_path // .tool_input.path // .tool_input.file // empty' 2>/dev/null || true)
          ;;
      esac

      if [ -n "$FILE_PATH" ]; then
        # Normalize to a relative path (native Write-family tools may pass absolute paths)
        # Try cwd first, then strip any leading path up to pattern match
        CWD_PREFIX="$(pwd)/"
        REL_PATH="$FILE_PATH"
        case "$FILE_PATH" in
          "$CWD_PREFIX"*) REL_PATH="${FILE_PATH#$CWD_PREFIX}" ;;
        esac

        # Check interrupt patterns from cached state
        INTERRUPTS=$(cat "$CACHE_FILE" | jq -r '.interrupts // {} | to_entries[] | .key + "\t" + .value.file_pattern' 2>/dev/null || true)
        if [ -n "$INTERRUPTS" ]; then
          # Already in interrupt handler? Skip.
          IN_HANDLER=$(cat "$CACHE_FILE" | jq -r '.context._interrupt_return // empty' 2>/dev/null || true)
          if [ -z "$IN_HANDLER" ]; then
            MATCHED_INT=""
            while IFS=$'\t' read -r INT_NAME INT_PATTERN; do
              [ -z "$INT_NAME" ] && continue
              # Convert glob to regex: ** -> .*, * -> [^/]*, ? -> [^/]
              # Convert glob to regex: **/ -> (.*/)? (zero or more dirs), * -> [^/]*, ? -> [^/]
              REGEX=$(echo "$INT_PATTERN" | sed 's/\./\\./g' | sed 's|\*\*/|DBLSLASH|g' | sed 's/\*\*/DBLSTAR/g' | sed 's/\*/[^\/]*/g' | sed 's|DBLSLASH|(.*\/)\{0,1\}|g' | sed 's/DBLSTAR/.*/g' | sed 's/?/[^\/]/g')
              # Try relative path (anchored) first, then absolute path (unanchored)
              if echo "$REL_PATH" | grep -qE "^${REGEX}$" 2>/dev/null || \
                 echo "$FILE_PATH" | grep -qE "(^|/)${REGEX}$" 2>/dev/null; then
                MATCHED_INT="$INT_NAME"
                break
              fi
            done <<< "$INTERRUPTS"

            if [ -n "$MATCHED_INT" ]; then
              # Get target state from cache
              INT_TARGET=$(cat "$CACHE_FILE" | jq -r --arg name "$MATCHED_INT" '.interrupts[$name].target // empty' 2>/dev/null || true)
              # Instruct agent to trigger interrupt via MCP tool (correct session)
              echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] INTERRUPT: file '${FILE_PATH}' matched interrupt '${MATCHED_INT}'. You MUST immediately call statewright_transition(event='INTERRUPT:${MATCHED_INT}', data={'rationale': 'File edit triggered interrupt', 'trigger_file': '${FILE_PATH}'}) before doing anything else. This will transition to '${INT_TARGET}' for validation.\"}}"
              exit 0
            fi
          fi
        fi
      fi
    fi

    case "$SW_ACTION" in
      start)
        # A workflow load returns its authoritative post-load state. Never
        # re-query here: that can target a stale gateway session and activate
        # enforcement with the wrong phase.
        if tool_response_is_error "$TOOL_RESULT"; then
          PARSED=""
        else
          PARSED=$(extract_mcp_result_text "$TOOL_RESULT")
        fi
        STATE_JSON=$(echo "$PARSED" | jq -c '.state_snapshot // empty' 2>/dev/null || true)
        if [ -z "$STATE_JSON" ] || [ "$STATE_JSON" = "null" ] || ! is_valid_state_snapshot "$STATE_JSON"; then
          jq -n \
            --arg tool "$TOOL_NAME" \
            '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:("[statewright] " + $tool + " did not return an authoritative state snapshot. Enforcement was not activated; reload the workflow after updating the gateway.")}}'
          exit 0
        fi

        # A foreign managed root cannot acquire or replace this hook's local
        # enforcement state. Preserve existing evidence and fail closed.
        if ! managed_root_is_owned; then
          if [ -f "$ACTIVE_FILE" ]; then
            touch "$GATEWAY_UNAVAILABLE_FILE"
          fi
          jq -n '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:"[statewright] Local workflow result was refused because the managed root is not owned by this thread. Existing enforcement was preserved."}}'
          exit 0
        fi

        # Activate enforcement only after the exact load response is available.
        mkdir -p "$PROJECT_DIR"
        rm -f "$PROJECT_DIR/.capture_enabled" "$PROJECT_DIR/.run_id" "$PROJECT_DIR/.run_session_id" "$PROJECT_DIR/.log_seq" "$PROJECT_DIR/.telemetry_seq"
        RUN_ID=$(echo "$STATE_JSON" | jq -r '.run_id // empty' 2>/dev/null || true)
        RUN_SESSION_ID=$(echo "$STATE_JSON" | jq -r '.run_session_id // empty' 2>/dev/null || true)
        jq -n --arg client_id "$CLIENT_ID" --arg thread_id "$HOOK_SESSION" \
          --arg activated "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          --arg run_id "$RUN_ID" --arg run_session_id "$RUN_SESSION_ID" \
          '{version:1,client_id:$client_id,thread_id:$thread_id,activated:$activated}
           + (if $run_id == "" then {} else {run_id:$run_id} end)
           + (if $run_session_id == "" then {} else {run_session_id:$run_session_id} end)' > "$ACTIVE_FILE"
        echo "$STATE_JSON" > "$CACHE_FILE"
        rm -f "$GATEWAY_UNAVAILABLE_FILE"
        INITIAL_EPOCH=$(echo "$STATE_JSON" | jq -r '.state_epoch // 1' 2>/dev/null || echo "1")
        case "$INITIAL_EPOCH" in ''|*[!0-9]*) INITIAL_EPOCH=1 ;; esac
        reset_native_telemetry_state "$INITIAL_EPOCH"

        CAPTURE=$(echo "$STATE_JSON" | jq -r '.capture_output // false' 2>/dev/null || true)
        [ -n "$RUN_ID" ] && echo "$RUN_ID" > "$PROJECT_DIR/.run_id"
        [ -n "$RUN_SESSION_ID" ] && echo "$RUN_SESSION_ID" > "$PROJECT_DIR/.run_session_id"
        [ "$CAPTURE" = "true" ] && touch "$PROJECT_DIR/.capture_enabled"
        emit_native_telemetry "workflow_loaded" "$STATE_JSON"
        clear_interactive_route_requests
        request_interactive_route_restart "$STATE_JSON"
        # Tell the agent to start working immediately
        INIT_STATE=$(echo "$STATE_JSON" | jq -r '.state // empty' 2>/dev/null || true)
        INIT_TOOLS=$(statewright_tools_label "$STATE_JSON")
        INIT_TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event + " -> " + .target) | join(", ")' 2>/dev/null || true)
        INIT_INSTRUCTIONS=$(echo "$STATE_JSON" | jq -r '.instructions // empty' 2>/dev/null || true)
        echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] Workflow loaded. Phase: ${INIT_STATE}. Tools: ${INIT_TOOLS}. Transitions: ${INIT_TRANSITIONS}. KEEP WORKING -- begin the ${INIT_STATE} phase immediately. Do not stop or summarize.${INIT_INSTRUCTIONS:+ Instructions: $INIT_INSTRUCTIONS}\"}}"
        ;;
      stop)
        # A matching tool name is not evidence of a successful deactivate.
        if tool_response_is_error "$TOOL_RESULT"; then
          PARSED=""
        else
          PARSED=$(extract_mcp_result_text "$TOOL_RESULT")
        fi
        if printf '%s' "$PARSED" | jq -e '(.deactivated == true or .stopped == true or .paused == true)' >/dev/null 2>&1; then
          clear_local_enforcement_state || touch "$GATEWAY_UNAVAILABLE_FILE"
        fi
        ;;
      transition)
        # Read previous state before refreshing
        PREV_STATE=$(cat "$CACHE_FILE" 2>/dev/null | jq -r '.state // empty' 2>/dev/null || true)
        PREV_TRANSITION_COUNT=$(cat "$CACHE_FILE" 2>/dev/null | jq -r '.transition_count // empty' 2>/dev/null || true)

        # Check for fork/join results in tool output
        PARSED_RESULT=$(extract_mcp_result_text "$TOOL_RESULT")

        IS_FORK=$(echo "$PARSED_RESULT" | jq -r '.forked // false' 2>/dev/null || true)
        IS_JOIN=$(echo "$PARSED_RESULT" | jq -r '.joined // false' 2>/dev/null || true)
        IS_BRANCH_DONE=$(echo "$PARSED_RESULT" | jq -r '.branch_completed // empty' 2>/dev/null || true)

        # Refresh only from a typed authoritative local result.
        FETCHED_STATE=$(fetch_local_state)
        FETCH_KIND=$(printf '%s' "$FETCHED_STATE" | jq -r '.kind // "unavailable"' 2>/dev/null || true)
        if [ "$FETCH_KIND" = "inactive" ]; then
          clear_local_enforcement_state || touch "$GATEWAY_UNAVAILABLE_FILE"
          exit 0
        fi
        if [ "$FETCH_KIND" = "active" ]; then
          STATE_JSON=$(printf '%s' "$FETCHED_STATE" | jq -c '.state' 2>/dev/null || true)
          echo "$STATE_JSON" > "$CACHE_FILE"
          rm -f "$GATEWAY_UNAVAILABLE_FILE"
          NEW_STATE=$(echo "$STATE_JSON" | jq -r '.state // empty' 2>/dev/null || true)
          NEW_TRANSITION_COUNT=$(echo "$STATE_JSON" | jq -r '.transition_count // empty' 2>/dev/null || true)
          IS_FINAL=$(echo "$STATE_JSON" | jq -r '.is_final // false' 2>/dev/null || true)
          TRANSITION_SUCCEEDED=false
          case "$PREV_TRANSITION_COUNT" in
            ''|*[!0-9]*) ;;
            *)
              case "$NEW_TRANSITION_COUNT" in
                ''|*[!0-9]*) ;;
                *) [ "$NEW_TRANSITION_COUNT" -gt "$PREV_TRANSITION_COUNT" ] && TRANSITION_SUCCEEDED=true ;;
              esac
              ;;
          esac
          if [ "$TRANSITION_SUCCEEDED" != "true" ] && [ "$(echo "$PARSED_RESULT" | jq -r 'if (.transitioned == true or .forced == true or .forked == true or .joined == true or .failed == true or (.branch_completed? != null) or (.subflow_started? != null) or (.subflow_completed? != null)) then "true" else "false" end' 2>/dev/null || true)" = "true" ]; then
            TRANSITION_SUCCEEDED=true
          fi
          if [ "$TRANSITION_SUCCEEDED" = "true" ]; then
            AUTHORITATIVE_EPOCH=$(echo "$STATE_JSON" | jq -r '.state_epoch // empty' 2>/dev/null || true)
            case "$AUTHORITATIVE_EPOCH" in
              ''|*[!0-9]*)
                PREV_EPOCH=$(cat "$PROJECT_DIR/.state_epoch" 2>/dev/null || echo "0")
                case "$PREV_EPOCH" in ''|*[!0-9]*) PREV_EPOCH=0 ;; esac
                AUTHORITATIVE_EPOCH=$((PREV_EPOCH + 1))
                ;;
            esac
            reset_native_telemetry_state "$AUTHORITATIVE_EPOCH"
          fi
          if [ "$IS_FINAL" = "true" ]; then
            emit_native_telemetry "workflow_completed" "$STATE_JSON"
            clear_interactive_route_requests
            request_interactive_route_restart "$STATE_JSON" true
          else
            emit_native_telemetry "state_boundary" "$STATE_JSON"
            request_interactive_route_restart "$STATE_JSON"
          fi

          if [ "$IS_FORK" = "true" ]; then
            # Fork transition — show branches and agent coordination instructions
            BRANCHES=$(echo "$PARSED_RESULT" | jq -r '.branches | keys | join(", ")' 2>/dev/null || true)
            BRANCH_COUNT=$(echo "$PARSED_RESULT" | jq -r '.branches | length' 2>/dev/null || true)
            CURRENT=$(echo "$PARSED_RESULT" | jq -r '.current_branch // empty' 2>/dev/null || true)
            NEXT_TOOLS=$(statewright_tools_label "$STATE_JSON")
            INSTRUCTIONS=$(echo "$STATE_JSON" | jq -r '.instructions // empty' 2>/dev/null || true)
            # For parallel execution: spawn N fork-branch-worker agents, then WAIT for all N task-notifications before proceeding.
            # The gateway auto-joins via BRANCH_DONE MCP calls, but you must wait for all agent notifications to confirm completion.
            # Do NOT check get_state to determine fork completion -- wait for the notifications.
            echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] FORK: ${BRANCH_COUNT} branches [${BRANCHES}]. For parallel: spawn ${BRANCH_COUNT} fork-branch-worker agents (one per branch), then WAIT for all ${BRANCH_COUNT} task-notification events before proceeding. Do NOT call get_state to check fork status -- the gateway joins via MCP but notifications arrive separately. For sequential: work branch '${CURRENT}' first.${INSTRUCTIONS:+ Instructions: $INSTRUCTIONS}\"}}"
          elif [ "$IS_JOIN" = "true" ]; then
            # Join completed — show post-join state
            JOIN_TO=$(echo "$PARSED_RESULT" | jq -r '.to // empty' 2>/dev/null || true)
            NEXT_TOOLS=$(statewright_tools_label "$STATE_JSON")
            NEXT_TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event + " -> " + .target) | join(", ")' 2>/dev/null || true)
            echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] FORK JOIN complete. All branches done. Now in ${JOIN_TO}. Tools: ${NEXT_TOOLS}. Transitions: ${NEXT_TRANSITIONS}.\"}}"
          elif [ -n "$IS_BRANCH_DONE" ]; then
            # Branch completed, more to go
            NEXT_BRANCH=$(echo "$PARSED_RESULT" | jq -r '.next_branch // empty' 2>/dev/null || true)
            REMAINING=$(echo "$PARSED_RESULT" | jq -r '.remaining // 0' 2>/dev/null || true)
            NEXT_TOOLS=$(statewright_tools_label "$STATE_JSON")
            INSTRUCTIONS=$(echo "$STATE_JSON" | jq -r '.instructions // empty' 2>/dev/null || true)
            echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] Branch '${IS_BRANCH_DONE}' done. ${REMAINING} remaining. Now working branch '${NEXT_BRANCH}' (state: ${NEW_STATE}). Tools: ${NEXT_TOOLS}. Complete this branch, then call statewright_transition(event='BRANCH_DONE:${NEXT_BRANCH}').${INSTRUCTIONS:+ Instructions: $INSTRUCTIONS}\"}}"
          elif [ "$(echo "$STATE_JSON" | jq -r '.pending_approval.approval_id // empty' 2>/dev/null || true)" != "" ]; then
            APPROVAL_MESSAGE=$(echo "$STATE_JSON" | jq -r '.pending_approval.message // "Human review required."' 2>/dev/null || true)
            APPROVAL_MODE=$(echo "$STATE_JSON" | jq -r '.meta.approval_mode // "ui"' 2>/dev/null || true)
            if [ "$APPROVAL_MODE" = "external" ]; then
              echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] Approval is pending on the configured external review channel. Do not continue this workflow until that reviewer resolves it.\"}}"
            else
              echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] REVIEW REQUIRED: ${APPROVAL_MESSAGE} Present this approval request to the user in the current UI. Do not continue the workflow until the user approves or rejects it.\"}}"
            fi
          elif [ "$IS_FINAL" = "true" ]; then
            if clear_local_enforcement_state false; then
              echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] ${PREV_STATE} => ${NEW_STATE} (workflow complete, enforcement deactivated)\"}}"
            else
              touch "$GATEWAY_UNAVAILABLE_FILE"
            fi
          elif [ -n "$NEW_STATE" ]; then
            NEXT_TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event + " -> " + .target) | join(", ")' 2>/dev/null || true)
            NEXT_TOOLS=$(statewright_tools_label "$STATE_JSON")
            if [ -n "$PREV_STATE" ]; then
              echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] ${PREV_STATE} => ${NEW_STATE}. Tools: ${NEXT_TOOLS}. Next transitions: ${NEXT_TRANSITIONS}. Use ONLY these exact event names with statewright_transition. KEEP WORKING -- do not stop or wait for user input.\"}}"
            else
              echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] Now in ${NEW_STATE}. Tools: ${NEXT_TOOLS}. Next transitions: ${NEXT_TRANSITIONS}. Use ONLY these exact event names with statewright_transition. KEEP WORKING -- do not stop or wait for user input.\"}}"
            fi
          fi
        else
          touch "$GATEWAY_UNAVAILABLE_FILE"
        fi
        ;;
      refresh_cache)
        # Silently update cache from gateway state (catches force_state drift)
        if [ -f "$ACTIVE_FILE" ]; then
          FETCHED_STATE=$(fetch_local_state)
          FETCH_KIND=$(printf '%s' "$FETCHED_STATE" | jq -r '.kind // "unavailable"' 2>/dev/null || true)
          if [ "$FETCH_KIND" = "inactive" ]; then
            clear_local_enforcement_state || touch "$GATEWAY_UNAVAILABLE_FILE"
          elif [ "$FETCH_KIND" = "active" ]; then
            STATE_JSON=$(printf '%s' "$FETCHED_STATE" | jq -c '.state' 2>/dev/null || true)
            PREV_EPOCH=$(cat "$PROJECT_DIR/.state_epoch" 2>/dev/null || echo "0")
            AUTHORITATIVE_EPOCH=$(echo "$STATE_JSON" | jq -r '.state_epoch // empty' 2>/dev/null || true)
            echo "$STATE_JSON" > "$CACHE_FILE"
            rm -f "$GATEWAY_UNAVAILABLE_FILE"
            case "$PREV_EPOCH" in ''|*[!0-9]*) PREV_EPOCH=0 ;; esac
            case "$AUTHORITATIVE_EPOCH" in ''|*[!0-9]*) AUTHORITATIVE_EPOCH="$PREV_EPOCH" ;; esac
            if [ "$AUTHORITATIVE_EPOCH" -gt 0 ] && [ "$AUTHORITATIVE_EPOCH" -ne "$PREV_EPOCH" ]; then
              reset_native_telemetry_state "$AUTHORITATIVE_EPOCH"
              emit_native_telemetry "state_boundary" "$STATE_JSON"
            fi
          else
            touch "$GATEWAY_UNAVAILABLE_FILE"
          fi
        fi
        ;;
    esac
    if [ -f "$ACTIVE_FILE" ] && [ -z "$SW_ACTION" ]; then
      record_stop_progress
    fi
    if [ -f "$ACTIVE_FILE" ] && [ -z "$SW_ACTION" ] && [ -f "$CACHE_FILE" ]; then
      emit_native_telemetry "tool_observed" "$(cat "$CACHE_FILE")"
    fi
    exit 0
    ;;

  stop)
    [ "${STATEWRIGHT_STOP_CONTINUATION:-1}" = "0" ] && exit 0
    [ -f "$ACTIVE_FILE" ] || exit 0
    # Never revive a stale cached continuation when the authoritative gateway
    # is unavailable.  PreToolUse remains fail-closed until it recovers.
    [ -f "$GATEWAY_UNAVAILABLE_FILE" ] && exit 0
    STATE_JSON=""
    if [ -f "$CACHE_FILE" ]; then
      STATE_JSON=$(cat "$CACHE_FILE")
      is_valid_cached_state "$STATE_JSON" || exit 0
      if ! managed_root_is_owned || ! state_matches_local_binding "$STATE_JSON"; then
        touch "$GATEWAY_UNAVAILABLE_FILE"
        exit 0
      fi
    else
      FETCHED_STATE=$(fetch_local_state)
      FETCH_KIND=$(printf '%s' "$FETCHED_STATE" | jq -r '.kind // "unavailable"' 2>/dev/null || true)
      if [ "$FETCH_KIND" = "active" ]; then
        STATE_JSON=$(printf '%s' "$FETCHED_STATE" | jq -c '.state' 2>/dev/null || true)
        echo "$STATE_JSON" > "$CACHE_FILE"
      elif [ "$FETCH_KIND" = "inactive" ]; then
        clear_local_enforcement_state || touch "$GATEWAY_UNAVAILABLE_FILE"
        exit 0
      else
        touch "$GATEWAY_UNAVAILABLE_FILE"
        exit 0
      fi
    fi
    CURRENT=$(echo "$STATE_JSON" | jq -r '.state // empty' 2>/dev/null || true)
    [ -n "$CURRENT" ] || exit 0
    [ "$(echo "$STATE_JSON" | jq -r '.is_final // false' 2>/dev/null || true)" = "true" ] && exit 0
    [ -n "$(echo "$STATE_JSON" | jq -r '.pending_approval.approval_id // empty' 2>/dev/null || true)" ] && exit 0
    allow_stop_nudge "$STATE_JSON" || exit 0
    ITER=$(echo "$STATE_JSON" | jq -r '.iteration // 0' 2>/dev/null || true)
    MAX=$(echo "$STATE_JSON" | jq -r '.max_iterations // "none"' 2>/dev/null || true)
    TOOLS=$(statewright_tools_label "$STATE_JSON")
    TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event + " -> " + .target) | join(", ")' 2>/dev/null || true)
    jq -n --arg reason "Statewright workflow remains active. Phase: $CURRENT (iteration $ITER/$MAX). Tools: $TOOLS. Transitions: $TRANSITIONS. CONTINUATION REQUIRED: do not stop, summarize, or wait for a new user prompt. Continue immediately with only the state-allowed tools and call statewright_transition when this phase is complete." '{"decision":"block","reason":$reason}'
    exit 0
    ;;

  *)
    exit 0
    ;;
esac
