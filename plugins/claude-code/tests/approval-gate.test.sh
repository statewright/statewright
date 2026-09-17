#!/usr/bin/env bash
# Regression: pending approvals must park the Claude Code hook path.
# Pre-tool and permission-request never run tool work while an approval is
# pending; user-prompt tells Claude to stop; and a gateway-side human
# decision resumes enforcement with the fresh workflow state.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/statewright-claude-approval.XXXXXX")

cleanup() {
  [ -n "${GW_PID:-}" ] && kill "$GW_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

SESSION_ID="claude-gate"
SESSION_DIR="$TMP/home/.statewright/sessions/${SESSION_ID:0:12}"
mkdir -p "$SESSION_DIR" "$TMP/home/.claude"
printf '%s\n' active > "$SESSION_DIR/.active"
printf 'test-key\n' > "$TMP/home/.statewright/api_key"
printf '%s\n' '{"permissions":{}}' > "$TMP/home/.claude/settings.json"

write_pending_cache() {
  printf '%s\n' '{"state":"review","is_final":false,"allowed_tools":["Read","Bash"],"pending_approval":{"approval_id":"appr-1"},"transitions":[]}' > "$SESSION_DIR/.state_cache"
}
write_plain_cache() {
  printf '%s\n' '{"state":"implement","is_final":false,"allowed_tools":["Read","Bash"],"transitions":[]}' > "$SESSION_DIR/.state_cache"
}

invoke_hook() {
  local event="$1" payload="$2" gw_url="${3:-http://127.0.0.1:1}" poll_timeout="${4:-0}"
  printf '%s' "$payload" |
    HOME="$TMP/home" \
    STATEWRIGHT_GATEWAY_URL="$gw_url" \
    STATEWRIGHT_APPROVAL_POLL_TIMEOUT="$poll_timeout" \
    STATEWRIGHT_NO_UPDATE_CHECK=1 \
    bash "$ROOT/hook.sh" "$event"
}

fail() { echo "FAIL: $*" >&2; exit 1; }

# --- 1. pre-tool while pending and the gateway is unreachable: deny, parked.
write_pending_cache
out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" '{session_id:$s,tool_name:"Bash",tool_input:{command:"echo ok"}}')")
printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null \
  || fail "pre-tool should deny while approval is pending (got: $out)"
printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason' | grep -q "APPROVAL PENDING (id: appr-1)" \
  || fail "pre-tool denial should name the pending approval (got: $out)"

# --- 2. user-prompt while pending: Claude is told to stop and point the human at the review surface.
out=$(invoke_hook user-prompt "$(jq -n --arg s "$SESSION_ID" '{session_id:$s,prompt:"continue"}')")
printf '%s' "$out" | jq -e '.hookSpecificOutput.additionalContext | contains("APPROVAL GATE")' >/dev/null \
  || fail "user-prompt should surface the approval gate (got: $out)"

# --- 3/4 shared fake gateway: first response pending+autonomous, second
# pending, third approved. permission-request must pass through while parked;
# pre-tool with a poll timeout must resume once the gateway reports approval.
GW_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
GW_URL="http://127.0.0.1:$GW_PORT"
python3 - "$TMP" "$GW_PORT" <<'PYGW' &
import http.server, json, os, sys
state_dir, port = sys.argv[1], int(sys.argv[2])
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        self.rfile.read(length)
        n = H.calls
        H.calls += 1
        path = os.path.join(state_dir, f"resp_{n}.json")
        if os.path.exists(path):
            payload = open(path).read()
        else:
            payload = open(os.path.join(state_dir, "resp_default.json")).read()
        data = payload.encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass
H.calls = 0
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
PYGW
GW_PID=$!
cleanup() {
  [ -n "${GW_PID:-}" ] && kill "$GW_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
for _ in $(seq 1 40); do
  (exec 3<>"/dev/tcp/127.0.0.1/$GW_PORT") 2>/dev/null && { exec 3>&- 3<&-; break; }
  sleep 0.1
done
pending_autonomous='{"state":"review","is_final":false,"allowed_tools":["Read","Bash"],"meta":{"autonomous":true},"pending_approval":{"approval_id":"appr-1"},"transitions":[]}'
pending_plain='{"state":"review","is_final":false,"allowed_tools":["Read"],"pending_approval":{"approval_id":"appr-1"},"transitions":[]}'
approved_state='{"state":"implement","is_final":false,"allowed_tools":["Read","Bash"],"transitions":[]}'
for spec in "resp_0:$pending_autonomous" "resp_1:$pending_plain" "resp_2:$approved_state"; do
  name="${spec%%:*}"; state="${spec#*:}"
  printf '%s' "$state" | python3 -c 'import json,sys;print(json.dumps({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":json.dumps(json.loads(sys.stdin.read()),separators=(",",":"))}]}}))' > "$TMP/$name.json"
done

cp "$TMP/resp_0.json" "$TMP/resp_default.json"
# --- 3. permission-request while pending: never auto-allow or auto-deny; pass through with approval context.
out=$(invoke_hook permission-request "$(jq -n --arg s "$SESSION_ID" '{session_id:$s,tool_name:"Bash",tool_input:{command:"echo ok"}}')" "$GW_URL")
printf '%s' "$out" | jq -e '.hookSpecificOutput.additionalContext | contains("APPROVAL PENDING")' >/dev/null \
  || fail "permission-request should pass through while parked (got: $out)"
printf '%s' "$out" | jq -e 'has("decision") | not' >/dev/null \
  || fail "permission-request must not emit allow/deny while an approval is pending (got: $out)"

# --- 4. Pre-tool must poll the gateway and resume enforcement once a human
# approves (first poll pending, second approved; allowed tool passes).
out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" '{session_id:$s,tool_name:"Bash",tool_input:{command:"echo ok"}}')" "$GW_URL" 10)
[ -z "$out" ] || fail "pre-tool should allow after the gateway confirms approval (got: $out)"
# The refreshed cache must now carry the approved state.
grep -q '"state":"implement"' "$SESSION_DIR/.state_cache" \
  || fail "post-approval cache should carry the fresh workflow state"

# --- 5. Control: without a pending approval behavior is unchanged.
write_plain_cache
out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" '{session_id:$s,tool_name:"Bash",tool_input:{command:"echo hi"}}')")
[ -z "$out" ] || fail "pre-tool should be unaffected without a pending approval (got: $out)"
out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" '{session_id:$s,tool_name:"Bash",tool_input:{command:"rm x"}}')")
printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null \
  || fail "destructive denial must still apply without an approval gate (got: $out)"

echo "Claude approval-gate tests passed"
