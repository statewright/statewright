#!/usr/bin/env bash
# Statewright Codex CLI plugin hook
# Dormant by default — only enforces when a workflow is explicitly activated
# via MCP tool (statewright_start) or slash command (/statewright)
set -o pipefail

ENDPOINT="${1:-user-prompt}"
HOOK_INPUT=$(cat 2>/dev/null || true)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Executor-owned runs must use the authenticated loopback bridge before any
# standalone bootstrap, credential lookup, cache mutation, or telemetry setup.
if [ -n "${STATEWRIGHT_ADAPTER_URL:-}" ]; then
  EXECUTOR_HOOK="${SCRIPT_DIR}/scripts/executor-hook.mjs"
  if command -v node >/dev/null 2>&1 && [ -f "$EXECUTOR_HOOK" ]; then
    printf '%s' "$HOOK_INPUT" | node "$EXECUTOR_HOOK" "$ENDPOINT"
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
SESSION_KEY="${CLIENT_ID#swc_}"
SESSION_KEY="${SESSION_KEY:0:16}"
PROJECT_DIR="$STATEWRIGHT_DIR/sessions/$SESSION_KEY"
ACTIVE_FILE="$PROJECT_DIR/.active"
CACHE_FILE="$PROJECT_DIR/.state_cache"
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

# --- Helper: call MCP gateway ---
mcp_call() {
  curl -sf --max-time 5 -X POST "$GW_URL/" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $API_KEY" \
    "${SESSION_HEADER_ARGS[@]}" \
    -d "$1" 2>/dev/null | perl -0777 -pe 's/[\x00-\x09\x0b-\x0c\x0e-\x1f]//g' | jq -r '.result.content[0].text // empty' 2>/dev/null || true
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
    if type == "string" then .
    elif type == "array" then first_text
    elif type == "object" then
      if (.content? | type) == "array" then (.content | first_text)
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
  local binding_payload propagate_children=false

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
  timestamp=$(node -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || true)
  [ -z "$timestamp" ] && timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  effective_at=$(cat "$PROJECT_DIR/.state_effective_at" 2>/dev/null || true)
  [ -z "$effective_at" ] && effective_at="$timestamp"
  model=$(echo "$HOOK_INPUT" | jq -r '.model // empty' 2>/dev/null || true)

  binding_payload=$(jq -n \
    --arg conversation_id "$conversation_id" \
    --arg root_session_id "$session_id" \
    --arg run_id "$run_id" \
    --arg run_session_id "$run_session_id" \
    --arg workflow "$(echo "$state_json" | jq -r '.workflow // empty' 2>/dev/null || true)" \
    --arg state "$state" \
    --arg effective_at "$effective_at" \
    --argjson state_epoch "$epoch" \
    --argjson propagate_children "$propagate_children" \
    '{
      conversation_id: $conversation_id,
      root_session_id: $root_session_id,
      run_id: $run_id,
      run_session_id: $run_session_id,
      workflow: $workflow,
      state: $state,
      state_epoch: $state_epoch,
      effective_at: $effective_at,
      propagate_children: $propagate_children
    }')
  if ! curl -sf --max-time 1 -X POST "$LOCAL_TELEMETRY_URL/v1/state-bindings" \
    -H 'Content-Type: application/json' \
    -d "$binding_payload" >/dev/null 2>&1; then
    if ! printf '%s' "$binding_payload" | \
      STATEWRIGHT_TELEMETRY_DIR="$TELEMETRY_DIR" \
      node "$TELEMETRY_AGENT" --bind-stdin >/dev/null 2>&1; then
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
  local control_dir model effort request_path
  control_dir="${STATEWRIGHT_ROUTE_CONTROL_DIR:-}"
  [ -n "$control_dir" ] || return 0
  model=$(echo "$state_json" | jq -r '.model // empty' 2>/dev/null || true)
  effort=$(echo "$state_json" | jq -r '.thinking_level // empty' 2>/dev/null || true)
  mkdir -p "$control_dir" || return 0
  request_path="$control_dir/$(date +%s%N)-${HOOK_SESSION:-unknown}.route.json"
  jq -n \
    --arg session_id "$HOOK_SESSION" \
    --arg client_id "$CLIENT_ID" \
    --arg run_id "$(echo "$state_json" | jq -r '.run_id // empty' 2>/dev/null || true)" \
    --arg state "$(echo "$state_json" | jq -r '.state // empty' 2>/dev/null || true)" \
    --arg model "$model" \
    --arg effort "$effort" \
    '{session_id: $session_id, client_id: $client_id, run_id: $run_id, state: $state, model: $model, effort: $effort}' \
    > "$request_path.tmp" && mv "$request_path.tmp" "$request_path"
}

