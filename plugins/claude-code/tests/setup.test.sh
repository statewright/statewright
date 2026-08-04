#!/usr/bin/env bash
set -euo pipefail

TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/statewright-claude-setup.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT

TEST_HOME="$TEST_ROOT/home"
mkdir -p "$TEST_HOME/.claude" "$TEST_HOME/.statewright"
printf '%s\n' 'https://statewright-mcp.casa.enhasa.cloud' > "$TEST_HOME/.statewright/gateway_url"
cat > "$TEST_HOME/.claude/.mcp.json" <<'JSON'
{"mcpServers":{"statewright":{"command":"old"},"other":{"command":"keep"}}}
JSON

HOME="$TEST_HOME" STATEWRIGHT_GATEWAY_URL='' bash plugins/claude-code/setup.sh >/dev/null

test "$(cat "$TEST_HOME/.statewright/gateway_url")" = "https://statewright-mcp.casa.enhasa.cloud"
test -s "$TEST_HOME/.statewright/claude-hook-owner"
python3 - "$TEST_HOME/.claude/.mcp.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as source:
    servers = json.load(source)["mcpServers"]
assert "statewright" not in servers
assert servers["other"]["command"] == "keep"
PY
