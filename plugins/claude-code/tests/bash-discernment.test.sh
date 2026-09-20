#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/statewright-claude-bash.XXXXXX")

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

SESSION_ID="claude-policy"
SESSION_DIR="$TMP/home/.statewright/sessions/${SESSION_ID:0:12}"
mkdir -p "$SESSION_DIR" "$TMP/home/.claude"
printf '%s\n' active > "$SESSION_DIR/.active"
printf '%s\n' '{"state":"baseline","allowed_tools":["Read","Bash"],"transitions":[]}' > "$SESSION_DIR/.state_cache"
printf '%s\n' '{"permissions":{"allow":["mcp__plugin_statewright_statewright"]}}' > "$TMP/home/.claude/settings.json"

invoke_hook() {
  local command="$1"
  jq -n --arg session_id "$SESSION_ID" --arg command "$command" \
    '{session_id:$session_id,tool_name:"Bash",tool_input:{command:$command}}' |
    HOME="$TMP/home" STATEWRIGHT_GATEWAY_URL="http://127.0.0.1:1" bash "$ROOT/hook.sh" pre-tool
}

invoke_tool() {
  local tool_name="$1" tool_input="$2"
  jq -n --arg session_id "$SESSION_ID" --arg tool_name "$tool_name" --argjson tool_input "$tool_input" \
    '{session_id:$session_id,tool_name:$tool_name,tool_input:$tool_input}' |
    HOME="$TMP/home" STATEWRIGHT_GATEWAY_URL="http://127.0.0.1:1" bash "$ROOT/hook.sh" pre-tool
}

assert_allowed() {
  local output
  output=$(invoke_hook "$1")
  [ -z "$output" ] || { echo "expected allow for: $1" >&2; exit 1; }
}

assert_denied() {
  local output
  output=$(invoke_hook "$1")
  printf '%s' "$output" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null \
    || { echo "expected denial for: $1" >&2; exit 1; }
}

assert_allowed "rg 'sed -i' src"
assert_allowed "rg '>' src 2>&1"
assert_allowed "find src -name '*.rs'"
assert_denied "sed -i 's/a/b/' file"
for command in 'tee file' 'dd of=file' 'cp from to' 'mv from to' 'ln from to' 'install from to' 'rsync from to' 'mkdir dir' 'touch file' 'chmod 600 file' 'chown user file'; do
  assert_denied "$command"
done

[ -z "$(invoke_tool Grep '{"pattern":"needle","path":"src"}')" ] || { echo "expected Grep to map to Read" >&2; exit 1; }
[ -z "$(invoke_tool Edit '{"file_path":"x","old_string":"a","new_string":"b"}')" ] && { echo "expected Edit to require Write" >&2; exit 1; }
printf '%s' "$(invoke_tool Bash '{}')" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null \
  || { echo "expected missing Bash command denial" >&2; exit 1; }
printf '%s' "$(invoke_tool Zsh '{"command":"rg needle src"}')" | jq -e '.hookSpecificOutput.permissionDecisionReason | contains("Use Bash")' >/dev/null \
  || { echo "expected actionable Zsh denial" >&2; exit 1; }

echo "Claude Bash discernment tests passed"
