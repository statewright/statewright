#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TEST_HOME=$(mktemp -d)
trap 'rm -rf "$TEST_HOME"' EXIT
CLIENT_MATERIAL="hook-goal-lifecycle-fixture"
CLIENT_ID=$(STATEWRIGHT_CLIENT_ID="$CLIENT_MATERIAL" bash -c 'source "$1"; statewright_client_id codex fixture-thread' _ "$ROOT/client-id.sh")
SESSION_KEY=${CLIENT_ID#swc_}
SESSION_KEY=${SESSION_KEY:0:16}
PROJECT_DIR="$TEST_HOME/.statewright/sessions/$SESSION_KEY"
mkdir -p "$PROJECT_DIR"
touch "$PROJECT_DIR/.active"
printf '%s' '{"state":"intake","allowed_tools":["Read","Bash"],"transitions":[]}' > "$PROJECT_DIR/.state_cache"

call_hook() {
  local tool_name="$1"
  printf '{"thread_id":"fixture-thread","tool_name":"%s","tool_input":{}}' "$tool_name" \
    | HOME="$TEST_HOME" STATEWRIGHT_CLIENT_ID="$CLIENT_MATERIAL" "$ROOT/hook.sh" pre-tool
}

for tool_name in create_goal get_goal update_goal; do
  output=$(call_hook "$tool_name")
  if [ -n "$output" ]; then
    echo "expected active-intake admission for $tool_name, got: $output" >&2
    exit 1
  fi
done

output=$(call_hook Write)
if ! printf '%s' "$output" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null; then
  echo "expected unrelated Write to remain denied in intake, got: $output" >&2
  exit 1
fi

echo "hook goal lifecycle tests passed"
