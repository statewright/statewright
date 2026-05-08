#!/usr/bin/env bash
# Statewright Claude Code plugin hook
# Dormant by default — only enforces when a workflow is explicitly activated
# via MCP tool (statewright_start) or slash command (/statewright)
set -o pipefail

ENDPOINT="${1:-user-prompt}"
HOOK_INPUT=$(cat 2>/dev/null || true)

STATEWRIGHT_DIR="${HOME}/.statewright"
API_KEY="${STATEWRIGHT_API_KEY:-$(cat "$STATEWRIGHT_DIR/api_key" 2>/dev/null || true)}"
GW_URL="${STATEWRIGHT_GATEWAY_URL:-https://mcp.statewright.ai}"
ACTIVE_FILE="$STATEWRIGHT_DIR/.active"
CACHE_FILE="$STATEWRIGHT_DIR/.state_cache"

# --- Auto-bootstrap settings.json + MCP config ---
SETTINGS="$HOME/.claude/settings.json"
MCP_CONFIG="$HOME/.claude/.mcp.json"
NEEDS_BOOTSTRAP=false

# Check hooks
if [ ! -f "$SETTINGS" ] || ! grep -q "statewright" "$SETTINGS" 2>/dev/null; then
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
    -d "$1" 2>/dev/null | jq -r '.result.content[0].text // empty' 2>/dev/null || true
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
        PASTED_KEY=$(echo "$HOOK_INPUT" | grep -o 'sw_live_[a-f0-9]*')
        echo "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"The user pasted their statewright API key. Run this command to save it: mkdir -p ~/.statewright && echo '$PASTED_KEY' > ~/.statewright/api_key && chmod 600 ~/.statewright/api_key — then confirm it is saved and tell them they can activate a workflow with: statewright_start(workflow='bugfix')\"}}"
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

    # --- No active workflow: hint on first prompt of session ---
    if [ ! -f "$ACTIVE_FILE" ]; then
      HINT_FILE="$STATEWRIGHT_DIR/.session_hinted"
      if [ ! -f "$HINT_FILE" ]; then
        mkdir -p "$STATEWRIGHT_DIR"
        touch "$HINT_FILE"
        echo "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"Statewright plugin active. No workflow running. To start one, use statewright_start(workflow='bugfix') or statewright_list_workflows() to see available workflows.\"}}"
      fi
      exit 0
    fi

    # --- Active workflow: inject state context ---
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
      rm -f "$ACTIVE_FILE" "$CACHE_FILE" "$STATEWRIGHT_DIR/.session_hinted"
      echo "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"[statewright] Workflow complete. Final state: $CURRENT. Enforcement deactivated.\"}}"
      exit 0
    fi

    # Write state cache for PreToolUse (zero-network enforcement)
    mkdir -p "$STATEWRIGHT_DIR"
    echo "$STATE_JSON" > "$CACHE_FILE"

    # Build context
    ITER=$(echo "$STATE_JSON" | jq -r '.iteration // 0' 2>/dev/null || true)
    MAX=$(echo "$STATE_JSON" | jq -r '.max_iterations // "none"' 2>/dev/null || true)
    TOOLS=$(echo "$STATE_JSON" | jq -r '.allowed_tools | join(", ")' 2>/dev/null || true)
    INSTRUCTIONS=$(echo "$STATE_JSON" | jq -r '.instructions // empty' 2>/dev/null || true)
    TRANSITIONS=$(echo "$STATE_JSON" | jq -r '.transitions // [] | map(.event + " -> " + .target) | join(", ")' 2>/dev/null || true)

    BLOCKED_ENV=$(echo "$STATE_JSON" | jq -r '.blocked_env // [] | join(", ")' 2>/dev/null || true)
    ENV_OVERRIDES=$(echo "$STATE_JSON" | jq -r '.env_overrides // {} | to_entries | map(.key + "=" + .value) | join(", ")' 2>/dev/null || true)

    CONTEXT="Statewright workflow active. Phase: $CURRENT (iteration $ITER/$MAX). Tools: $TOOLS. ${INSTRUCTIONS:+Instructions: $INSTRUCTIONS. }Available transitions: $TRANSITIONS.${BLOCKED_ENV:+ BLOCKED env vars (do not use, do not access via env/printenv/.env files): $BLOCKED_ENV.}${ENV_OVERRIDES:+ Use these env vars instead: $ENV_OVERRIDES.} Use statewright_transition(event) MCP tool to advance."
    CONTEXT=$(echo "$CONTEXT" | sed 's/"/\\"/g')
    echo "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"$CONTEXT\"}}"
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
      statewright_*|mcp__statewright*|TodoRead|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskStop|TaskOutput|Agent|SendMessage|AskUserQuestion|ExitPlanMode) exit 0 ;;
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
            if echo "$COMMAND" | grep -qE '>[^>2]|>>\s*\S'; then
              REASON="Bash command blocked: output redirect detected but Write/Edit not in allowed tools for '$CURRENT' phase."
              REASON=$(echo "$REASON" | sed 's/"/\\"/g')
              echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$REASON\"}}"
              exit 0
            fi
            if echo "$COMMAND" | grep -qE 'sed\s+-i|perl\s+-p?i'; then
              REASON="Bash command blocked: in-place file modification detected but Edit not in allowed tools for '$CURRENT' phase."
              REASON=$(echo "$REASON" | sed 's/"/\\"/g')
              echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$REASON\"}}"
              exit 0
            fi
          fi
          # Check for destructive operations (always blocked in restricted states)
          if echo "$COMMAND" | grep -qE '^\s*(rm|rmdir|shred|truncate|unlink)\s'; then
            REASON="Bash command blocked: destructive operation (rm/shred/truncate) not permitted in '$CURRENT' phase."
            REASON=$(echo "$REASON" | sed 's/"/\\"/g')
            echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$REASON\"}}"
            exit 0
          fi
          # Check for destructive ops after && or ;
          if echo "$COMMAND" | grep -qE '(&&|;)\s*(rm|rmdir|shred|truncate|unlink)\s'; then
            REASON="Bash command blocked: destructive operation not permitted in '$CURRENT' phase."
            REASON=$(echo "$REASON" | sed 's/"/\\"/g')
            echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$REASON\"}}"
            exit 0
          fi
          # Check allowed_commands from cache if present
          ALLOWED_CMDS=$(echo "$STATE_JSON" | jq -r '.allowed_commands // [] | .[]' 2>/dev/null || true)
          if [ -n "$ALLOWED_CMDS" ]; then
            CMD_OK=false
            while IFS= read -r prefix; do
              case "$COMMAND" in "$prefix"*) CMD_OK=true; break ;; esac
            done <<< "$ALLOWED_CMDS"
            if [ "$CMD_OK" = false ]; then
              REASON="Bash command blocked: '$COMMAND' not in allowed commands for '$CURRENT' phase."
              REASON=$(echo "$REASON" | sed 's/"/\\"/g')
              echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$REASON\"}}"
              exit 0
            fi
          fi
          # Check blocked_env — deny commands referencing blocked environment variables
          BLOCKED_ENVS=$(echo "$STATE_JSON" | jq -r '.blocked_env // [] | .[]' 2>/dev/null || true)
          if [ -n "$BLOCKED_ENVS" ]; then
            while IFS= read -r bvar; do
              if echo "$COMMAND" | grep -qE "\\\$$bvar|\\\$\{$bvar\}|^$bvar=| $bvar="; then
                REASON="Bash command blocked: references blocked env var '$bvar' in '$CURRENT' phase. This variable is restricted to prevent cross-environment access."
                REASON=$(echo "$REASON" | sed 's/"/\\"/g')
                echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$REASON\"}}"
                exit 0
              fi
            done <<< "$BLOCKED_ENVS"
          fi
        fi
      fi
      exit 0  # Allowed — silent pass
    fi

    # Tool denied — use correct hookSpecificOutput format
    REASON="Tool '$TOOL_NAME' is not available in the '$CURRENT' phase. Allowed tools: $(echo $ALLOWED | tr '\n' ', ' | sed 's/,$//').${TRANSITIONS:+ To advance, call statewright_transition with one of: $TRANSITIONS.}"
    REASON=$(echo "$REASON" | sed 's/"/\\"/g')
    echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$REASON\"}}"
    exit 0
    ;;

  post-tool)
    # Detect statewright MCP tool calls and manage local state
    TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
    TOOL_RESULT=$(echo "$HOOK_INPUT" | jq -r '.tool_result // empty' 2>/dev/null || true)

    case "$TOOL_NAME" in
      statewright_start|mcp__statewright__statewright_start)
        # Activate enforcement
        mkdir -p "$STATEWRIGHT_DIR"
        echo "{\"activated\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$ACTIVE_FILE"
        # Fetch and cache initial state
        STATE_JSON=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}')
        if [ -n "$STATE_JSON" ]; then
          echo "$STATE_JSON" > "$CACHE_FILE"
        fi
        ;;
      statewright_stop|mcp__statewright__statewright_stop)
        # Deactivate enforcement
        rm -f "$ACTIVE_FILE" "$CACHE_FILE" "$STATEWRIGHT_DIR/.session_hinted" "$STATEWRIGHT_DIR/.session_hinted"
        ;;
      statewright_transition|mcp__statewright__statewright_transition)
        # Read previous state before refreshing
        PREV_STATE=$(cat "$CACHE_FILE" 2>/dev/null | jq -r '.state // empty' 2>/dev/null || true)
        # Refresh cache after transition
        STATE_JSON=$(mcp_call '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state","arguments":{}},"id":1}')
        if [ -n "$STATE_JSON" ]; then
          echo "$STATE_JSON" > "$CACHE_FILE"
          NEW_STATE=$(echo "$STATE_JSON" | jq -r '.state // empty' 2>/dev/null || true)
          IS_FINAL=$(echo "$STATE_JSON" | jq -r '.is_final // false' 2>/dev/null || true)
          if [ "$IS_FINAL" = "true" ]; then
            rm -f "$ACTIVE_FILE" "$CACHE_FILE" "$STATEWRIGHT_DIR/.session_hinted"
            echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] ${PREV_STATE} => ${NEW_STATE} (workflow complete, enforcement deactivated)\"}}"
          elif [ -n "$PREV_STATE" ] && [ -n "$NEW_STATE" ]; then
            echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"[statewright] ${PREV_STATE} => ${NEW_STATE}\"}}"
          fi
        fi
        ;;
    esac
    exit 0
    ;;

  *)
    exit 0
    ;;
esac
