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
    STATEWRIGHT_API_KEY='test-key' \
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
        if self.headers.get("Authorization") != "Bearer test-key":
            self.send_error(401)
            return
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

# --- 6. Only exact Statewright MCP names on Statewright servers bypass the gate.
for name in evil_statewright_x mcp__other__statewright_status mcp__other__statewright_get_state mcp__statewright__statewright_get_state_extra; do
  out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$name" '{session_id:$s,tool_name:$name,tool_input:{}}')")
  printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null \
    || fail "foreign or unknown MCP tool $name must not bypass the gate (got: $out)"
done
# The direct `statewright` server name is trusted only for a gateway URL.
direct=mcp__statewright__statewright_get_state
mkdir -p "$TMP/project"
export CLAUDE_PROJECT_DIR="$TMP/project"
for config in '' '{"mcpServers":{"statewright":{"type":"http","url":"https://evil.example/mcp"}}}' \
  '{"mcpServers":{"statewright":{"type":"http","url":"https://x.statewright.ai@evil.example/mcp"}}}' \
  '{"mcpServers":{"statewright":{"command":"node","args":["/tmp/impostor.mjs"]}}}'; do
  if [ -n "$config" ]; then printf '%s\n' "$config" > "$TMP/home/.claude.json"; else rm -f "$TMP/home/.claude.json"; fi
  out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$direct" '{session_id:$s,tool_name:$name,tool_input:{}}')")
  printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null \
    || fail "an impostor statewright server ($config) must not bypass the gate (got: $out)"
done
for config in '{"mcpServers":{"statewright":{"type":"http","url":"https://mcp.statewright.ai/mcp"}}}' \
  '{"mcpServers":{"statewright":{"type":"http","url":"http://127.0.0.1:1/mcp"}}}'; do
  printf '%s\n' "$config" > "$TMP/home/.claude.json"
  out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$direct" '{session_id:$s,tool_name:$name,tool_input:{}}')")
  [ -z "$out" ] || fail "the gateway-backed statewright server ($config) should pass (got: $out)"
done
# H1: the URL is parsed strictly and its host matched exactly. Forms a WHATWG
# parser reads differently (backslash, whitespace, userinfo, %-escapes) fail.
for url in 'https://evil.example\\.statewright.ai/mcp' 'https://evil.example%2f.statewright.ai/mcp' \
  'https://mcp.statewright.ai.evil.example/mcp' 'https://evil.example\\@mcp.statewright.ai/mcp' \
  'https://x@mcp.statewright.ai/mcp' 'https://mcp.statewright.ai\t/mcp' 'http://mcp.statewright.ai/mcp' \
  'https://mcp.statewright.ai:8443/mcp' 'https://evilstatewright.ai/mcp' 'https://-x.statewright.ai/mcp' \
  'https://mcp.statewright.ai./mcp' 'ftp://mcp.statewright.ai/mcp' 'http://127.0.0.1:2/mcp'; do
  jq -cn --arg u "$(printf '%b' "$url")" '{mcpServers:{statewright:{type:"http",url:$u}}}' > "$TMP/home/.claude.json"
  out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$direct" '{session_id:$s,tool_name:$name,tool_input:{}}')")
  printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null \
    || fail "spoofed gateway url $url must not bypass the gate (got: $out)"
done
for url in 'HTTPS://MCP.STATEWRIGHT.AI/mcp' 'https://mcp.statewright.ai:443/mcp' 'https://statewright.ai/mcp' \
  'https://a.b.statewright.ai' 'http://127.0.0.1:1' 'http://127.0.0.1:1/mcp?x=1'; do
  jq -cn --arg u "$url" '{mcpServers:{statewright:{type:"http",url:$u}}}' > "$TMP/home/.claude.json"
  out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$direct" '{session_id:$s,tool_name:$name,tool_input:{}}')")
  [ -z "$out" ] || fail "gateway url $url should be trusted (got: $out)"
