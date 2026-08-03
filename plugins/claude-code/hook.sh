#!/usr/bin/env bash
# Statewright Claude Code plugin hook
# Dormant by default — only enforces when a workflow is explicitly activated
# via MCP tool (statewright_start) or slash command (/statewright)
set -o pipefail

ENDPOINT="${1:-user-prompt}"
HOOK_INPUT=$(cat 2>/dev/null || true)

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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=client-id.sh
source "${SCRIPT_DIR}/client-id.sh"

# Session-scoped state: use session_id from hook input or CLAUDE_SESSION_ID env
HOOK_SESSION=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
SESSION_KEY="${HOOK_SESSION:-${CLAUDE_SESSION_ID:-$(printf '%s' "$PWD" | shasum -a 256 2>/dev/null | cut -c1-8 || echo "default")}}"
SESSION_KEY="${SESSION_KEY:0:12}"
CLIENT_ID=$(statewright_client_id "$HOOK_SESSION")
SESSION_HEADER_ARGS=(-H "X-Statewright-Client-Id: ${CLIENT_ID}")
if [ -n "${STATEWRIGHT_MCP_SESSION_ID:-}" ]; then
  SESSION_HEADER_ARGS+=(-H "Mcp-Session-Id: ${STATEWRIGHT_MCP_SESSION_ID}")
fi
PROJECT_DIR="$STATEWRIGHT_DIR/sessions/$SESSION_KEY"
ACTIVE_FILE="$PROJECT_DIR/.active"
CACHE_FILE="$PROJECT_DIR/.state_cache"

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

adapter_call() {
  local endpoint="$1" method="${2:-GET}" body="${3:-}"
  [ -n "${STATEWRIGHT_ADAPTER_URL:-}" ] || return 1
  local args=(-sf --max-time 5 -X "$method" "${STATEWRIGHT_ADAPTER_URL%/}/hooks/${endpoint}")
  [ -n "${STATEWRIGHT_ADAPTER_TOKEN:-}" ] && args+=(-H "Authorization: Bearer ${STATEWRIGHT_ADAPTER_TOKEN}")
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data-binary "$body")
  fi
  curl "${args[@]}" 2>/dev/null
}

# ============================================================
# HOOK HANDLERS
# ============================================================

