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

# Powerline glyphs — set STATEWRIGHT_POWERLINE=0 to force ASCII
if [[ "${STATEWRIGHT_POWERLINE:-1}" != "0" ]]; then
    SEP=""
else
    SEP=">"
fi

# --- Statewright segment (left-aligned, fits inline with existing powerline) ---
SW_SEGMENT=""

if [[ -n "$STATEWRIGHT_API_KEY" ]] || [[ -f "$HOME/.statewright/api_key" ]]; then
    SW_KEY="${STATEWRIGHT_API_KEY:-$(cat "$HOME/.statewright/api_key" 2>/dev/null)}"
    SW_URL="${STATEWRIGHT_GATEWAY_URL:-https://mcp.statewright.ai}"

    SW_STATE=$(timeout 1 curl -s -X POST "${SW_URL}/" \
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
                SW_BG="${BG_PURPLE}"; SW_FG="${FG_BLACK}"
            elif echo "$SW_NAME" | grep -qi "test\|verif"; then
                SW_BG="${BG_ORANGE}"; SW_FG="${FG_BLACK}"
            elif echo "$SW_NAME" | grep -qi "plan"; then
                SW_BG="${BG_CYAN}"; SW_FG="${FG_BLACK}"
            elif echo "$SW_NAME" | grep -qi "completed"; then
                SW_BG="${BG_GREEN}"; SW_FG="${FG_BLACK}"
            elif echo "$SW_NAME" | grep -qi "fail"; then
                SW_BG="${BG_RED}"; SW_FG="${FG_BLACK}"
            else
                SW_BG="${BG_BLUE}"; SW_FG="${FG_BLACK}"
            fi

            # Left-aligned: [state iter/max] > [⚙ statewright] >
            SW_SEGMENT="${SW_BG}${SW_FG} ${SW_NAME} ${SW_ITER}/${SW_MAX} ${RESET}${FG_SW}${BG_SW}${SEP}${RESET}${BG_SW}${FG_WHITE} ⚙ statewright ${RESET}${FG_SW}${SEP}${RESET}"
        else
            # No active workflow — brand pill only
            SW_SEGMENT="${BG_SW}${FG_WHITE} ⚙ statewright ${RESET}${FG_SW}${SEP}${RESET}"
        fi
    else
        # Gateway reachable, no state
        SW_SEGMENT="${BG_SW}${FG_WHITE} ⚙ statewright ${RESET}${FG_SW}${SEP}${RESET}"
    fi
fi

# --- Output ---
# Standalone mode — just print the statewright segment.
# To integrate with an existing powerline, append this segment at the end.
if [[ -n "$SW_SEGMENT" ]]; then
    printf "${SW_SEGMENT}\n"
fi

# --- Example: minimal full powerline with statewright appended ---
# Uncomment below for a complete left-aligned statusline.
# Integrates directory, git branch, and statewright into one powerline.
#
# BG_DIR='\033[48;5;75m'
# FG_DIR='\033[38;5;75m'
# BG_GIT='\033[48;5;82m'
# FG_GIT='\033[38;5;82m'
#
# DIR=$(pwd | sed "s|^$HOME|~|" | rev | cut -d/ -f1-2 | rev)
# BRANCH=$(git branch --show-current 2>/dev/null)
#
# LEFT="${BG_DIR}${FG_BLACK} ${DIR} ${RESET}${FG_DIR}"
# if [[ -n "$BRANCH" ]]; then
#     LEFT="${LEFT}${BG_GIT}${SEP}${FG_BLACK} ${BRANCH} ${RESET}${FG_GIT}"
# fi
# if [[ -n "$SW_SEGMENT" ]]; then
#     # Statewright as the last segment — flows naturally after git
#     FG_PREV="${FG_GIT:-$FG_DIR}"
#     LEFT="${LEFT}${SW_BG:-$BG_SW}${SEP}${SW_SEGMENT}"
# else
#     LEFT="${LEFT}${SEP}${RESET}"
# fi
#
# printf "${LEFT}\n"
