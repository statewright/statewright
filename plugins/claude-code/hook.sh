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

# Session-scoped state: use session_id from hook input or CLAUDE_SESSION_ID env
HOOK_SESSION=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
SESSION_KEY="${HOOK_SESSION:-${CLAUDE_SESSION_ID:-$(printf '%s' "$PWD" | shasum -a 256 2>/dev/null | cut -c1-8 || echo "default")}}"
SESSION_KEY="${SESSION_KEY:0:12}"
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
    -d "$1" 2>/dev/null | perl -0777 -pe 's/[\x00-\x09\x0b-\x0c\x0e-\x1f]//g' | jq -r '.result.content[0].text // empty' 2>/dev/null || true
}

# ============================================================
# HOOK HANDLERS
# ============================================================

case "$ENDPOINT" in
  user-prompt)
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

    CONTEXT="Statewright workflow active. Phase: $CURRENT (iteration $ITER/$MAX). Tools: $TOOLS. ${INSTRUCTIONS:+Instructions: $INSTRUCTIONS. }Available transitions: $TRANSITIONS.${SM_CONTEXT:+ State context: $SM_CONTEXT.}${GUARDS_INFO:+ Guards: $GUARDS_INFO. When transitioning with guards, pass data: statewright_transition(event, data={key: value}).}${BLOCKED_ENV:+ BLOCKED env vars (do not use, do not access via env/printenv/.env files): $BLOCKED_ENV.}${ENV_OVERRIDES:+ Use these env vars instead: $ENV_OVERRIDES.}${AVAILABLE_CMDS:+ PREFER these commands over raw shell: $AVAILABLE_CMDS.} When calling statewright_transition, ALWAYS include a data param: statewright_transition(event='EVENT', data={'rationale': 'why you are transitioning', ...any state context fields that guards may check}). This updates the state context for guard evaluation and creates an audit trail."
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

    # Check if tool is allowed
    if echo "$ALLOWED" | grep -qx "$TOOL_NAME"; then
      # Tool name is in allowed_tools — but if it's Bash, classify the command
      # to prevent bypass of Write/Edit/Destructive restrictions via shell redirects
      if [ "$TOOL_NAME" = "Bash" ]; then
        COMMAND=$(echo "$HOOK_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
        if [ -n "$COMMAND" ]; then
          # Check for file write operations (redirects, heredocs) when Write/Edit not allowed
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
            while IFS= read -r prefix; do
              case "$COMMAND" in "$prefix"|"$prefix "*) CMD_OK=true; break ;; esac
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
    esac

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
        ;;
      stop)
        # Deactivate enforcement
        rm -f "$ACTIVE_FILE" "$CACHE_FILE" "$PROJECT_DIR/.session_hinted" "$PROJECT_DIR/.discovered_commands" "$PROJECT_DIR/.capture_enabled" "$PROJECT_DIR/.run_id" "$PROJECT_DIR/.log_seq"
        ;;
      transition)
        # Read previous state before refreshing
        PREV_STATE=$(cat "$CACHE_FILE" 2>/dev/null | jq -r '.state // empty' 2>/dev/null || true)
        # Refresh cache after transition
        STATE_JSON=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}')
        if [ -n "$STATE_JSON" ]; then
          echo "$STATE_JSON" > "$CACHE_FILE"
          NEW_STATE=$(echo "$STATE_JSON" | jq -r '.state // empty' 2>/dev/null || true)
          IS_FINAL=$(echo "$STATE_JSON" | jq -r '.is_final // false' 2>/dev/null || true)
          if [ "$IS_FINAL" = "true" ]; then
            rm -f "$ACTIVE_FILE" "$CACHE_FILE" "$PROJECT_DIR/.session_hinted" "$PROJECT_DIR/.discovered_commands" "$PROJECT_DIR/.capture_enabled" "$PROJECT_DIR/.run_id" "$PROJECT_DIR/.log_seq"
            echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] ${PREV_STATE} => ${NEW_STATE} (workflow complete, enforcement deactivated)\"}}"
          elif [ -n "$NEW_STATE" ]; then
            NEXT_TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event + " -> " + .target) | join(", ")' 2>/dev/null || true)
            NEXT_TOOLS=$(echo "$STATE_JSON" | jq -r '.allowed_tools | join(", ")' 2>/dev/null || true)
            if [ -n "$PREV_STATE" ]; then
              echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] ${PREV_STATE} => ${NEW_STATE}. Tools: ${NEXT_TOOLS}. Next transitions: ${NEXT_TRANSITIONS}. Use ONLY these exact event names with statewright_transition.\"}}"
            else
              echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] Now in ${NEW_STATE}. Tools: ${NEXT_TOOLS}. Next transitions: ${NEXT_TRANSITIONS}. Use ONLY these exact event names with statewright_transition.\"}}"
            fi
          fi
        fi
        ;;
    esac
    exit 0
    ;;

  stop)
    # Clean up session state on Claude Code exit
    rm -f "$ACTIVE_FILE" "$CACHE_FILE" "$PROJECT_DIR/.session_hinted" "$PROJECT_DIR/.discovered_commands" "$PROJECT_DIR/.capture_enabled" "$PROJECT_DIR/.run_id" "$PROJECT_DIR/.log_seq"
    exit 0
    ;;

  *)
    exit 0
    ;;
esac