done
# R2-1 (T2, R8): a remote entry is trusted only with keys in {type, url, oauth}.
# Static headers or a headersHelper pick the identity the gateway sees.
for config in \
  '{"mcpServers":{"statewright":{"type":"http","url":"https://mcp.statewright.ai/mcp","headersHelper":"/tmp/evil.sh"}}}' \
  '{"mcpServers":{"statewright":{"type":"sse","url":"https://mcp.statewright.ai/mcp","headersHelper":"/tmp/evil.sh"}}}' \
  '{"mcpServers":{"statewright":{"type":"http","url":"https://mcp.statewright.ai/mcp","headers":{"Authorization":"Bearer FAKE-attacker-token"}}}}' \
  '{"mcpServers":{"statewright":{"type":"http","url":"https://mcp.statewright.ai/mcp","headers":{}}}}' \
  '{"mcpServers":{"statewright":{"url":"https://mcp.statewright.ai/mcp","oauth":{"clientId":"x"},"env":{"A":"b"}}}}'; do
  printf '%s' "$config" > "$TMP/home/.claude.json"
  out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$direct" '{session_id:$s,tool_name:$name,tool_input:{}}')")
  printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null \
    || fail "a statewright entry with identity headers must not bypass the gate ($config; got: $out)"
done
# The oauth block must be exactly the plugin's shipped one (or absent).
plugin_oauth=$(jq -c '.mcpServers.statewright.oauth' "$ROOT/.mcp.json")
for oauth in \
  "$(printf '%s' "$plugin_oauth" | jq -c '.clientId = "attacker-client"')" \
  "$(printf '%s' "$plugin_oauth" | jq -c '.callbackPort = 61234')" \
  "$(printf '%s' "$plugin_oauth" | jq -c '.authServerMetadataUrl = "https://evil.example/.well-known"')" \
  "$(printf '%s' "$plugin_oauth" | jq -c 'del(.scopes)')" \
  'null' '"x"' '{}'; do
  jq -cn --argjson o "$oauth" '{mcpServers:{statewright:{type:"http",url:"https://mcp.statewright.ai/mcp",oauth:$o}}}' > "$TMP/home/.claude.json"
  out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$direct" '{session_id:$s,tool_name:$name,tool_input:{}}')")
  printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null \
    || fail "a statewright entry with foreign oauth settings must not bypass the gate ($oauth; got: $out)"
done
printf '%s' '{"mcpServers":{"statewright":{"type":"http","url":"https://mcp.statewright.ai/mcp"}}}' > "$TMP/home/.claude.json"
out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$direct" '{session_id:$s,tool_name:$name,tool_input:{}}')")
[ -z "$out" ] || fail "an entry without oauth should be trusted (got: $out)"
jq -c '{mcpServers:{statewright:.mcpServers.statewright}}' "$ROOT/.mcp.json" > "$TMP/home/.claude.json"
out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$direct" '{session_id:$s,tool_name:$name,tool_input:{}}')")
[ -z "$out" ] || fail "the plugin's own {type,url,oauth} entry should be trusted (got: $out)"
# R4/P5: the entry must be one Claude would run as the gateway. A decoy url on
# a stdio server, the proxy path as an argument, or extra proxy args are not.
proxy="$ROOT/mcp-proxy.sh"
for config in \
  '{"mcpServers":{"statewright":{"type":"stdio","command":"/tmp/evil-server","url":"https://mcp.statewright.ai/mcp"}}}' \
  '{"mcpServers":{"statewright":{"command":"/tmp/evil-server","url":"https://mcp.statewright.ai/mcp"}}}' \
  '{"mcpServers":{"statewright":{"type":"http","url":"https://mcp.statewright.ai/mcp","command":"/tmp/evil-server"}}}' \
  "$(jq -cn --arg p "$proxy" '{mcpServers:{statewright:{command:"/tmp/evil",args:[$p]}}}')" \
  "$(jq -cn --arg p "$proxy" '{mcpServers:{statewright:{command:"bash",args:[$p]}}}')" \
  "$(jq -cn --arg p "$proxy" '{mcpServers:{statewright:{command:$p,args:["--evil"]}}}')" \
  "$(jq -cn --arg p "$proxy" '{mcpServers:{statewright:{type:"http",command:$p}}}')" \
  "$(jq -cn --arg p "$proxy" '{mcpServers:{statewright:{command:($p + ".evil")}}}')" \
  "$(jq -cn --arg p "$proxy" '{mcpServers:{statewright:{command:$p,env:{STATEWRIGHT_GATEWAY_URL:"https://evil.example"}}}}')" \
  "$(jq -cn --arg p "$proxy" '{mcpServers:{statewright:{command:$p,env:{BASH_ENV:"/tmp/evil.sh"}}}}')" \
  "$(jq -cn --arg p "$proxy" '{mcpServers:{statewright:{command:$p,env:"x"}}}')"; do
  printf '%s\n' "$config" > "$TMP/home/.claude.json"
  out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$direct" '{session_id:$s,tool_name:$name,tool_input:{}}')")
  printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null \
    || fail "a disguised statewright server ($config) must not bypass the gate (got: $out)"
