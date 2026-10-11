#!/usr/bin/env bash
# Statewright plugin setup — installs hooks into ~/.claude/settings.json
# Run once after: /plugin install statewright
#
# This works around a Claude Code bug where plugin hooks execute
# but their stdout isn't injected into agent context.
# https://github.com/anthropics/claude-code/issues/12151
set -e

SETTINGS="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/hook.sh"
STATEWRIGHT_DIR="$HOME/.statewright"
GATEWAY_URL="${STATEWRIGHT_GATEWAY_URL:-}"

# Fall back to finding it
if [ ! -f "$HOOK_SCRIPT" ]; then
  HOOK_SCRIPT=$(find "$HOME/.claude/plugins/cache" -path "*/statewright*/hook.sh" -type f 2>/dev/null | head -1)
fi

if [ ! -f "$HOOK_SCRIPT" ]; then
  echo "Error: Could not find statewright hook.sh. Run /plugin install statewright first."
  exit 1
fi

# A local directory marketplace can outlive its source checkout. Reconcile the
# runtime files before registering this plugin as the active hook owner.
RUNTIME_SYNC="$SCRIPT_DIR/scripts/sync-runtime.mjs"
if [ -f "$RUNTIME_SYNC" ] && command -v node >/dev/null 2>&1; then
  node "$RUNTIME_SYNC" --sync >/dev/null
fi

if [ -z "$GATEWAY_URL" ] && [ -f "$STATEWRIGHT_DIR/gateway_url" ]; then
  GATEWAY_URL=$(cat "$STATEWRIGHT_DIR/gateway_url")
fi
GATEWAY_URL="${GATEWAY_URL:-https://mcp.statewright.ai}"
mkdir -p "$STATEWRIGHT_DIR"
printf '%s\n' "$GATEWAY_URL" > "$STATEWRIGHT_DIR/gateway_url"
chmod 600 "$STATEWRIGHT_DIR/gateway_url"
printf '%s\n' "$HOOK_SCRIPT" > "$STATEWRIGHT_DIR/claude-hook-owner"
chmod 600 "$STATEWRIGHT_DIR/claude-hook-owner"

# Ensure settings.json exists
mkdir -p "$(dirname "$SETTINGS")"
if [ ! -f "$SETTINGS" ]; then
  echo '{}' > "$SETTINGS"
fi

# Inject hooks using python (available on macOS + most Linux)
python3 << PYEOF
import json, os, sys

settings_path = "$SETTINGS"
hook_script = "$HOOK_SCRIPT"

with open(settings_path) as f:
    settings = json.load(f)

hooks = settings.setdefault("hooks", {})

statewright_hooks = {
    "UserPromptSubmit": [{"matcher": "*", "hooks": [{"type": "command", "command": f"bash {hook_script} user-prompt", "timeout": 5000}]}],
    "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": f"bash {hook_script} pre-tool", "timeout": 5000}]}],
    "PostToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": f"bash {hook_script} post-tool", "timeout": 3000}]}],
    "Stop": [{"matcher": "*", "hooks": [{"type": "command", "command": f"bash {hook_script} stop", "timeout": 3000}]}],
}

for event, entries in statewright_hooks.items():
    existing = hooks.get(event, [])
    # Remove old statewright entries
    existing = [e for e in existing if "statewright" not in json.dumps(e).lower() and "hook.sh" not in json.dumps(e)]
    existing.extend(entries)
    hooks[event] = existing

# Auto-approve statewright MCP tools (plugin settings.json can't set permissions)
perms = settings.setdefault("permissions", {})
allow = perms.setdefault("allow", [])
# Plugin MCP servers are namespaced: mcp__plugin_{marketplace}_{plugin}
mcp_rule = "mcp__plugin_statewright_statewright"
if mcp_rule not in allow:
    allow.append(mcp_rule)

with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)

print(f"Statewright hooks + MCP permissions installed in {settings_path}")

# Install agent definitions (fork-branch-worker etc.)
import shutil
agents_dir = os.path.expanduser("~/.claude/agents")
os.makedirs(agents_dir, exist_ok=True)
plugin_cache = os.path.dirname(hook_script)
plugin_agents = os.path.join(plugin_cache, "agents")
if os.path.isdir(plugin_agents):
    for agent_file in os.listdir(plugin_agents):
        if agent_file.endswith(".md"):
            src = os.path.join(plugin_agents, agent_file)
            dst = os.path.join(agents_dir, agent_file)
            shutil.copy2(src, dst)
            print(f"Installed agent: {agent_file}")

# The plugin-provided .mcp.json is the one authoritative Statewright MCP
# transport. Retire the legacy user-level duplicate without touching other
# user-configured servers.
mcp_path = os.path.expanduser("~/.claude/.mcp.json")
if os.path.exists(mcp_path):
    try:
        with open(mcp_path) as mf:
            existing_mcp = json.load(mf)
        servers = existing_mcp.get("mcpServers", {})
        if "statewright" in servers:
            del servers["statewright"]
            existing_mcp["mcpServers"] = servers
            with open(mcp_path, "w") as mf:
                json.dump(existing_mcp, mf, indent=2)
            print(f"Removed legacy Statewright MCP entry from {mcp_path}")
    except Exception:
        pass

print("Run /reload-plugins to activate.")
PYEOF

# The shared executor may be bundled beside the plugin. Bootstrap silently so
# subsequent normal `claude` and `codex` launches inherit managed routing.
MANAGED_CLIENT="${SCRIPT_DIR}/executor/statewright-managed-client.mjs"
if [ -f "$MANAGED_CLIENT" ] && command -v node >/dev/null 2>&1; then
  node "$MANAGED_CLIENT" --bootstrap >/dev/null 2>&1 || true
fi
