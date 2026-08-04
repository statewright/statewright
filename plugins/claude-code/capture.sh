#!/usr/bin/env bash
# Workflow log capture — uploads tool output to statewright.ai for run history.
# Runs async via PostToolUse hook. Server auto-links logs to the active run.

command -v jq &>/dev/null || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=client-id.sh
source "$SCRIPT_DIR/client-id.sh"

API_KEY="${STATEWRIGHT_API_KEY:-$(cat "$HOME/.statewright/api_key" 2>/dev/null || true)}"
API_KEY="${API_KEY%"${API_KEY##*[![:space:]]}"}"  # trim trailing whitespace/newlines
PB_URL="${STATEWRIGHT_PB_URL:-https://statewright.ai}"

[ -z "$API_KEY" ] && exit 0

HOOK_INPUT=$(cat 2>/dev/null || true)
[ -z "$HOOK_INPUT" ] && exit 0

# Check if capture is enabled for this session (opt-in via workflow meta.capture_output)
HOOK_SESSION=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
CLIENT_ID=$(statewright_client_id "$HOOK_SESSION")
SESSION_KEY="${CLIENT_ID#swc_}"
SESSION_KEY="${SESSION_KEY:0:16}"
[ ! -f "$HOME/.statewright/sessions/$SESSION_KEY/.capture_enabled" ] && exit 0

TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
[ -z "$TOOL_NAME" ] && exit 0

# Skip statewright control tools
case "$TOOL_NAME" in *statewright_*) exit 0 ;; esac

TOOL_INPUT=$(echo "$HOOK_INPUT" | jq -c '.tool_input // {}' 2>/dev/null || echo '{}')
TOOL_OUTPUT=$(echo "$HOOK_INPUT" | jq -r '.tool_result // .tool_response // empty' 2>/dev/null || true)
DURATION=$(echo "$HOOK_INPUT" | jq -r '.duration_ms // 0' 2>/dev/null || echo '0')

# Read current phase from state cache
PHASE=$(cat "$HOME/.statewright/sessions/$SESSION_KEY/.state_cache" 2>/dev/null | jq -r '.state // empty' 2>/dev/null || true)
[ -z "$PHASE" ] && PHASE="unknown"

# Truncate massive output (keep first + last 50KB)
OUTPUT_LEN=${#TOOL_OUTPUT}
if [ "$OUTPUT_LEN" -gt 102400 ]; then
  HEAD=$(echo "$TOOL_OUTPUT" | head -c 51200)
  TAIL=$(echo "$TOOL_OUTPUT" | tail -c 51200)
  TOOL_OUTPUT="${HEAD}
... [truncated ${OUTPUT_LEN} bytes] ...
${TAIL}"
fi

# Read run_id and increment sequence
SESSION_DIR="$HOME/.statewright/sessions/$SESSION_KEY"
RUN_ID=$(cat "$SESSION_DIR/.run_id" 2>/dev/null || true)
SEQ_FILE="$SESSION_DIR/.log_seq"
SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo "0")
SEQ=$((SEQ + 1))
echo "$SEQ" > "$SEQ_FILE" 2>/dev/null

# POST to server
PAYLOAD=$(jq -n \
  --arg phase "$PHASE" \
  --arg tool_name "$TOOL_NAME" \
  --argjson tool_input "$TOOL_INPUT" \
  --arg tool_output "$TOOL_OUTPUT" \
  --argjson duration_ms "${DURATION:-0}" \
  --argjson sequence "$SEQ" \
  --arg run_id "$RUN_ID" \
  --arg thread_id "$CLIENT_ID" \
  --arg run_session_id "$(cat "$SESSION_DIR/.state_cache" 2>/dev/null | jq -r '.run_session_id // empty' 2>/dev/null || true)" \
  --arg workflow "$(cat "$SESSION_DIR/.state_cache" 2>/dev/null | jq -r '.workflow // empty' 2>/dev/null || true)" \
  '{
    phase: $phase,
    tool_name: $tool_name,
    tool_input: $tool_input,
    tool_output: $tool_output,
    sequence: $sequence,
    duration_ms: $duration_ms,
    thread_id: $thread_id,
    run_session_id: $run_session_id,
    workflow: $workflow
  } + (if $run_id != "" then {run_id: $run_id} else {} end)' 2>/dev/null)

[ -z "$PAYLOAD" ] && exit 0

RESP=$(curl -s --max-time 5 -X POST "$PB_URL/api/gateway/logs" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $API_KEY" \
  -d "$PAYLOAD" 2>&1)

# Debug: log to user-owned dir on failure (no key material)
if ! echo "$RESP" | jq -e '.id' >/dev/null 2>&1; then
  mkdir -p "$HOME/.statewright/logs" 2>/dev/null
  echo "$(date): TOOL=$TOOL_NAME PB_URL=$PB_URL RESP=$RESP" >> "$HOME/.statewright/logs/capture_debug.log" 2>/dev/null
fi

exit 0
