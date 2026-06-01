#!/bin/bash
# Statewright status line for Claude Code
#
# Shows the current workflow state in your Claude Code status bar.
# Add to ~/.claude/settings.json:
#
#   "statusLine": {
#     "type": "command",
#     "command": "/path/to/statusline.sh"
#   }
#
# Or append to your existing statusline script.
#
# Requires: curl, jq
# Uses: STATEWRIGHT_API_KEY (env or ~/.statewright/api_key)
#       STATEWRIGHT_GATEWAY_URL (default: https://mcp.statewright.ai)
#       COLUMNS (set by Claude Code for terminal width)

# Read stdin (Claude Code sends context JSON)
INPUT=$(timeout 0.1 cat 2>/dev/null || echo "")

# --- Colors ---
RESET='\033[0m'
BOLD='\033[1m'
FG_BLACK='\033[38;5;0m'
FG_WHITE='\033[38;5;255m'
BG_BLUE='\033[48;5;33m'
BG_CYAN='\033[48;5;51m'
BG_PURPLE='\033[48;5;141m'
BG_ORANGE='\033[48;5;208m'
BG_GREEN='\033[48;5;82m'
BG_RED='\033[48;5;196m'

# Powerline glyphs — fall back to ASCII if font not available
# Set STATEWRIGHT_POWERLINE=0 to force ASCII
if [[ "${STATEWRIGHT_POWERLINE:-1}" != "0" ]]; then
    ARROW_RIGHT=""
    ARROW_LEFT=$(printf '\xee\x82\xb2')
else
    ARROW_RIGHT=">"
    ARROW_LEFT="<"
fi

# --- Statewright segment ---
SW_SEGMENT=""
SW_VISIBLE=""

if [[ -n "$STATEWRIGHT_API_KEY" ]] || [[ -f "$HOME/.statewright/api_key" ]]; then
    SW_KEY="${STATEWRIGHT_API_KEY:-$(cat "$HOME/.statewright/api_key" 2>/dev/null)}"
    SW_URL="${STATEWRIGHT_GATEWAY_URL:-https://mcp.statewright.ai}"

    SW_STATE=$(timeout 1 curl -s -X POST "${SW_URL}/mcp" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${SW_KEY}" \
        -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"statewright_get_state","arguments":{}}}' 2>/dev/null \
        | jq -r '.result.content[0].text' 2>/dev/null)

    # Brand colors
    BG_SW="\033[48;5;33m"
    FG_SW="\033[38;5;33m"

    if [[ -n "$SW_STATE" ]] && [[ "$SW_STATE" != "null" ]]; then
        SW_NAME=$(echo "$SW_STATE" | jq -r '.state // empty' 2>/dev/null)
        SW_ITER=$(echo "$SW_STATE" | jq -r '.iteration // 0' 2>/dev/null)
        SW_MAX=$(echo "$SW_STATE" | jq -r '.max_iterations // "∞"' 2>/dev/null)
        SW_FINAL=$(echo "$SW_STATE" | jq -r '.is_final // false' 2>/dev/null)

        if [[ -n "$SW_NAME" ]] && [[ "$SW_FINAL" != "true" ]]; then
            # Active workflow — color by state type
            if echo "$SW_NAME" | grep -qi "implement\|edit"; then
                SW_BG="${BG_PURPLE}"; SW_FG_ARR="\033[38;5;141m"
            elif echo "$SW_NAME" | grep -qi "test\|verif"; then
                SW_BG="${BG_ORANGE}"; SW_FG_ARR="\033[38;5;208m"
            elif echo "$SW_NAME" | grep -qi "plan"; then
                SW_BG="${BG_CYAN}"; SW_FG_ARR="\033[38;5;51m"
            elif echo "$SW_NAME" | grep -qi "completed"; then
                SW_BG="${BG_GREEN}"; SW_FG_ARR="\033[38;5;82m"
            elif echo "$SW_NAME" | grep -qi "fail"; then
                SW_BG="${BG_RED}"; SW_FG_ARR="\033[38;5;196m"
            else
                SW_BG="${BG_BLUE}"; SW_FG_ARR="\033[38;5;33m"
            fi

            # State pill + brand pill
            SW_SEGMENT="${SW_FG_ARR}${ARROW_LEFT}${SW_BG}${FG_BLACK} ${SW_NAME} ${SW_ITER}/${SW_MAX} ${FG_SW}${ARROW_LEFT}${BG_SW}${FG_WHITE} ⚙ statewright ${RESET}${FG_SW}${ARROW_RIGHT}${RESET}"
            SW_VISIBLE=" ${SW_NAME} ${SW_ITER}/${SW_MAX}  ⚙ statewright "
        else
            # No active workflow — brand pill only
            SW_SEGMENT="${FG_SW}${ARROW_LEFT}${BG_SW}${FG_WHITE} ⚙ statewright ${RESET}${FG_SW}${ARROW_RIGHT}${RESET}"
            SW_VISIBLE=" ⚙ statewright "
        fi
    else
        # Gateway reachable, no state
        SW_SEGMENT="${FG_SW}${ARROW_LEFT}${BG_SW}${FG_WHITE} ⚙ statewright ${RESET}${FG_SW}${ARROW_RIGHT}${RESET}"
        SW_VISIBLE=" ⚙ statewright "
    fi
fi

# --- Output ---
# If you have your own left-side statusline, append SW_SEGMENT with padding:
#
#   LEFT="your existing segments"
#   LEFT_VISIBLE="your segments without ANSI"
#   COLS=${COLUMNS:-120}
#   PAD=$((COLS - ${#LEFT_VISIBLE} - ${#SW_VISIBLE} - 2))
#   [[ "$PAD" -lt 1 ]] && PAD=1
#   printf "${LEFT}$(printf '%*s' "$PAD" '')${SW_SEGMENT}\n"
#
# Standalone mode (just the statewright segment):
if [[ -n "$SW_SEGMENT" ]]; then
    printf "${SW_SEGMENT}\n"
fi