case "$ENDPOINT" in
  user-prompt)
    # --- Plugin update check (24h TTL, async, opt-out via STATEWRIGHT_NO_UPDATE_CHECK) ---
    if [ -z "${STATEWRIGHT_NO_UPDATE_CHECK:-}" ]; then
      UPDATE_CACHE="$STATEWRIGHT_DIR/.update_cache"
      NEEDS_CHECK=true
      if [ -f "$UPDATE_CACHE" ]; then
        CACHE_AGE=$(( $(date +%s) - $(stat -f %m "$UPDATE_CACHE" 2>/dev/null || stat -c %Y "$UPDATE_CACHE" 2>/dev/null || echo 0) ))
        [ "$CACHE_AGE" -lt 86400 ] && NEEDS_CHECK=false
      fi
      if [ "$NEEDS_CHECK" = true ]; then
        mkdir -p "$STATEWRIGHT_DIR"
        LOCAL_VER=$(jq -r '.version // "0.0.0"' "$(dirname "$0")/plugin.json" 2>/dev/null || echo "0.0.0")
        PB_URL="${STATEWRIGHT_PB_URL:-https://statewright.ai}"
        REMOTE_VER=$(curl -sf --max-time 3 "${PB_URL}/api/plugins/versions" 2>/dev/null | jq -r '.versions["claude-code"] // empty' 2>/dev/null || true)
        echo "{\"version\":\"${LOCAL_VER}\",\"latest\":\"${REMOTE_VER}\",\"checked\":$(date +%s)}" > "$UPDATE_CACHE"
        if [ -n "$REMOTE_VER" ] && [ "$LOCAL_VER" != "$REMOTE_VER" ]; then
          echo "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"Statewright plugin update available: v${LOCAL_VER} → v${REMOTE_VER}. Run: /plugin install statewright to update. Suppress with STATEWRIGHT_NO_UPDATE_CHECK=1.\"}}"
        fi
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
    if [ ! -f "$ACTIVE_FILE" ] && [ -z "${STATEWRIGHT_EXECUTOR_ID:-}" ]; then
      HINT_FILE="$PROJECT_DIR/.session_hinted"
      if [ ! -f "$HINT_FILE" ]; then
        mkdir -p "$PROJECT_DIR"
        touch "$HINT_FILE"
        echo "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"Statewright plugin active. No workflow running. To start one, use statewright_start(workflow='bugfix') or statewright_list_workflows() to see available workflows.\"}}"
      fi
      exit 0
    fi

    # --- Active workflow: fetch state from gateway ---
    if [ -n "${STATEWRIGHT_ADAPTER_URL:-}" ]; then
      STATE_JSON=$(adapter_call state GET || true)
    else
      STATE_JSON=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}')
    fi
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
    MODEL=$(echo "$STATE_JSON" | jq -r '.model // empty' 2>/dev/null || true)
    DEFAULT_MODEL=$(echo "$STATE_JSON" | jq -r '.default_model // empty' 2>/dev/null || true)
    THINKING_LEVEL=$(echo "$STATE_JSON" | jq -r '.thinking_level // empty' 2>/dev/null || true)
    DELIVERY_REQUIRED=$(echo "$STATE_JSON" | jq -r '(.meta.workspace.required // false) or (.meta.preview.required // false) or (.meta.promotion.required // false)' 2>/dev/null || true)

    EXECUTOR_DELIVERY=$(echo "$STATE_JSON" | jq -r '.executor.delivery // false' 2>/dev/null || true)
    if [ "$DELIVERY_REQUIRED" = "true" ] && [ "$EXECUTOR_DELIVERY" != "true" ]; then
      echo '{"decision":"block","reason":"This workflow requires isolated delivery. Launch it through the Statewright executor so it owns the delivery lifecycle.","hookSpecificOutput":{"hookEventName":"UserPromptSubmit"}}'
      exit 0
    fi

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

    MODEL_NOTE=""
    if [ -n "$MODEL" ]; then
      if [ -n "$DEFAULT_MODEL" ] && [ "$MODEL" != "$DEFAULT_MODEL" ]; then
        MODEL_NOTE=" Recommended model for this phase: $MODEL (workflow default: $DEFAULT_MODEL). Use /model to switch if supported."
      else
        MODEL_NOTE=" Recommended model for this phase: $MODEL. Use /model to switch if supported."
      fi
    fi
    if [ -n "$THINKING_LEVEL" ]; then
      MODEL_NOTE="${MODEL_NOTE} Recommended effort for this phase: $THINKING_LEVEL. Claude hooks cannot switch effort inside an active session; start or resume with --effort $THINKING_LEVEL when a launcher owns the boundary."
    fi
    CONTEXT="Statewright workflow active. AUTONOMOUS MODE: work continuously through each state — use tools, complete the work, transition, and keep going. Do NOT stop or ask the user between states. Only pause at approval gates (requires_approval) or final states. Phase: $CURRENT (iteration $ITER/$MAX). Tools: $TOOLS. MANDATORY: Every statewright_transition call MUST include data.rationale explaining WHY you are transitioning. Format: statewright_transition(event='EVENT', data={'rationale': 'specific reason', ...guard fields}). Available transitions: $TRANSITIONS.${SM_CONTEXT:+ State context: $SM_CONTEXT.}${GUARDS_INFO:+ Guards: $GUARDS_INFO.}${BLOCKED_ENV:+ BLOCKED env vars (do not use): $BLOCKED_ENV.}${ENV_OVERRIDES:+ Use these env vars instead: $ENV_OVERRIDES.}${AVAILABLE_CMDS:+ PREFER these commands over raw shell: $AVAILABLE_CMDS.}${MODEL_NOTE}${INSTRUCTIONS:+ Instructions: $INSTRUCTIONS.}"
    jq -n --arg ctx "$CONTEXT" '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":$ctx}}'
    exit 0
    ;;

  pre-tool)
    # --- No active workflow: allow everything (dormant) ---
    if [ ! -f "$ACTIVE_FILE" ] && [ -z "${STATEWRIGHT_EXECUTOR_ID:-}" ]; then
      exit 0
    fi

    TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)

    if [ -n "${STATEWRIGHT_ADAPTER_URL:-}" ]; then
      case "$TOOL_NAME" in
        *statewright_*|TodoRead|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskStop|TaskOutput|SendMessage|AskUserQuestion|ExitPlanMode|ToolSearch|Skill) exit 0 ;;
      esac
      TOOL_INPUT=$(echo "$HOOK_INPUT" | jq -c '.tool_input // {}' 2>/dev/null || echo '{}')
      REQUEST=$(jq -cn --arg name "$TOOL_NAME" --argjson input "$TOOL_INPUT" \
        '{tool_name:$name,tool_input:$input}')
      RESPONSE=$(adapter_call pre-tool POST "$REQUEST" || true)
      if [ -z "$RESPONSE" ]; then
        jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Statewright executor bridge is unavailable; refusing an unguarded tool call."}}'
        exit 0
      fi
      DECISION=$(echo "$RESPONSE" | jq -r '.decision // "allow"')
      if [ "$DECISION" = "deny" ]; then
        REASON=$(echo "$RESPONSE" | jq -r '.reason // "Blocked by Statewright"')
        jq -n --arg r "$REASON" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
      fi
      exit 0
    fi

    # Block Agent calls with worktree isolation during active forks — branches must edit in-place
    if [ "$TOOL_NAME" = "Agent" ]; then
      AGENT_ISOLATION=$(echo "$HOOK_INPUT" | jq -r '.tool_input.isolation // empty' 2>/dev/null || true)
      if [ "$AGENT_ISOLATION" = "worktree" ] && [ -f "$CACHE_FILE" ]; then
        HAS_FORK=$(cat "$CACHE_FILE" | jq -r '.context._fork // .fork.active // empty' 2>/dev/null || true)
        if [ -n "$HAS_FORK" ]; then
          jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: Do not use isolation: worktree for fork branches. Fork-branch-workers must edit files in-place in the working directory. Remove the isolation parameter and retry."}}'
          exit 0
        fi
      fi
      exit 0
    fi

    # Always allow system/internal/MCP tools
    case "$TOOL_NAME" in
      *statewright_*|TodoRead|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskStop|TaskOutput|SendMessage|AskUserQuestion|ExitPlanMode|ToolSearch|Skill) exit 0 ;;
    esac

    # Read cached state (written by UserPromptSubmit — ZERO network calls)
    if [ ! -f "$CACHE_FILE" ]; then
      exit 0  # No cache = no enforcement yet
    fi

    STATE_JSON=$(cat "$CACHE_FILE")
    DELIVERY_REQUIRED=$(echo "$STATE_JSON" | jq -r '(.meta.workspace.required // false) or (.meta.preview.required // false) or (.meta.promotion.required // false)' 2>/dev/null || true)
    if [ "$DELIVERY_REQUIRED" = "true" ] && [ "${STATEWRIGHT_DELIVERY_ACTIVE:-}" != "1" ]; then
      jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"This workflow requires isolated delivery. Launch it through the Statewright executor so it owns the delivery lifecycle."}}'
      exit 0
    fi

    # Fork enforcement: during an active fork, the cached state is already branch-specific
    # (get_state returns the current branch's state for sequential execution). For parallel
    # forks, multiple workers share the cache — use the cached allowed_tools as-is since
    # it reflects the most recently fetched branch state. Per-branch structural enforcement
    # for parallel forks requires per-branch MCP sessions.
    # Until then, parallel branch scoping is cooperative (prompt-based).
    ALLOWED=$(echo "$STATE_JSON" | jq -r '.allowed_tools // [] | .[]' 2>/dev/null || true)
    CURRENT=$(echo "$STATE_JSON" | jq -r '.state // "unknown"' 2>/dev/null || true)
    TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event) | join(", ")' 2>/dev/null || true)

    if [ -z "$ALLOWED" ]; then
      exit 0  # No allowed_tools list = no enforcement
    fi

    # Check if tool is allowed
    if echo "$ALLOWED" | grep -qx "$TOOL_NAME"; then
      # Tool name is in allowed_tools — but if it's Bash, classify the command
      # to prevent bypass of Write/Edit/Destructive restrictions via shell redirects
      if [ "$TOOL_NAME" = "Bash" ]; then
        COMMAND=$(echo "$HOOK_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
        if [ -n "$COMMAND" ]; then
          # Check for destructive operations first (always blocked regardless of allowed_commands)
          if echo "$COMMAND" | grep -qE '^\s*(rm|rmdir|shred|truncate|unlink)\s'; then
            jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Destructive operation not permitted in this phase."}}'
            exit 0
          fi
          if echo "$COMMAND" | grep -qE '(&&|;)\s*(rm|rmdir|shred|truncate|unlink)\s'; then
            jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Destructive operation not permitted in this phase."}}'
            exit 0
          fi
          # Check allowed_commands — if present, overrides heuristic blocks (glob patterns supported)
          ALLOWED_CMDS=$(echo "$STATE_JSON" | jq -r '.allowed_commands // [] | .[]' 2>/dev/null || true)
          if [ -n "$ALLOWED_CMDS" ]; then
            CMD_OK=false
            while IFS= read -r pattern; do
              # shellcheck disable=SC2254 — intentional glob expansion for wildcard patterns
              case "$COMMAND" in $pattern) CMD_OK=true; break ;; esac
            done <<< "$ALLOWED_CMDS"
            if [ "$CMD_OK" = false ]; then
              REASON="Bash command blocked: not in allowed commands for '$CURRENT' phase."
              jq -n --arg r "$REASON" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
              exit 0
            fi
          else
            # Default heuristics when no explicit allowed_commands
            HAS_WRITE=$(echo "$ALLOWED" | grep -qx "Write" && echo "yes" || echo "no")
            HAS_EDIT=$(echo "$ALLOWED" | grep -qx "Edit" && echo "yes" || echo "no")
            if [ "$HAS_WRITE" = "no" ] && [ "$HAS_EDIT" = "no" ]; then
              if echo "$COMMAND" | grep -qE '(^|[^0-9])>[^>&]|>>\s*\S'; then
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
    TOOL_RESULT=$(echo "$HOOK_INPUT" | jq -r '.tool_result // .tool_response // empty' 2>/dev/null || true)

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

    if [ -n "${STATEWRIGHT_ADAPTER_URL:-}" ] && [ -z "$SW_ACTION" ]; then
      TOOL_INPUT=$(echo "$HOOK_INPUT" | jq -c '.tool_input // {}' 2>/dev/null || echo '{}')
      IS_ERROR=$(echo "$HOOK_INPUT" | jq -r '.is_error // false' 2>/dev/null || echo false)
      REQUEST=$(jq -cn --arg name "$TOOL_NAME" --argjson input "$TOOL_INPUT" \
        --arg response "$TOOL_RESULT" --argjson is_error "$IS_ERROR" \
        '{tool_name:$name,tool_input:$input,tool_response:$response,is_error:$is_error}')
      RESPONSE=$(adapter_call post-tool POST "$REQUEST" || true)
      if [ -n "$RESPONSE" ]; then
        INTERRUPT_TO=$(echo "$RESPONSE" | jq -r '.interrupt.to // empty')
        if [ -n "$INTERRUPT_TO" ]; then
          jq -n --arg state "$INTERRUPT_TO" '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":("[statewright] Validation interrupt entered: " + $state + ". Continue under the new Statewright phase.")}}'
        fi
      fi
      exit 0
    fi

    # --- Interrupt detection for file-changing tools (Edit, Write, MultiEdit) ---
    if [ -f "$ACTIVE_FILE" ] && [ -z "$SW_ACTION" ] && [ -f "$CACHE_FILE" ]; then
      FILE_PATH=""
      case "$TOOL_NAME" in
        Edit|Write|MultiEdit|edit_file|write_file|create_or_update_file)
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
        # Activate enforcement
        mkdir -p "$PROJECT_DIR"
        rm -f "$PROJECT_DIR/.capture_enabled" "$PROJECT_DIR/.run_id" "$PROJECT_DIR/.log_seq"
        echo "{\"activated\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$ACTIVE_FILE"
        # Fetch and cache initial state
        STATE_JSON=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}')
        if [ -n "$STATE_JSON" ]; then
          echo "$STATE_JSON" > "$CACHE_FILE"
        fi
        # Check for capture_output + run_id from tool result
        if [ -n "$TOOL_RESULT" ]; then
          # tool_response is an array of content objects; extract the text, parse as JSON
          PARSED=$(echo "$TOOL_RESULT" | jq -r 'if type == "array" then .[0].text // empty else . end' 2>/dev/null || true)
          RUN_ID=$(echo "$PARSED" | jq -r '.run_id // empty' 2>/dev/null || true)
          CAPTURE=$(echo "$PARSED" | jq -r '.capture_output // false' 2>/dev/null || true)
          # Debug: persist what we got (not cleaned by final state handler)
          [ -n "$RUN_ID" ] && echo "$RUN_ID" > "$PROJECT_DIR/.run_id"
          [ "$CAPTURE" = "true" ] && touch "$PROJECT_DIR/.capture_enabled"
        fi
        # Tell the agent to start working immediately
        INIT_STATE=$(echo "$STATE_JSON" | jq -r '.state // empty' 2>/dev/null || true)
        INIT_TOOLS=$(echo "$STATE_JSON" | jq -r '.allowed_tools | join(", ")' 2>/dev/null || true)
        INIT_TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event + " -> " + .target) | join(", ")' 2>/dev/null || true)
        INIT_INSTRUCTIONS=$(echo "$STATE_JSON" | jq -r '.instructions // empty' 2>/dev/null || true)
        INIT_MODEL=$(echo "$STATE_JSON" | jq -r '.model // empty' 2>/dev/null || true)
        INIT_MODEL_NOTE=""
        [ -n "$INIT_MODEL" ] && INIT_MODEL_NOTE=" Recommended model: $INIT_MODEL."
        echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] Workflow loaded. Phase: ${INIT_STATE}. Tools: ${INIT_TOOLS}. Transitions: ${INIT_TRANSITIONS}.${INIT_MODEL_NOTE} KEEP WORKING -- begin the ${INIT_STATE} phase immediately. Do not stop or summarize.${INIT_INSTRUCTIONS:+ Instructions: $INIT_INSTRUCTIONS}\"}}"
        ;;
      stop)
        # Deactivate enforcement
        rm -f "$ACTIVE_FILE" "$CACHE_FILE" "$PROJECT_DIR/.session_hinted" "$PROJECT_DIR/.discovered_commands" "$PROJECT_DIR/.capture_enabled" "$PROJECT_DIR/.run_id" "$PROJECT_DIR/.log_seq"
        ;;
      transition)
        # Read previous state before refreshing
        PREV_STATE=$(cat "$CACHE_FILE" 2>/dev/null | jq -r '.state // empty' 2>/dev/null || true)

        # Check for fork/join results in tool output
        PARSED_RESULT=""
        if [ -n "$TOOL_RESULT" ]; then
          PARSED_RESULT=$(echo "$TOOL_RESULT" | jq -r 'if type == "array" then .[0].text // empty else . end' 2>/dev/null || true)
        fi

        IS_FORK=$(echo "$PARSED_RESULT" | jq -r '.forked // false' 2>/dev/null || true)
        IS_JOIN=$(echo "$PARSED_RESULT" | jq -r '.joined // false' 2>/dev/null || true)
        IS_BRANCH_DONE=$(echo "$PARSED_RESULT" | jq -r '.branch_completed // empty' 2>/dev/null || true)

        # Refresh cache after transition
        STATE_JSON=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}')
        if [ -n "$STATE_JSON" ]; then
          echo "$STATE_JSON" > "$CACHE_FILE"
          NEW_STATE=$(echo "$STATE_JSON" | jq -r '.state // empty' 2>/dev/null || true)
          IS_FINAL=$(echo "$STATE_JSON" | jq -r '.is_final // false' 2>/dev/null || true)

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
            rm -f "$ACTIVE_FILE" "$CACHE_FILE" "$PROJECT_DIR/.session_hinted" "$PROJECT_DIR/.discovered_commands" "$PROJECT_DIR/.capture_enabled" "$PROJECT_DIR/.run_id" "$PROJECT_DIR/.log_seq"
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
    exit 0
    ;;

  stop)
    if [ -n "${STATEWRIGHT_ADAPTER_URL:-}" ]; then
      RESPONSE=$(adapter_call stop POST '{}' || true)
      if [ -z "$RESPONSE" ]; then
        jq -n '{"decision":"block","reason":"Statewright executor bridge is unavailable; cannot verify workflow completion."}'
        exit 0
      fi
      DECISION=$(echo "$RESPONSE" | jq -r '.decision // "allow"')
      if [ "$DECISION" = "block" ]; then
        REASON=$(echo "$RESPONSE" | jq -r '.reason // "Continue the active Statewright workflow."')
        jq -n --arg reason "$REASON" '{"decision":"block","reason":$reason}'
      fi
      exit 0
    fi
    # Review gates are surfaced from PostToolUse. Stop must not suppress the
    # host UI's prompt or an external review integration.
    exit 0

    # Stop is the point at which Claude is about to yield. While a workflow is
    # nonfinal, block that yield and return the phase context so Claude can
    # continue without waiting for another user prompt.
    [ -f "$ACTIVE_FILE" ] || exit 0

    # Stop hooks have a short deadline. The post-transition handler refreshes
    # the cache, so use it as the fast-path authority and only ask the gateway
    # when this session has not established a cache yet.
    STATE_JSON=""
    CURRENT=""
    if [ -f "$CACHE_FILE" ]; then
      STATE_JSON=$(cat "$CACHE_FILE")
      CURRENT=$(echo "$STATE_JSON" | jq -r '.state // empty' 2>/dev/null || true)
    else
      STATE_JSON=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}')
      CURRENT=$(echo "$STATE_JSON" | jq -r '.state // empty' 2>/dev/null || true)
      if [ -n "$CURRENT" ]; then
        mkdir -p "$PROJECT_DIR"
        echo "$STATE_JSON" > "$CACHE_FILE"
      fi
    fi

    # Without a usable state source, do not trap Claude in an unresolvable
    # stop loop.
    [ -n "$CURRENT" ] || exit 0

    IS_FINAL=$(echo "$STATE_JSON" | jq -r '.is_final // false' 2>/dev/null || true)
    if [ "$IS_FINAL" = "true" ]; then
      rm -f "$ACTIVE_FILE" "$CACHE_FILE" "$PROJECT_DIR/.session_hinted" "$PROJECT_DIR/.discovered_commands" "$PROJECT_DIR/.capture_enabled" "$PROJECT_DIR/.run_id" "$PROJECT_DIR/.log_seq"
      exit 0
    fi

    ITER=$(echo "$STATE_JSON" | jq -r '.iteration // 0' 2>/dev/null || true)
    MAX=$(echo "$STATE_JSON" | jq -r '.max_iterations // "none"' 2>/dev/null || true)
    TOOLS=$(echo "$STATE_JSON" | jq -r '.allowed_tools // [] | join(", ")' 2>/dev/null || true)
    TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event + " -> " + .target) | join(", ")' 2>/dev/null || true)
    INSTRUCTIONS=$(echo "$STATE_JSON" | jq -r '.instructions // empty' 2>/dev/null || true)
    REASON="Statewright workflow remains active. Phase: $CURRENT (iteration $ITER/$MAX). Tools: $TOOLS. Transitions: $TRANSITIONS. CONTINUATION REQUIRED: do not stop, summarize, or wait for a new user prompt. Continue immediately with only the state-allowed tools, complete this phase, and call statewright_transition when its exit criteria are met.${INSTRUCTIONS:+ Instructions: $INSTRUCTIONS}"
    jq -n --arg reason "$REASON" '{"decision":"block","reason":$reason}'
    exit 0
    ;;

  permission-request)
    # --- Spec 27: Permission Auto-Responder ---
    # Four-tier decision stack for autonomous permission resolution.
    # Only fires when a tool IS about to be used but the runtime's native
    # permission system would normally prompt the human.

    # No active workflow: pass through to human
    if [ ! -f "$ACTIVE_FILE" ]; then
      exit 0
    fi

    # No cached state: pass through
    if [ ! -f "$CACHE_FILE" ]; then
      exit 0
    fi

    STATE_JSON=$(cat "$CACHE_FILE")

    # Check meta.autonomous — if false/unset, pass through to human
    AUTONOMOUS=$(echo "$STATE_JSON" | jq -r '.meta.autonomous // false' 2>/dev/null || true)
    if [ "$AUTONOMOUS" != "true" ]; then
      exit 0
    fi

    # Check danger_level — dangerous = all pass through to human
    DANGER=$(echo "$STATE_JSON" | jq -r '.meta.danger_level // "safe"' 2>/dev/null || true)
    if [ "$DANGER" = "dangerous" ]; then
      exit 0
    fi

    TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
    TOOL_INPUT=$(echo "$HOOK_INPUT" | jq -r '.tool_input // {}' 2>/dev/null || true)

    # --- Check if tool is in allowed_tools ---
    ALLOWED=$(echo "$STATE_JSON" | jq -r '.allowed_tools // [] | .[]' 2>/dev/null || true)

    if [ -z "$ALLOWED" ]; then
      exit 0  # No allowed_tools = no enforcement
    fi

    if ! echo "$ALLOWED" | grep -qx "$TOOL_NAME"; then
      # Tool NOT in allowed_tools — deny
      jq -n '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'
      exit 0
    fi

    # Tool IS in allowed_tools. Now evaluate the command (Bash-specific).
    if [ "$TOOL_NAME" = "Bash" ]; then
      COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // empty' 2>/dev/null || true)

      if [ -z "$COMMAND" ]; then
        # No command = allow (shouldn't happen but fail-open for non-Bash)
        jq -n '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        exit 0
      fi

      # --- Tier 2: Regex fast-deny (destructive patterns) ---
      # These are ALWAYS denied regardless of allowed_commands
      DENY=false

      # Destructive file operations
      if echo "$COMMAND" | grep -qE '^\s*(rm|rmdir|shred|truncate|unlink)\s'; then
        DENY=true
      fi
      # Destructive in pipeline/chain
      if echo "$COMMAND" | grep -qE '(&&|;|\|)\s*(rm|rmdir|shred|truncate|unlink)\s'; then
        DENY=true
      fi
      # Privilege escalation
      if echo "$COMMAND" | grep -qE '^\s*sudo\s'; then
        DENY=true
      fi
      # Dangerous permissions
      if echo "$COMMAND" | grep -qE 'chmod\s+(777|666|a\+w)'; then
        DENY=true
      fi
      # Remote code execution
      if echo "$COMMAND" | grep -qE 'curl\s.*\|\s*bash|wget\s.*\|\s*bash|curl\s.*\|\s*sh|wget\s.*\|\s*sh'; then
        DENY=true
      fi
      # Force push to main/master
      if echo "$COMMAND" | grep -qE 'git\s+push\s+--force.*\s+(main|master)'; then
        DENY=true
      fi
      # Fork bombs and disk wipes
      if echo "$COMMAND" | grep -qE ':\(\)\{|/dev/zero.*of=/dev/|/dev/random.*of=/dev/|mkfs\.' ; then
        DENY=true
      fi
      # dd to block devices
      if echo "$COMMAND" | grep -qE 'dd\s.*of=/dev/[a-z]'; then
        DENY=true
      fi

      if [ "$DENY" = true ]; then
        jq -n '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'
        exit 0
      fi

      # --- Tier 1: Check allowed_commands + safe patterns ---
      ALLOWED_CMDS=$(echo "$STATE_JSON" | jq -r '.allowed_commands // [] | .[]' 2>/dev/null || true)

      if [ -n "$ALLOWED_CMDS" ]; then
        # Has explicit allowed_commands — check if command matches
        CMD_OK=false
        while IFS= read -r pattern; do
          # shellcheck disable=SC2254 — intentional glob expansion
          case "$COMMAND" in $pattern) CMD_OK=true; break ;; esac
        done <<< "$ALLOWED_CMDS"

        if [ "$CMD_OK" = true ]; then
          # Command matches allowed_commands — Tier 1 allow
          jq -n '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
          exit 0
        else
          # Command not in allowed_commands — deny (moderate or safe, doesn't matter)
          jq -n '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'
          exit 0
        fi
      else
        # No explicit allowed_commands — use safe read-only heuristics
        # Safe patterns: ls, cat, head, tail, wc, file, find (no -exec), grep, tree, pwd, echo, date, env, which, type
        if echo "$COMMAND" | grep -qE '^\s*(ls|cat|head|tail|wc|file|tree|pwd|echo|date|env|which|type|stat|du|df|uname|whoami|id|hostname)\s'; then
          jq -n '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
          exit 0
        fi
        # Git read-only
        if echo "$COMMAND" | grep -qE '^\s*git\s+(status|log|diff|show|branch|tag|remote|stash list|rev-parse|describe)'; then
          jq -n '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
          exit 0
        fi
        # Build/test commands (common patterns)
        if echo "$COMMAND" | grep -qE '^\s*(cargo|npm|yarn|pnpm|bun|pytest|python -m pytest|go test|make|task)\s'; then
          jq -n '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
          exit 0
        fi
        # If we get here with no allowed_commands and no safe pattern match,
        # pass through to human (no auto-decision)
        exit 0
      fi
    fi

    # Non-Bash tool that IS in allowed_tools — auto-allow
    # (Read, Edit, Write, Grep, Glob, etc.)
    jq -n '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
    ;;

  *)
    exit 0
    ;;
esac
