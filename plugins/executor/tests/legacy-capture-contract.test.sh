#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/statewright-legacy-capture.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'for ((i=1; i <= $#; i++)); do if [ "${!i}" = "-d" ]; then j=$((i + 1)); printf "%s" "${!j}" > "$CAPTURE_PAYLOAD"; fi; done' 'for arg in "$@"; do case "$arg" in http*) printf "%s" "$arg" > "$CAPTURE_URL" ;; esac; done' 'printf "{\"id\":\"log-test\"}"' > "$TMP_DIR/bin/curl"
chmod +x "$TMP_DIR/bin/curl"

run_case() {
  local host="$1" hook_input="$2" client_id session_key session_dir payload request_url
  local plugin_dir="$REPO_ROOT/plugins/$host"
  if [ "$host" = "codex" ]; then
    client_id=$(STATEWRIGHT_MCP_SESSION_ID=bridge-test bash -c "source '$plugin_dir/client-id.sh'; statewright_client_id codex capture-thread")
  else
    client_id=$(STATEWRIGHT_MCP_SESSION_ID=bridge-test bash -c "source '$plugin_dir/client-id.sh'; statewright_client_id capture-thread")
  fi
  session_key="${client_id#swc_}"
  session_key="${session_key:0:16}"
  session_dir="$TMP_DIR/$host-home/.statewright/sessions/$session_key"
  mkdir -p "$session_dir"
  touch "$session_dir/.capture_enabled"
  printf '%s\n' 'run-authoritative' > "$session_dir/.run_id"
  printf '%s\n' '{"state":"implement","workflow":"capture-contract","run_session_id":"gateway-session-1"}' > "$session_dir/.state_cache"

  payload="$TMP_DIR/$host-payload.json"
  request_url="$TMP_DIR/$host-url.txt"
  printf '%s' "$hook_input" | env \
    HOME="$TMP_DIR/$host-home" \
    PATH="$TMP_DIR/bin:$PATH" \
    CAPTURE_PAYLOAD="$payload" \
    CAPTURE_URL="$request_url" \
    STATEWRIGHT_MCP_SESSION_ID=bridge-test \
    STATEWRIGHT_API_KEY=test-key \
    STATEWRIGHT_PB_URL=https://telemetry.example \
    bash "$plugin_dir/capture.sh"

  jq -e '.run_id == "run-authoritative" and .run_session_id == "gateway-session-1"' "$payload" >/dev/null
  jq -e '.thread_id | startswith("swc_")' "$payload" >/dev/null
  jq -e '.phase == "implement" and .tool_name == "Read" and .workflow == "capture-contract"' "$payload" >/dev/null
  grep -qx 'https://telemetry.example/api/gateway/logs' "$request_url"
}

run_case codex '{"thread_id":"capture-thread","session_id":"turn-1","tool_name":"Read","tool_input":{"path":"src/lib.rs"},"tool_response":"ok"}'
run_case claude-code '{"session_id":"capture-thread","tool_name":"Read","tool_input":{"file_path":"src/lib.rs"},"tool_response":"ok"}'

echo "legacy capture contract tests: ok"
