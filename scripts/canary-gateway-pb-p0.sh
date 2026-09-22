#!/usr/bin/env bash
# P0 E2E canary: gateway<->PB wiring + one real task through the gateway.
#
# Runs a disposable copy of this repository (/tmp/swhome) so workflow side
# effects never touch the checkout. PB is the planboard app when available,
# otherwise the in-repo PocketBase-compatible reference server.
#
# The session task runs the real executor entry point
# (plugins/executor/statewright-exec.mjs) with the local reference gateway
# and the default headless host (claude -p; override with SW_CANARY_HOST).
# The executor authenticates with the canary API key and identifies its
# streamable-MCP transport session as br_exec_<uuid> via the
# Mcp-Session-Id header; the workflow opt-slice-branching-v1 forks branch
# sessions a/b that produce side-effect files before re-joining.
#
# NOTE (host divergence, receipts 013/014): the quoted log assertions below
# were ported from the old host's gateway build. This host's gateway build
# logs a different surface (remote.rs: "Remote MCP transport listening",
# "HTTP session created"), and native usage delivery requires a
# .statewright/delivery.json in the working repo, which this checkout does
# not carry; the usage-sink acceptance is covered by the gateway unit tests
# (remote.rs: native usage owner-key tests, incl. branch-pane acceptance;
# the branch-key runtime-approval fix landed in 4a6ce36) instead. The usage
# assertions below are conditional on delivery being configured.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
SW_REPO=${SW_REPO:-}
SW_PORT=${SW_PORT:-8932}
SW_PB_PORT=${SW_PB_PORT:-8090}
SW_PB_URL=${SW_PB_URL:-http://127.0.0.1:${SW_PB_PORT}}
SW_WORKFLOW=${SW_WORKFLOW:-opt-slice-branching-v1}
SW_CANARY_HOST=${SW_CANARY_HOST:-claude}
SW_API_KEY=${SW_API_KEY:-sw-canary-key}
SW_TIMEOUT=${SW_TIMEOUT:-300}

if [ -z "$SW_REPO" ]; then
  SW_REPO=$(mktemp -d /tmp/swhome.XXXXXX)
  trap 'rm -rf "$SW_REPO"' EXIT
  git clone --quiet "$REPO_ROOT" "$SW_REPO"
fi

SW_PB_LOG=/tmp/sw-canary-pb.log
SW_PB_PID=""
rm -f "$SW_PB_LOG" /tmp/sw-canary-pb.sqlite

# Portable timeout: prefer GNU timeout/gtimeout; otherwise a node wrapper
# that keeps the contract the canary relies on (124 on timeout, group kill).
run_with_timeout() {
  local seconds="$1"; shift
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
  elif command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    SW_TIMEOUT_SECONDS="$seconds" node -e '
      const { spawn } = require("node:child_process");
      const [, ...cmd] = process.argv;
      const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", detached: true });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { try { child.kill("SIGKILL"); } catch {} }
        process.exit(124);
      }, Number(process.env.SW_TIMEOUT_SECONDS) * 1000);
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.exit(code === null ? (signal ? 128 : 1) : code);
      });
      child.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.exit(127);
      });
    ' "$@"
  fi
}

stop_reference_pb() {
  if [ -n "$SW_PB_PID" ]; then
    kill "$SW_PB_PID" 2>/dev/null || true
    wait "$SW_PB_PID" 2>/dev/null || true
    SW_PB_PID=""
  fi
}

start_reference_pb() {
  PB_PORT="$SW_PB_PORT" \
  PB_DATA=/tmp/sw-canary-pb.sqlite \
  PB_KEY="$SW_API_KEY" \
  PB_APPROVAL_SECRET="${SW_PB_APPROVAL_SECRET:-sw-canary-approval}" \
  PB_WORKFLOW_FILE="$REPO_ROOT/scripts/canary/${SW_WORKFLOW}.json" \
  node "$REPO_ROOT/scripts/canary/pb-reference-server.mjs" \
    >"$SW_PB_LOG" 2>&1 &
  SW_PB_PID=$!
  PB_IS_REFERENCE=1
  for _ in $(seq 1 30); do
    if curl -sf "${SW_PB_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  echo "canary: reference PB server did not become healthy on ${SW_PB_URL}" >&2
  return 1
}