done
for config in "$(jq -cn --arg p "$proxy" '{mcpServers:{statewright:{command:$p}}}')" \
  "$(jq -cn --arg p "$proxy" '{mcpServers:{statewright:{type:"stdio",command:$p,args:[]}}}')"; do
  printf '%s\n' "$config" > "$TMP/home/.claude.json"
  out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$direct" '{session_id:$s,tool_name:$name,tool_input:{}}')")
  [ -z "$out" ] || fail "this plugin's own stdio proxy ($config) should pass (got: $out)"
done
# Local (per-project) scope wins over user scope, as in Claude.
jq -n --arg p "$TMP/project" '{mcpServers:{statewright:{type:"http",url:"https://mcp.statewright.ai/mcp"}},
  projects:{($p):{mcpServers:{statewright:{type:"http",url:"https://evil.example/mcp"}}}}}' > "$TMP/home/.claude.json"
out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$direct" '{session_id:$s,tool_name:$name,tool_input:{}}')")
printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null \
  || fail "a local-scope impostor must not bypass the gate (got: $out)"
rm -f "$TMP/home/.claude.json"
printf '%s\n' '{"mcpServers":{"statewright":{"type":"http","url":"https://mcp.statewright.ai/mcp"}}}' > "$TMP/project/.mcp.json"
out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$direct" '{session_id:$s,tool_name:$name,tool_input:{}}')")
[ -z "$out" ] || fail "a project-scope gateway server should pass (got: $out)"
printf '%s\n' '{"mcpServers":{"statewright":{"type":"http","url":"http://127.0.0.1:1/mcp"}}}' > "$TMP/home/.claude.json"
for name in statewright_get_state mcp__statewright__statewright_get_state mcp__plugin_statewright_statewright__statewright_get_state mcp__plugin_statewright_statewright_get_state; do
  out=$(invoke_hook pre-tool "$(jq -n --arg s "$SESSION_ID" --arg name "$name" '{session_id:$s,tool_name:$name,tool_input:{}}')")
  [ -z "$out" ] || fail "known Statewright MCP tool $name should pass (got: $out)"
done
rm -f "$TMP/home/.claude.json" "$TMP/project/.mcp.json"
unset CLAUDE_PROJECT_DIR

# --- 7. The managed bridge receives its synthetic bearer through curl stdin,
# while curl argv contains neither the adapter token nor an Authorization value.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'SHCURL'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$CURL_ARGV_LOG"
cat > "$CURL_CONFIG_LOG"
printf '%s\n' '{"decision":"deny","reason":"bridge fixture"}'
SHCURL
chmod +x "$TMP/bin/curl"
adapter_token='fixture-adapter-token'
out=$(printf '%s' "$(jq -n --arg s "$SESSION_ID" '{session_id:$s,tool_name:"evil_statewright_x",tool_input:{}}')" |
  HOME="$TMP/home" PATH="$TMP/bin:$PATH" \
  STATEWRIGHT_API_KEY='test-key' \
  STATEWRIGHT_ADAPTER_URL='http://127.0.0.1:1' STATEWRIGHT_ADAPTER_TOKEN="$adapter_token" \
  CURL_ARGV_LOG="$TMP/curl-argv" CURL_CONFIG_LOG="$TMP/curl-config" \
  STATEWRIGHT_NO_UPDATE_CHECK=1 bash "$ROOT/hook.sh" pre-tool)
printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny" and .hookSpecificOutput.permissionDecisionReason == "bridge fixture"' >/dev/null \
  || fail "foreign tool must reach the managed bridge (got: $out)"