reset_native_telemetry_state() {
  local epoch="$1"
  local effective_at
  effective_at=$(node -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || true)
  [ -z "$effective_at" ] && effective_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "$epoch" > "$PROJECT_DIR/.state_epoch"
  echo "$effective_at" > "$PROJECT_DIR/.state_effective_at"
  echo "0" > "$PROJECT_DIR/.telemetry_tool_bytes"
  echo "0" > "$PROJECT_DIR/.telemetry_tool_count"
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

    # --- No API key: provisioning (runs even when dormant) ---
    if [ -z "$API_KEY" ]; then
      # Let key-paste prompts through
      if echo "$HOOK_INPUT" | grep -q "sw_live_" 2>/dev/null; then
        PASTED_KEY=$(echo "$HOOK_INPUT" | grep -o 'sw_live_[a-zA-Z0-9_-]*')
        # Save the key directly — don't ask Claude to do it (Claude freaks out about pasted keys)
        mkdir -p "$STATEWRIGHT_DIR"
        echo "$PASTED_KEY" > "$STATEWRIGHT_DIR/api_key"
        chmod 600 "$STATEWRIGHT_DIR/api_key"
        echo "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"Statewright API key saved automatically. The user can now activate a workflow with: statewright_start(workflow='bugfix') or statewright_list_workflows() to see available workflows.\"}}"
        exit 0
      fi

      # Open browser once
      if [ ! -f "$STATEWRIGHT_DIR/.prompted" ]; then
        if command -v open &> /dev/null; then
          open "https://statewright.ai/signup?redirect=/keys" 2>/dev/null
        elif command -v xdg-open &> /dev/null; then
          xdg-open "https://statewright.ai/signup?redirect=/keys" 2>/dev/null
        fi
        mkdir -p "$STATEWRIGHT_DIR"
        touch "$STATEWRIGHT_DIR/.prompted"
      fi

      # Block until key is provided
      echo '{"decision":"block","reason":"Statewright plugin needs an API key. Visit https://statewright.ai/keys to sign up and generate one, then paste it here.","hookSpecificOutput":{"hookEventName":"UserPromptSubmit"}}'
      exit 0
    fi

    # --- No local .active: dormant (no cross-session leak from gateway) ---
    if [ ! -f "$ACTIVE_FILE" ]; then
      HINT_FILE="$PROJECT_DIR/.session_hinted"
      if [ ! -f "$HINT_FILE" ]; then
        mkdir -p "$PROJECT_DIR"
        touch "$HINT_FILE"
        echo "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"Statewright plugin active. No workflow running. To start one, use statewright_start(workflow='bugfix') or statewright_list_workflows() to see available workflows.\"}}"
      fi
      exit 0
    fi

    # --- Active workflow: fetch state from gateway ---
    STATE_JSON=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}')
    CURRENT=$(echo "$STATE_JSON" | jq -r '.state // empty' 2>/dev/null || true)

    # Gateway unreachable — graceful degradation
    if [ -z "$CURRENT" ]; then
      echo '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Statewright gateway unreachable. Running without workflow enforcement this turn."}}'
      rm -f "$CACHE_FILE"  # Clear cache so PreToolUse allows all tools
      exit 0
    fi

    # Check for final state — auto-deactivate
    IS_FINAL=$(echo "$STATE_JSON" | jq -r '.is_final // false' 2>/dev/null || true)
    if [ "$IS_FINAL" = "true" ]; then
      rm -f "$ACTIVE_FILE" "$CACHE_FILE" "$PROJECT_DIR/.session_hinted" "$PROJECT_DIR/.discovered_commands" "$PROJECT_DIR/.capture_enabled" "$PROJECT_DIR/.run_id" "$PROJECT_DIR/.log_seq"
      echo "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"[statewright] Workflow complete. Final state: $CURRENT. Enforcement deactivated.\"}}"
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
    TOOLS=$(echo "$STATE_JSON" | jq -r '.allowed_tools | join(", ")' 2>/dev/null || true)
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
    CONTEXT="Statewright workflow active. $CONTINUATION_STEER Phase: $CURRENT (iteration $ITER/$MAX). Tools: $TOOLS. MANDATORY: Every statewright_transition call MUST include data.rationale explaining WHY you are transitioning. Format: statewright_transition(event='EVENT', data={'rationale': 'specific reason', ...guard fields}). Available transitions: $TRANSITIONS.${SM_CONTEXT:+ State context: $SM_CONTEXT.}${GUARDS_INFO:+ Guards: $GUARDS_INFO.}${BLOCKED_ENV:+ BLOCKED env vars (do not use): $BLOCKED_ENV.}${ENV_OVERRIDES:+ Use these env vars instead: $ENV_OVERRIDES.}${AVAILABLE_CMDS:+ PREFER these commands over raw shell: $AVAILABLE_CMDS.}${INSTRUCTIONS:+ Instructions: $INSTRUCTIONS.}"
    jq -n --arg ctx "$CONTEXT" '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":$ctx}}'
    exit 0
    ;;

  pre-tool)
    # --- No active workflow: allow everything (dormant) ---
    if [ ! -f "$ACTIVE_FILE" ]; then
      exit 0
    fi

    TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)

    # Always allow system/internal/MCP tools
    case "$TOOL_NAME" in
      *statewright_*|TodoRead|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskStop|TaskOutput|Agent|SendMessage|AskUserQuestion|ExitPlanMode|ToolSearch|Skill) exit 0 ;;
    esac

    # Read cached state (written by UserPromptSubmit — ZERO network calls)
    if [ ! -f "$CACHE_FILE" ]; then
      exit 0  # No cache = no enforcement yet
    fi

    STATE_JSON=$(cat "$CACHE_FILE")
    ALLOWED=$(echo "$STATE_JSON" | jq -r '.allowed_tools // [] | .[]' 2>/dev/null || true)
    CURRENT=$(echo "$STATE_JSON" | jq -r '.state // "unknown"' 2>/dev/null || true)
    TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event) | join(", ")' 2>/dev/null || true)

    if [ -z "$ALLOWED" ]; then
      exit 0  # No allowed_tools list = no enforcement
    fi

    STATEWRIGHT_ALLOWED_TOOLS="$ALLOWED"

    # Normalize concrete Codex tool names to workflow capabilities before
    # applying policy. Read-only shell use is admitted only by the strict
    # classifier; broader shell use continues through Bash discernment below.
    if statewright_tool_allowed "$TOOL_NAME" "$HOOK_INPUT"; then
      # Tool name is in allowed_tools — but if it's Bash, classify the command
      # to prevent bypass of Write/Edit/Destructive restrictions via shell redirects
      if [ "$STATEWRIGHT_TOOL_MODE" = "bash" ] || [ "$STATEWRIGHT_TOOL_MODE" = "readonly_shell" ]; then
        COMMAND=$(echo "$HOOK_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
        if [ -n "$COMMAND" ]; then
          # Check for file write operations (redirects, heredocs) when Write/Edit not allowed
          HAS_WRITE=$(echo "$ALLOWED" | grep -qx "Write" && echo "yes" || echo "no")
          HAS_EDIT=$(echo "$ALLOWED" | grep -qx "Edit" && echo "yes" || echo "no")
          if [ "$HAS_WRITE" = "no" ] && [ "$HAS_EDIT" = "no" ]; then
            if statewright_has_file_write_redirect "$COMMAND"; then
              REASON="Bash command blocked: output redirect detected but Write/Edit not in allowed tools for '$CURRENT' phase."
              jq -n --arg r "$REASON" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
              exit 0
            fi
            if echo "$COMMAND" | grep -qE 'sed\s+-i|perl\s+-p?i'; then
              REASON="Bash command blocked: in-place file modification detected but Edit not in allowed tools for '$CURRENT' phase."
              jq -n --arg r "$REASON" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
              exit 0
            fi
            # Block scripting interpreters that can write files
            if echo "$COMMAND" | grep -qE '^\s*(python|python3|ruby|node|perl|php)\s'; then
              REASON="Bash command blocked: scripting interpreter not permitted without Write/Edit in '$CURRENT' phase."
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
          # Check allowed_commands from cache if present
          ALLOWED_CMDS=$(echo "$STATE_JSON" | jq -r '.allowed_commands // [] | .[]' 2>/dev/null || true)
          if [ -n "$ALLOWED_CMDS" ]; then
            CMD_OK=false
            while IFS= read -r pattern; do
              # Preserve the historical literal-prefix form while accepting
              # Claude-compatible glob patterns in allowed_commands.
              # shellcheck disable=SC2254
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

    # Tool denied — use correct hookSpecificOutput format
    ALLOWED_LIST=$(echo "$ALLOWED" | tr '\n' ', ' | sed 's/,$//')
    REASON="Tool '$TOOL_NAME' is not available in the '$CURRENT' phase. Allowed: ${ALLOWED_LIST}.${TRANSITIONS:+ To advance, use statewright_transition with: $TRANSITIONS.}"
    jq -n --arg r "$REASON" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
    exit 0
    ;;

  post-tool)
    # Detect statewright MCP tool calls and manage local state
    TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
    TOOL_RESULT=$(echo "$HOOK_INPUT" | jq -r '.tool_response // .tool_response // empty' 2>/dev/null || true)

    # Match tool name regardless of prefix format (mcp__, plugin:, etc.)
    SW_ACTION=""
    case "$TOOL_NAME" in
      *statewright_start*) SW_ACTION="start" ;;
      *statewright_load_workflow*) SW_ACTION="start" ;;
      *statewright_stop*) SW_ACTION="stop" ;;
      *statewright_deactivate*) SW_ACTION="stop" ;;
      *statewright_pause*) SW_ACTION="stop" ;;
      *statewright_transition*) SW_ACTION="transition" ;;
      *statewright_force_state*) SW_ACTION="transition" ;;
      *statewright_get_state*) SW_ACTION="refresh_cache" ;;
    esac

    # capture.sh is deliberately opt-in and skips Statewright control tools.
    # Dispatch ordinary tool completions here; merely creating
    # .capture_enabled does not persist a log by itself.
    if [ -f "$PROJECT_DIR/.capture_enabled" ] && [ -z "$SW_ACTION" ]; then
      printf '%s' "$HOOK_INPUT" | bash "${STATEWRIGHT_CAPTURE_SCRIPT:-$SCRIPT_DIR/capture.sh}" >/dev/null 2>&1 &
    fi

    # --- Interrupt detection for file-changing tools (Edit, Write, MultiEdit) ---
    if [ -f "$ACTIVE_FILE" ] && [ -z "$SW_ACTION" ] && [ -f "$CACHE_FILE" ]; then
      FILE_PATH=""
      case "$TOOL_NAME" in
        Edit|Write|MultiEdit|apply_patch|edit_file|write_file|create_or_update_file)
          FILE_PATH=$(echo "$HOOK_INPUT" | jq -r '.tool_input.file_path // .tool_input.path // .tool_input.file // empty' 2>/dev/null || true)
          ;;
      esac

      if [ -n "$FILE_PATH" ]; then
        # Normalize to relative path (Edit/Write pass absolute paths)
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
        PARSED=$(extract_mcp_result_text "$TOOL_RESULT")
        STATE_JSON=$(echo "$PARSED" | jq -c '.state_snapshot // empty' 2>/dev/null || true)
        if [ -z "$STATE_JSON" ] || [ "$STATE_JSON" = "null" ]; then
          jq -n \
            --arg tool "$TOOL_NAME" \
            '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:("[statewright] " + $tool + " did not return an authoritative state snapshot. Enforcement was not activated; reload the workflow after updating the gateway.")}}'
          exit 0
        fi

        # Activate enforcement only after the exact load response is available.
        mkdir -p "$PROJECT_DIR"
        rm -f "$PROJECT_DIR/.capture_enabled" "$PROJECT_DIR/.run_id" "$PROJECT_DIR/.log_seq" "$PROJECT_DIR/.telemetry_seq"
        echo "{\"activated\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$ACTIVE_FILE"
        echo "$STATE_JSON" > "$CACHE_FILE"
        reset_native_telemetry_state 1

        RUN_ID=$(echo "$STATE_JSON" | jq -r '.run_id // empty' 2>/dev/null || true)
        CAPTURE=$(echo "$STATE_JSON" | jq -r '.capture_output // false' 2>/dev/null || true)
        [ -n "$RUN_ID" ] && echo "$RUN_ID" > "$PROJECT_DIR/.run_id"
        [ "$CAPTURE" = "true" ] && touch "$PROJECT_DIR/.capture_enabled"
        emit_native_telemetry "workflow_loaded" "$STATE_JSON"
        request_interactive_route_restart "$STATE_JSON"
        # Tell the agent to start working immediately
        INIT_STATE=$(echo "$STATE_JSON" | jq -r '.state // empty' 2>/dev/null || true)
        INIT_TOOLS=$(echo "$STATE_JSON" | jq -r '.allowed_tools | join(", ")' 2>/dev/null || true)
        INIT_TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event + " -> " + .target) | join(", ")' 2>/dev/null || true)
        INIT_INSTRUCTIONS=$(echo "$STATE_JSON" | jq -r '.instructions // empty' 2>/dev/null || true)
        echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] Workflow loaded. Phase: ${INIT_STATE}. Tools: ${INIT_TOOLS}. Transitions: ${INIT_TRANSITIONS}. KEEP WORKING -- begin the ${INIT_STATE} phase immediately. Do not stop or summarize.${INIT_INSTRUCTIONS:+ Instructions: $INIT_INSTRUCTIONS}\"}}"
        ;;
      stop)
        # Deactivate enforcement
        rm -f "$ACTIVE_FILE" "$CACHE_FILE" "$PROJECT_DIR/.session_hinted" "$PROJECT_DIR/.discovered_commands" "$PROJECT_DIR/.capture_enabled" "$PROJECT_DIR/.run_id" "$PROJECT_DIR/.log_seq" "$PROJECT_DIR/.telemetry_seq" "$PROJECT_DIR/.state_epoch" "$PROJECT_DIR/.state_effective_at" "$PROJECT_DIR/.telemetry_tool_bytes" "$PROJECT_DIR/.telemetry_tool_count"
        ;;
      transition)
        # Read previous state before refreshing
        PREV_STATE=$(cat "$CACHE_FILE" 2>/dev/null | jq -r '.state // empty' 2>/dev/null || true)

        # Check for fork/join results in tool output
        PARSED_RESULT=$(extract_mcp_result_text "$TOOL_RESULT")

        IS_FORK=$(echo "$PARSED_RESULT" | jq -r '.forked // false' 2>/dev/null || true)
        IS_JOIN=$(echo "$PARSED_RESULT" | jq -r '.joined // false' 2>/dev/null || true)
        IS_BRANCH_DONE=$(echo "$PARSED_RESULT" | jq -r '.branch_completed // empty' 2>/dev/null || true)

        # Refresh cache after transition
        STATE_JSON=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}')
        if [ -n "$STATE_JSON" ]; then
          echo "$STATE_JSON" > "$CACHE_FILE"
          NEW_STATE=$(echo "$STATE_JSON" | jq -r '.state // empty' 2>/dev/null || true)
          IS_FINAL=$(echo "$STATE_JSON" | jq -r '.is_final // false' 2>/dev/null || true)
          PREV_EPOCH=$(cat "$PROJECT_DIR/.state_epoch" 2>/dev/null || echo "0")
          case "$PREV_EPOCH" in ''|*[!0-9]*) PREV_EPOCH=0 ;; esac
          reset_native_telemetry_state $((PREV_EPOCH + 1))
          if [ "$IS_FINAL" = "true" ]; then
            emit_native_telemetry "workflow_completed" "$STATE_JSON"
          else
            emit_native_telemetry "state_boundary" "$STATE_JSON"
            request_interactive_route_restart "$STATE_JSON"
          fi

          if [ "$IS_FORK" = "true" ]; then
            # Fork transition — show branches and agent coordination instructions
            BRANCHES=$(echo "$PARSED_RESULT" | jq -r '.branches | keys | join(", ")' 2>/dev/null || true)
            BRANCH_COUNT=$(echo "$PARSED_RESULT" | jq -r '.branches | length' 2>/dev/null || true)
            CURRENT=$(echo "$PARSED_RESULT" | jq -r '.current_branch // empty' 2>/dev/null || true)
            NEXT_TOOLS=$(echo "$STATE_JSON" | jq -r '.allowed_tools | join(", ")' 2>/dev/null || true)
            INSTRUCTIONS=$(echo "$STATE_JSON" | jq -r '.instructions // empty' 2>/dev/null || true)
            # For parallel execution: spawn N fork-branch-worker agents, then WAIT for all N task-notifications before proceeding.
            # The gateway auto-joins via BRANCH_DONE MCP calls, but you must wait for all agent notifications to confirm completion.
            # Do NOT check get_state to determine fork completion -- wait for the notifications.
            echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] FORK: ${BRANCH_COUNT} branches [${BRANCHES}]. For parallel: spawn ${BRANCH_COUNT} fork-branch-worker agents (one per branch), then WAIT for all ${BRANCH_COUNT} task-notification events before proceeding. Do NOT call get_state to check fork status -- the gateway joins via MCP but notifications arrive separately. For sequential: work branch '${CURRENT}' first.${INSTRUCTIONS:+ Instructions: $INSTRUCTIONS}\"}}"
          elif [ "$IS_JOIN" = "true" ]; then
            # Join completed — show post-join state
            JOIN_TO=$(echo "$PARSED_RESULT" | jq -r '.to // empty' 2>/dev/null || true)
            NEXT_TOOLS=$(echo "$STATE_JSON" | jq -r '.allowed_tools | join(", ")' 2>/dev/null || true)
            NEXT_TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event + " -> " + .target) | join(", ")' 2>/dev/null || true)
            echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] FORK JOIN complete. All branches done. Now in ${JOIN_TO}. Tools: ${NEXT_TOOLS}. Transitions: ${NEXT_TRANSITIONS}.\"}}"
          elif [ -n "$IS_BRANCH_DONE" ]; then
            # Branch completed, more to go
            NEXT_BRANCH=$(echo "$PARSED_RESULT" | jq -r '.next_branch // empty' 2>/dev/null || true)
            REMAINING=$(echo "$PARSED_RESULT" | jq -r '.remaining // 0' 2>/dev/null || true)
            NEXT_TOOLS=$(echo "$STATE_JSON" | jq -r '.allowed_tools | join(", ")' 2>/dev/null || true)
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
            rm -f "$ACTIVE_FILE" "$CACHE_FILE" "$PROJECT_DIR/.session_hinted" "$PROJECT_DIR/.discovered_commands" "$PROJECT_DIR/.capture_enabled" "$PROJECT_DIR/.run_id" "$PROJECT_DIR/.log_seq" "$PROJECT_DIR/.telemetry_seq" "$PROJECT_DIR/.state_epoch" "$PROJECT_DIR/.state_effective_at" "$PROJECT_DIR/.telemetry_tool_bytes" "$PROJECT_DIR/.telemetry_tool_count"
            echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] ${PREV_STATE} => ${NEW_STATE} (workflow complete, enforcement deactivated)\"}}"
          elif [ -n "$NEW_STATE" ]; then
            NEXT_TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event + " -> " + .target) | join(", ")' 2>/dev/null || true)
            NEXT_TOOLS=$(echo "$STATE_JSON" | jq -r '.allowed_tools | join(", ")' 2>/dev/null || true)
            if [ -n "$PREV_STATE" ]; then
              echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] ${PREV_STATE} => ${NEW_STATE}. Tools: ${NEXT_TOOLS}. Next transitions: ${NEXT_TRANSITIONS}. Use ONLY these exact event names with statewright_transition. KEEP WORKING -- do not stop or wait for user input.\"}}"
            else
              echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] Now in ${NEW_STATE}. Tools: ${NEXT_TOOLS}. Next transitions: ${NEXT_TRANSITIONS}. Use ONLY these exact event names with statewright_transition. KEEP WORKING -- do not stop or wait for user input.\"}}"
            fi
          fi
        fi
        ;;
      refresh_cache)
        # Silently update cache from gateway state (catches force_state drift)
        if [ -f "$ACTIVE_FILE" ]; then
          STATE_JSON=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}')
          if [ -n "$STATE_JSON" ]; then
            echo "$STATE_JSON" > "$CACHE_FILE"
          fi
        fi
        ;;
    esac
    if [ -f "$ACTIVE_FILE" ] && [ -z "$SW_ACTION" ] && [ -f "$CACHE_FILE" ]; then
      emit_native_telemetry "tool_observed" "$(cat "$CACHE_FILE")"
    fi
    exit 0
    ;;

  stop)
    # Review gates are surfaced from PostToolUse. Stop must never suppress the
    # host UI's prompt or an external review integration.
    exit 0
    ;;

  *)
    exit 0
    ;;
esac