if curl -sf "${SW_PB_URL}/api/health" >/dev/null 2>&1; then
  echo "canary: using existing PB at ${SW_PB_URL}"
else
  echo "canary: PB not reachable at ${SW_PB_URL}; starting reference server"
  start_reference_pb
fi

cleanup() {
  stop_reference_pb
}
trap cleanup EXIT

# Host-specific launch args: claude needs headless print mode in a non-TTY
# canary shell. Do not forward -p to other hosts: opencode interprets it as
# its server password and would consume the prompt as that value.
host_args() {
  case "$SW_CANARY_HOST" in
    claude) printf '%s\n' --host-arg -p ;;
    *) : ;;
  esac
}

session_task() {
  local extra_args=()
  while IFS= read -r line; do extra_args+=("$line"); done < <(host_args)
  (
    cd "$SW_REPO"
    STATEWRIGHT_GATEWAY_URL="http://127.0.0.1:${SW_PORT}" \
    STATEWRIGHT_API_KEY="$SW_API_KEY" \
    STATEWRIGHT_TELEMETRY_PATH="$SW_SESSION_LOG" \
    node plugins/executor/statewright-exec.mjs \
      --host "$SW_CANARY_HOST" \
      ${extra_args[@]+"${extra_args[@]}"} \
      --workflow "$SW_WORKFLOW" \
      --cwd "$SW_REPO" \
      -- \
      "Follow the current state's instructions exactly. Do not ask questions; when a state gives explicit instructions, act on them, then use the statewright state-transition tool to move to the next state." \
      >"$SW_SESSION_OUT" 2>&1
  )
}

SW_SESSION_LOG=/tmp/sw-canary-session.log
SW_SESSION_OUT=/tmp/sw-canary-session-out.log
SW_GATEWAY_LOG=/tmp/sw-canary-gateway.log
rm -f "$SW_SESSION_LOG" "$SW_SESSION_OUT" "$SW_GATEWAY_LOG"

# Register the canary API key with PB through the gateway's PB integration.
echo "canary: registering API key with PB"
SW_PB_URL="$SW_PB_URL" node - "$SW_API_KEY" <<'NODE'
const [key] = process.argv.slice(1);
const url = `${process.env.SW_PB_URL}/api/key`;
const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key, name: "canary-p0" }),
});
const body = await response.json();
if (!response.ok || !(body.ok ?? body.status)) {
  console.error(`canary: PB key registration failed (${response.status}): ${JSON.stringify(body)}`);
  process.exit(1);
}
console.log("canary: PB API key active");
NODE

# The workflow must be fetchable from PB; this proves the gateway<->PB workflow path.
echo "canary: checking workflow fetch from PB"
SW_PB_URL="$SW_PB_URL" SW_CHECK_KEY="$SW_API_KEY" SW_CHECK_WORKFLOW="$SW_WORKFLOW" \
  SW_PB_PID="$SW_PB_PID" SW_PB_LOG="$SW_PB_LOG" node - <<'NODE'
const key = process.env.SW_CHECK_KEY;
const workflow = process.env.SW_CHECK_WORKFLOW;
const url = `${process.env.SW_PB_URL}/api/gateway/workflows`;
const response = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
const body = await response.json();
const names = Object.keys(body?.workflows ?? {});
if (!response.ok || !names.includes(workflow)) {
  const fs = await import("node:fs");
  let envInfo = "";
  try { envInfo = fs.readFileSync(`/proc/self/environ`, "utf8"); } catch {}
  const { execSync } = await import("node:child_process");
  const pbPid = process.env.SW_PB_PID || "";
  const pbEnv = pbPid ? execSync(`ps -o command= -p ${pbPid}`).toString().slice(0, 200) : "";
  console.error(`canary: PB workflow fetch failed (${response.status}): ${JSON.stringify(body)}`);
  console.error(`canary: diag checkKeyLen=${key.length} pbUrl=${process.env.SW_PB_URL}`);
  console.error(`canary: diag pbProc: ${pbEnv}`);
  console.error(`canary: diag pbLog: ${fs.readFileSync(process.env.SW_PB_LOG, "utf8").slice(-300)}`);
  process.exit(1);
}
console.log("canary: PB workflow list includes " + workflow);
NODE
if [ "$?" -ne 0 ]; then
  echo "canary: diagnostics" >&2
  ps -o pid=,command= -p "$SW_PB_PID" 2>/dev/null | head -2 || true
  tail -5 "$SW_PB_LOG" 2>/dev/null || true
  exit 1