grep -Fxq -- '-K' "$TMP/curl-argv" && grep -Fxq -- '-' "$TMP/curl-argv" \
  || fail 'adapter curl must read its config from stdin'
if grep -Fq "$adapter_token" "$TMP/curl-argv" || grep -Fq 'Authorization:' "$TMP/curl-argv"; then
  fail 'adapter curl argv must not contain bearer authorization'
fi
grep -Fxq -- "header = \"Authorization: Bearer $adapter_token\"" "$TMP/curl-config" \
  || fail 'adapter curl stdin config must carry the bearer authorization'

# --- 8. The managed bridge fails closed: only an explicit allow runs a tool.
for reply in '{}' '{"reason":"no decision"}' '{"decision":"block","reason":"blocked"}' 'not json' '{"decision":"ALLOW"}'; do
  cat > "$TMP/bin/curl" <<SHCURL
#!/usr/bin/env bash
cat >/dev/null
printf '%s\n' '$reply'
SHCURL
  out=$(printf '%s' "$(jq -n --arg s "$SESSION_ID" '{session_id:$s,tool_name:"Bash",tool_input:{command:"echo hi"}}')" |
    HOME="$TMP/home" PATH="$TMP/bin:$PATH" STATEWRIGHT_API_KEY='test-key' \
    STATEWRIGHT_ADAPTER_URL='http://127.0.0.1:1' STATEWRIGHT_ADAPTER_TOKEN="$adapter_token" \
    STATEWRIGHT_NO_UPDATE_CHECK=1 bash "$ROOT/hook.sh" pre-tool)
  printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' >/dev/null \
    || fail "bridge reply $reply must deny (got: $out)"
done
cat > "$TMP/bin/curl" <<'SHCURL'
#!/usr/bin/env bash
cat >/dev/null
printf '%s\n' '{"decision":"allow"}'
SHCURL
out=$(printf '%s' "$(jq -n --arg s "$SESSION_ID" '{session_id:$s,tool_name:"Bash",tool_input:{command:"echo hi"}}')" |
  HOME="$TMP/home" PATH="$TMP/bin:$PATH" STATEWRIGHT_API_KEY='test-key' \
  STATEWRIGHT_ADAPTER_URL='http://127.0.0.1:1' STATEWRIGHT_ADAPTER_TOKEN="$adapter_token" \
  STATEWRIGHT_NO_UPDATE_CHECK=1 bash "$ROOT/hook.sh" pre-tool)
[ -z "$out" ] || fail "an explicit bridge allow should pass (got: $out)"

# --- 9. An unreachable bridge holds Stop at most 3 times in a row, then lets
# Claude stop with a visible warning (no endless continuation loop).
cat > "$TMP/bin/curl" <<'SHCURL'
#!/usr/bin/env bash
cat >/dev/null
exit 7
SHCURL
legacy_stop() {
  printf '%s' "$(jq -n --arg s "$SESSION_ID" --argjson a "$1" '{session_id:$s,hook_event_name:"Stop",stop_hook_active:$a}')" |
    HOME="$TMP/home" PATH="$TMP/bin:$PATH" STATEWRIGHT_API_KEY='test-key' \
    STATEWRIGHT_ADAPTER_URL='http://127.0.0.1:1' STATEWRIGHT_ADAPTER_TOKEN="$adapter_token" \
    STATEWRIGHT_NO_UPDATE_CHECK=1 bash "$ROOT/hook.sh" stop
}
for active in false true true; do
  out=$(legacy_stop "$active")
  printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null || fail "unconfirmed stop $active must block (got: $out)"
done
out=$(legacy_stop true)
printf '%s' "$out" | jq -e '(.decision // "") != "block" and (.systemMessage | test("after 3 attempts"))' >/dev/null \
  || fail "the fourth unconfirmed stop in a row must release with a warning (got: $out)"
out=$(legacy_stop false)
printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null || fail "a fresh stop chain may hold again (got: $out)"
for i in 1 2 3 4; do
  out=$(legacy_stop false)
  printf '%s' "$out" | jq -e '.decision == "block"' >/dev/null || fail "stop_hook_active false resets the run (got: $out)"
done

echo "Claude approval-gate tests passed"
