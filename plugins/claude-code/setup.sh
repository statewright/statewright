#!/usr/bin/env bash
# Statewright plugin setup — installs hooks into ~/.claude/settings.json
# Run once after: /plugin install statewright
#
# This works around a Claude Code bug where plugin hooks execute
# but their stdout isn't injected into agent context.
# https://github.com/anthropics/claude-code/issues/12151
set -e

SETTINGS="$HOME/.claude/settings.json"
HOOK_SCRIPT="$HOME/.claude/plugins/cache/statewright/statewright/0.1.0/hook.sh"

# Fall back to finding it
if [ ! -f "$HOOK_SCRIPT" ]; then
  HOOK_SCRIPT=$(find "$HOME/.claude/plugins/cache" -path "*/statewright*/hook.sh" -type f 2>/dev/null | head -1)
fi

if [ ! -f "$HOOK_SCRIPT" ]; then
  echo "Error: Could not find statewright hook.sh. Run /plugin install statewright first."
  exit 1
fi

# Ensure settings.json exists
mkdir -p "$(dirname "$SETTINGS")"
if [ ! -f "$SETTINGS" ]; then
  echo '{}' > "$SETTINGS"
fi

# Inject hooks using python (available on macOS + most Linux)
python3 << PYEOF
import json, sys

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
import os, shutil
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

# Configure the packaged command MCP server. It reads the saved key itself for
# gateway calls, while repository-local tools (including reference search) run
# in the user's checkout rather than on the hosted gateway.
key_path = os.path.expanduser("~/.statewright/api_key")
if os.path.exists(key_path):
    with open(key_path) as kf:
        api_key = kf.read().strip()
    if api_key:
        mcp_path = os.path.expanduser("~/.claude/.mcp.json")
        existing_mcp = {}
        if os.path.exists(mcp_path):
            try:
                with open(mcp_path) as mf:
                    existing_mcp = json.load(mf)
            except: pass
        proxy_script = os.path.join(plugin_cache, "mcp-proxy.sh")
        if not os.path.isfile(proxy_script):
            raise RuntimeError("Could not find the packaged Statewright MCP proxy")
        existing_mcp.setdefault("mcpServers", {})["statewright"] = {
            "command": "bash",
            "args": [proxy_script],
            "env": {"STATEWRIGHT_GATEWAY_URL": "https://mcp.statewright.ai"}
        }
        with open(mcp_path, "w") as mf:
            json.dump(existing_mcp, mf, indent=2)
        print(f"MCP server configured in {mcp_path}")

print("Run /reload-plugins to activate.")
PYEOF