fi

# Start the reference gateway with PB integration enabled.
echo "canary: starting reference gateway on 127.0.0.1:${SW_PORT}"
SW_RUST_LOG="${SW_RUST_LOG:-info}"
ps -o pid=,command= -p "$SW_PB_PID" 2>/dev/null | head -2 || true
echo "canary: PB key in use: ${SW_API_KEY:0:4}... (len ${#SW_API_KEY})"
(
  cd "$REPO_ROOT"
  RUST_LOG="$SW_RUST_LOG" ./target/release/statewright-gateway \
    --remote \
    --remote-addr "127.0.0.1:${SW_PORT}" \
    --pb-url "$SW_PB_URL" \
    >"$SW_GATEWAY_LOG" 2>&1
) &
SW_GATEWAY_PID=$!
cleanup() {
  if [ -n "${SW_GATEWAY_PID:-}" ]; then
    kill "$SW_GATEWAY_PID" 2>/dev/null || true
    wait "$SW_GATEWAY_PID" 2>/dev/null || true
    SW_GATEWAY_PID=""
  fi
  stop_reference_pb
}
trap cleanup EXIT

SW_READY=0
for _ in $(seq 1 100); do
  if grep -q "Remote MCP transport" "$SW_GATEWAY_LOG" 2>/dev/null; then
    SW_READY=1
    break
  fi
  if ! kill -0 "$SW_GATEWAY_PID" 2>/dev/null; then
    break
  fi
  sleep 0.2
done
if [ "$SW_READY" -ne 1 ]; then
  echo "canary: gateway did not become ready" >&2
  cat "$SW_GATEWAY_LOG" >&2 || true
  exit 1
fi
echo "canary: gateway ready"

# Run one real Statewright task through the gateway (disposable repo copy).
echo "canary: running statewright executor session (host=${SW_CANARY_HOST})"
# session_task re-parses inside the run_with_timeout child bash, which only
# inherits exported env; export the vars it reads so none collapse to empty.
export SW_REPO SW_PORT SW_WORKFLOW SW_CANARY_HOST SW_API_KEY SW_SESSION_LOG SW_SESSION_OUT
(
  run_with_timeout "$SW_TIMEOUT" bash -c "$(declare -f session_task); session_task" \
    || { rc=$?; if [ "$rc" -eq 124 ]; then echo "canary: session timed out after ${SW_TIMEOUT}s" >&2; fi; exit "$rc"; }
)
echo "canary: session task completed"

LOG_TEXT=$(cat "$SW_SESSION_LOG" "$SW_GATEWAY_LOG" 2>/dev/null)

# Streamable MCP session identity: the executor authenticates its transport
# session as br_exec_<uuid>; the gateway session key surfaces it.
echo "$LOG_TEXT" | grep -q "br_exec_"
# Executor connected to the gateway and observed workflow state transitions.
echo "$LOG_TEXT" | grep -q "executor_gateway_connected"
echo "$LOG_TEXT" | grep -q "executor_state_observed"
# The forked branch sessions a/b produced their side-effect artifacts.
test -f "$SW_REPO/canary-branch-a.txt"
test -f "$SW_REPO/canary-branch-b.txt"
# No auth/ownership failures in the session or gateway logs.
! echo "$LOG_TEXT" | grep -q "403\|missing owner context"

# Native usage delivery only happens when the working repo carries an
# isolated-delivery config; on hosts where it is configured, require the
# usage evidence in the logs (old-host contract, receipts 013/014).
if [ -f "$SW_REPO/.statewright/delivery.json" ]; then
  echo "$LOG_TEXT" | grep -q "native_usage_seq"
fi

echo "canary: P0 gateway<->PB contract OK (workflow=${SW_WORKFLOW}, host=${SW_CANARY_HOST})"
