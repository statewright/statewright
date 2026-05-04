#!/usr/bin/env bash
# Statewright hook handler for Claude Code
# Uses system-reminder pattern for reliable instruction injection
set -o pipefail

ENDPOINT="${1:-pre-tool}"
PORT=$(cat /tmp/statewright-hook-port 2>/dev/null)
HOOK_INPUT=$(cat 2>/dev/null || true)

[ -z "$PORT" ] && exit 0

get_state() {
  curl -sf --max-time 1 "http://localhost:$PORT/hooks/state" 2>/dev/null || true
}

case "$ENDPOINT" in
  user-prompt)
    # UserPromptSubmit: inject via user message channel (highest trust)
    # stdout text becomes a system-reminder that Claude follows
    STATE_INFO=$(get_state)
    CURRENT=$(echo "$STATE_INFO" | jq -r '.state // empty' 2>/dev/null || true)
    [ -z "$CURRENT" ] && exit 0

    ITER=$(echo "$STATE_INFO" | jq -r '.iteration // 0' 2>/dev/null || true)
    MAX=$(echo "$STATE_INFO" | jq -r '.maxIterations // "none"' 2>/dev/null || true)
    TOOLS=$(echo "$STATE_INFO" | jq -r '.allowedTools | join(", ")' 2>/dev/null || true)
    INSTRUCTIONS=$(echo "$STATE_INFO" | jq -r '.instructions // empty' 2>/dev/null || true)

    # Output as plain text — becomes user-channel context
    cat << STATEWRIGHT
Statewright state machine is active. Current phase: $CURRENT (iteration $ITER/$MAX).
Tools available in this phase: $TOOLS.
${INSTRUCTIONS:+Phase instructions: $INSTRUCTIONS}

State transition reporting convention for this project:
- Before each call to statewright_transition, output a line: **[statewright]** CURRENT_STATE => TARGET_STATE
- When the workflow reaches a final state, output: **[statewright]** Workflow complete.
- Call statewright_get_state at the start to confirm the current phase.
STATEWRIGHT
    exit 0
    ;;

  pre-tool)
    TOOL=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
    [ -z "$TOOL" ] && exit 0

    RESPONSE=$(curl -sf --max-time 3 -X POST "http://localhost:$PORT/hooks/pre-tool" \
      -H 'Content-Type: application/json' \
      -d "{\"tool_name\":\"$TOOL\"}" 2>/dev/null || true)
    [ -z "$RESPONSE" ] && exit 0

    DECISION=$(echo "$RESPONSE" | jq -r '.decision // "allow"' 2>/dev/null || echo "allow")
    CONTEXT=$(echo "$RESPONSE" | jq -r '.additionalContext // empty' 2>/dev/null || true)

    if [ "$DECISION" = "deny" ]; then
      jq -n --arg reason "$CONTEXT" \
        '{hookEventName:"PreToolUse", permissionDecision:"deny", permissionDecisionReason:$reason}'
      exit 0
    fi

    # Allow — inject transition context if present
    if [ -n "$CONTEXT" ]; then
      jq -n --arg ctx "$CONTEXT" \
        '{hookEventName:"PreToolUse", permissionDecision:"allow", additionalContext:$ctx}'
    fi
    exit 0
    ;;

  post-tool)
    TOOL=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
    [ -z "$TOOL" ] && exit 0

    RESPONSE=$(curl -sf --max-time 2 -X POST "http://localhost:$PORT/hooks/post-tool" \
      -H 'Content-Type: application/json' \
      -d "{\"tool_name\":\"$TOOL\"}" 2>/dev/null || true)
    [ -z "$RESPONSE" ] && exit 0

    TRANSITION=$(echo "$RESPONSE" | jq -r '.transition // empty' 2>/dev/null || true)
    COMPLETED=$(echo "$RESPONSE" | jq -r '.completed // empty' 2>/dev/null || true)

    if [ "$COMPLETED" = "true" ]; then
      jq -n --arg t "${TRANSITION:-completed}" \
        '{additionalContext: ("**[statewright]** " + $t + " — workflow complete.")}'
      exit 0
    fi

    if [ -n "$TRANSITION" ]; then
      jq -n --arg t "$TRANSITION" \
        '{additionalContext: ("**[statewright]** " + $t)}'
      exit 0
    fi
    exit 0
    ;;

  stop)
    RESPONSE=$(curl -sf --max-time 3 -X POST "http://localhost:$PORT/hooks/stop" 2>/dev/null || true)
    [ -z "$RESPONSE" ] && exit 0

    DECISION=$(echo "$RESPONSE" | jq -r '.decision // "allow"' 2>/dev/null || echo "allow")
    CONTEXT=$(echo "$RESPONSE" | jq -r '.additionalContext // empty' 2>/dev/null || true)

    if [ "$DECISION" = "block" ]; then
      jq -n --arg reason "$CONTEXT" \
        '{decision:"block", reason:$reason}'
      exit 0
    fi

    # Final state — allow with completion note
    STATE_INFO=$(get_state)
    CURRENT=$(echo "$STATE_INFO" | jq -r '.state // "completed"' 2>/dev/null || true)
    echo "**[statewright]** Workflow reached final state: $CURRENT"
    exit 0
    ;;

  *)
    exit 0
    ;;
esac
