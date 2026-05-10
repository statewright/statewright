#!/usr/bin/env bash
# Workflow log capture — uploads full tool output to PB
# Runs async via PostToolUse hook. No local files needed.
# PB hook auto-links to the latest running workflow_run.

API_KEY="${STATEWRIGHT_API_KEY:-$(cat "$HOME/.statewright/api_key" 2>/dev/null || true)}"
PB_URL="${STATEWRIGHT_PB_URL:-https://statewright.ai}"

[ -z "$API_KEY" ] && exit 0

HOOK_INPUT=$(cat 2>/dev/null || true)
[ -z "$HOOK_INPUT" ] && exit 0

TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
[ -z "$TOOL_NAME" ] && exit 0

# Skip statewright control tools
case "$TOOL_NAME" in *statewright_*) exit 0 ;; esac

TOOL_INPUT=$(echo "$HOOK_INPUT" | jq -c '.tool_input // {}' 2>/dev/null || true)
TOOL_OUTPUT=$(echo "$HOOK_INPUT" | jq -r '.tool_result // .tool_response // empty' 2>/dev/null || true)
DURATION=$(echo "$HOOK_INPUT" | jq -r '.duration_ms // 0' 2>/dev/null || true)

# Read current phase from state cache (best effort)
PROJECT_HASH=$(printf '%s' "$PWD" | shasum -a 256 2>/dev/null | cut -c1-8 || echo "default")
PHASE=$(cat "$HOME/.statewright/projects/$PROJECT_HASH/.state_cache" 2>/dev/null | jq -r '.state // "unknown"' 2>/dev/null || echo "unknown")

# Truncate massive output (keep first + last 50KB)
OUTPUT_LEN=${#TOOL_OUTPUT}
if [ "$OUTPUT_LEN" -gt 102400 ]; then
  HEAD=$(echo "$TOOL_OUTPUT" | head -c 51200)
  TAIL=$(echo "$TOOL_OUTPUT" | tail -c 51200)
  TOOL_OUTPUT="${HEAD}
... [truncated ${OUTPUT_LEN} bytes] ...
${TAIL}"
fi

# POST to PB — hook auto-links run_id
PAYLOAD=$(jq -n \
  --arg phase "$PHASE" \
  --arg tool_name "$TOOL_NAME" \
  --argjson tool_input "$TOOL_INPUT" \
  --arg tool_output "$TOOL_OUTPUT" \
  --argjson duration_ms "${DURATION:-0}" \
  '{
    phase: $phase,
    tool_name: $tool_name,
    tool_input: $tool_input,
    tool_output: $tool_output,
    sequence: 0,
    duration_ms: $duration_ms
  }' 2>/dev/null)

[ -z "$PAYLOAD" ] && exit 0

curl -sf --max-time 5 -X POST "$PB_URL/api/collections/workflow_logs/records" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $API_KEY" \
  -d "$PAYLOAD" >/dev/null 2>&1

exit 0
