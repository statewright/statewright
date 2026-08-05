#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/statewright-hook-capture.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin"
cat > "$TMP_DIR/capture-stub.sh" <<'EOF'
#!/usr/bin/env bash
cat > "$CAPTURE_MARKER"
EOF
chmod +x "$TMP_DIR/capture-stub.sh"

run_case() {
  local host="$1" session="$2" hook_input="$3"
  local plugin_dir="$REPO_ROOT/plugins/$host"
  local client_id session_key session_dir marker
  if [ "$host" = "codex" ]; then
    client_id=$(STATEWRIGHT_MCP_SESSION_ID="$session" bash -c "source '$plugin_dir/client-id.sh'; statewright_client_id codex '$session'")
  else
    client_id=$(STATEWRIGHT_MCP_SESSION_ID="$session" bash -c "source '$plugin_dir/client-id.sh'; statewright_client_id '$session'")
  fi
  if [ "$host" = "codex" ]; then
    session_key="${client_id#swc_}"
    session_key="${session_key:0:16}"
  else
    session_key="${session:0:12}"
  fi
  session_dir="$TMP_DIR/$host-home/.statewright/sessions/$session_key"
  marker="$TMP_DIR/$host-capture.json"
  mkdir -p "$session_dir"
  touch "$session_dir/.active" "$session_dir/.capture_enabled"
  printf '%s\n' '{"state":"implement","workflow":"hook-capture","run_session_id":"dispatch-session"}' > "$session_dir/.state_cache"

  printf '%s' "$hook_input" | env \
    HOME="$TMP_DIR/$host-home" \
    PATH="$PATH" \
    CAPTURE_MARKER="$marker" \
    STATEWRIGHT_CAPTURE_SCRIPT="$TMP_DIR/capture-stub.sh" \
    STATEWRIGHT_MCP_SESSION_ID="$session" \
    STATEWRIGHT_API_KEY=test-key \
    bash "$plugin_dir/hook.sh" post-tool >/dev/null

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$marker" ] && break
    sleep 0.05
  done
  [ -s "$marker" ] || { echo "$host capture dispatch did not run" >&2; return 1; }
  jq -e '.tool_name == "Read"' "$marker" >/dev/null
}

run_case codex dispatch-codex '{"thread_id":"dispatch-codex","tool_name":"Read","tool_input":{"path":"README.md"},"tool_response":"ok"}'
run_case claude-code dispatch-claude '{"session_id":"dispatch-claude","tool_name":"Read","tool_input":{"file_path":"README.md"},"tool_response":"ok"}'

echo "hook capture dispatch tests: ok"
