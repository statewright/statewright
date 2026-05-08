#!/usr/bin/env bash
# Workflow log capture — uploads full tool output to PB for audit/review
# Runs async (non-blocking) via PostToolUse hook
# Only active when a workflow has meta.capture_output enabled

STATEWRIGHT_DIR="${HOME}/.statewright"
API_KEY="${STATEWRIGHT_API_KEY:-$(cat "$STATEWRIGHT_DIR/api_key" 2>/dev/null || true)}"
PB_URL="${STATEWRIGHT_PB_URL:-https://statewright.ai}"

# Project-scoped state
PROJECT_HASH=$(printf '%s' "$PWD" | shasum -a 256 2>/dev/null | cut -c1-8 || echo "default")
PROJECT_DIR="$STATEWRIGHT_DIR/projects/$PROJECT_HASH"

# Only capture if workflow is active and capture is enabled
[ -f "$PROJECT_DIR/.active" ] || exit 0
[ -f "$PROJECT_DIR/.capture_enabled" ] || exit 0

HOOK_INPUT=$(cat 2>/dev/null || true)
[ -z "$HOOK_INPUT" ] && exit 0

TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
[ -z "$TOOL_NAME" ] && exit 0

# Skip statewright control tools — only capture work tools
case "$TOOL_NAME" in
  *statewright_*) exit 0 ;;
esac

TOOL_INPUT=$(echo "$HOOK_INPUT" | jq -c '.tool_input // {}' 2>/dev/null || true)
TOOL_OUTPUT=$(echo "$HOOK_INPUT" | jq -r '.tool_result // empty' 2>/dev/null || true)
DURATION=$(echo "$HOOK_INPUT" | jq -r '.duration_ms // 0' 2>/dev/null || true)

# Read the current run_id from cache
RUN_ID=$(cat "$PROJECT_DIR/.run_id" 2>/dev/null || true)
[ -z "$RUN_ID" ] && exit 0

# Read current phase
PHASE=$(cat "$PROJECT_DIR/.state_cache" 2>/dev/null | jq -r '.state // empty' 2>/dev/null || true)

# Sequence counter per phase
SEQ_FILE="$PROJECT_DIR/.log_seq"
SEQ=$(cat "$SEQ_FILE" 2>/dev/null || echo "0")
SEQ=$((SEQ + 1))
echo "$SEQ" > "$SEQ_FILE"

# Truncate output if massive (keep first + last 50KB)
OUTPUT_LEN=${#TOOL_OUTPUT}
if [ "$OUTPUT_LEN" -gt 102400 ]; then
  HEAD=$(echo "$TOOL_OUTPUT" | head -c 51200)
  TAIL=$(echo "$TOOL_OUTPUT" | tail -c 51200)
  TOOL_OUTPUT="${HEAD}

... [truncated ${OUTPUT_LEN} bytes] ...

${TAIL}"
fi

# Upload to PB
# Escape for JSON — use jq to safely encode
PAYLOAD=$(jq -n \
  --arg run_id "$RUN_ID" \
  --arg phase "$PHASE" \
  --arg tool_name "$TOOL_NAME" \
  --argjson tool_input "$TOOL_INPUT" \
  --arg tool_output "$TOOL_OUTPUT" \
  --argjson sequence "$SEQ" \
  --argjson duration_ms "$DURATION" \
  '{
    run_id: $run_id,
    phase: $phase,
    tool_name: $tool_name,
    tool_input: $tool_input,
    tool_output: $tool_output,
    sequence: $sequence,
    duration_ms: $duration_ms
  }')

curl -sf --max-time 5 -X POST "$PB_URL/api/collections/workflow_logs/records" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $API_KEY" \
  -d "$PAYLOAD" >/dev/null 2>&1

exit 0
