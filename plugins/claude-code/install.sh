#!/usr/bin/env bash
# Statewright plugin installer for Claude Code
set -e

PLUGIN_DIR="${HOME}/.statewright"
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
STATEWRIGHT_URL="https://statewright.ai"

echo ""
echo "  statewright — state machine guardrails for AI agents"
echo ""

# Create directories
mkdir -p "$PLUGIN_DIR"
mkdir -p "$(dirname "$CLAUDE_SETTINGS")"

# Check if API key already exists
if [ -f "$PLUGIN_DIR/api_key" ]; then
  EXISTING_KEY=$(cat "$PLUGIN_DIR/api_key")
  echo "  Existing API key found: ${EXISTING_KEY:0:12}..."
  echo ""
  read -p "  Use existing key? [Y/n] " USE_EXISTING < /dev/tty
  if [[ "$USE_EXISTING" =~ ^[Nn] ]]; then
    rm "$PLUGIN_DIR/api_key"
  fi
fi

# Get API key if needed
if [ ! -f "$PLUGIN_DIR/api_key" ]; then
  echo "  Opening statewright.ai to generate your API key..."
  echo ""

  if command -v open &> /dev/null; then
    open "${STATEWRIGHT_URL}/signup?redirect=/keys"
  elif command -v xdg-open &> /dev/null; then
    xdg-open "${STATEWRIGHT_URL}/signup?redirect=/keys"
  else
    echo "  Open this URL in your browser:"
    echo "  ${STATEWRIGHT_URL}/signup?redirect=/keys"
  fi

  echo "  1. Sign up or log in"
  echo "  2. Generate an API key"
  echo "  3. Copy the key (starts with sw_live_)"
  echo ""
  read -p "  Paste your API key: " API_KEY < /dev/tty

  if [[ ! "$API_KEY" =~ ^sw_live_ ]]; then
    echo "  Error: API key should start with sw_live_"
    exit 1
  fi

  echo "$API_KEY" > "$PLUGIN_DIR/api_key"
  chmod 600 "$PLUGIN_DIR/api_key"
  echo "  Key saved."
fi

# Download hook script
echo "  Installing hook..."
curl -sf "https://raw.githubusercontent.com/statewright/statewright/main/plugins/claude-code/hook.sh" -o "$PLUGIN_DIR/hook.sh"
chmod +x "$PLUGIN_DIR/hook.sh"

# Add MCP server
echo "  Adding MCP server..."
claude mcp add statewright -s user -- https://github.com/statewright/statewright 2>/dev/null || true

# Merge hooks into ~/.claude/settings.json
echo "  Configuring hooks..."
if [ -f "$CLAUDE_SETTINGS" ]; then
  # Use python to merge hooks into existing settings (jq can't handle this cleanly)
  python3 << PYMERGE
import json, sys

settings_path = "$CLAUDE_SETTINGS"
hook_cmd = "bash $PLUGIN_DIR/hook.sh user-prompt"
allow_tools = [
    "mcp__statewright__statewright_get_state",
    "mcp__statewright__statewright_get_status",
    "mcp__statewright__statewright_list_workflows"
]

with open(settings_path) as f:
    settings = json.load(f)

# Ensure hooks structure exists
settings.setdefault("hooks", {})

# Add UserPromptSubmit hook if not already present
ups = settings["hooks"].setdefault("UserPromptSubmit", [])
has_sw = any("statewright" in str(h) for h in ups)
if not has_sw:
    ups.append({
        "matcher": "*",
        "hooks": [{"type": "command", "command": hook_cmd, "timeout": 5000}]
    })

# Add PreToolUse auto-allow hooks
ptu = settings["hooks"].setdefault("PreToolUse", [])
for tool in allow_tools:
    has_tool = any(tool in str(h) for h in ptu)
    if not has_tool:
        ptu.append({
            "matcher": tool,
            "hooks": [{"type": "command", "command": "echo '{\"decision\":\"allow\"}'", "timeout": 1000}]
        })

# Add allow list
settings.setdefault("allow", [])
for tool in allow_tools:
    if tool not in settings["allow"]:
        settings["allow"].append(tool)

with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)

print("  Hooks merged into " + settings_path)
PYMERGE
else
  # No existing settings — create from scratch
  cat > "$CLAUDE_SETTINGS" << SETTINGS
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash $PLUGIN_DIR/hook.sh user-prompt",
            "timeout": 5000
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "mcp__statewright__statewright_get_state",
        "hooks": [{"type": "command", "command": "echo '{\"decision\":\"allow\"}'", "timeout": 1000}]
      },
      {
        "matcher": "mcp__statewright__statewright_get_status",
        "hooks": [{"type": "command", "command": "echo '{\"decision\":\"allow\"}'", "timeout": 1000}]
      },
      {
        "matcher": "mcp__statewright__statewright_list_workflows",
        "hooks": [{"type": "command", "command": "echo '{\"decision\":\"allow\"}'", "timeout": 1000}]
      }
    ]
  },
  "allow": [
    "mcp__statewright__statewright_get_state",
    "mcp__statewright__statewright_get_status",
    "mcp__statewright__statewright_list_workflows"
  ]
}
SETTINGS
  echo "  Created $CLAUDE_SETTINGS"
fi

# Report install telemetry
API_KEY=$(cat "$PLUGIN_DIR/api_key" 2>/dev/null || true)
PLATFORM="$(uname -s)-$(uname -m)"
curl -sf -X POST "${STATEWRIGHT_URL}/api/telemetry/plugin-event" \
  -H "Content-Type: application/json" \
  -d "{\"plugin\":\"claude-code\",\"event\":\"install\",\"api_key\":\"${API_KEY}\",\"platform\":\"${PLATFORM}\"}" \
  >/dev/null 2>&1 || true

echo ""
echo "  Done. Start a new Claude Code session:"
echo ""
echo "    cd your-project"
echo "    claude"
echo "    > fix the failing tests"
echo ""
echo "  The bugfix workflow activates automatically."
echo "  Create custom workflows at ${STATEWRIGHT_URL}/workflows"
echo ""
