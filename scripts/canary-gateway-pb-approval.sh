#!/usr/bin/env bash
# Gateway <-> PocketBase approval contract canary (D1 / slice D).
#
# Runs the real remote gateway with the reference PB integration, a real pi
# host session (pi --no-extensions + the statewright extension auto-loaded),
# and the approval-seq-v1 workflow, which parks on two approval-gated
# transitions:
#
#   GO_A: externally approval-gated. The canary harness is the approver:
#         it first proves a callback with the WRONG approval secret is
#         rejected (401) while the run stays parked, then applies the
#         approval out-of-band through POST /api/approval-callback with the
#         shared secret; the pi pane resumes only after that receipt.
#   GO_B: owner-approval-gated. The pi pane (workflow owner) self-approves
#         by repeating the transition, per the D1 contract that a pane
#         re-transition is an owner approval, not a double-transition.
#
# Finally the PB data is restarted and the approval receipts re-queried to
# prove durable persistence in PB, not gateway memory.
set -eu

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SW_PORT=${SW_PORT:-8941}
SW_PB_PORT=${SW_PB_PORT:-8091}
SW_PB_URL=${SW_PB_URL:-http://127.0.0.1:${SW_PB_PORT}}
SW_WORKFLOW=${SW_WORKFLOW:-approval-seq-v1}
SW_CANARY_HOST=${SW_CANARY_HOST:-pi}
SW_API_KEY=${SW_API_KEY:-sw-canary-key}
SW_PB_APPROVAL_SECRET=${SW_PB_APPROVAL_SECRET:-sw-canary-approval-secret}
# The pi host is launched with --no-extensions and no --provider, so the
# canary pins it to the local Ollama-backed provider explicitly.
SW_FALLBACK_MODEL=${SW_FALLBACK_MODEL:-ollama-ninfer-qwen38/qwen3.8-27b}
SW_TIMEOUT=${SW_TIMEOUT:-900}
SW_REPO=${SW_REPO:-}

if [ -z "$SW_REPO" ]; then
  SW_REPO=$(mktemp -d /tmp/swhome.XXXXXX)
  trap 'rm -rf "$SW_REPO"' EXIT
  git clone --quiet "$REPO_ROOT" "$SW_REPO"
  # The pi extension loads from the clone and resolves its own runtime deps
  # (minimatch et al.) from plugins/pi/node_modules, which git does not copy.
  if [ -d "$REPO_ROOT/plugins/pi/node_modules" ]; then
    cp -R "$REPO_ROOT/plugins/pi/node_modules" "$SW_REPO/plugins/pi/node_modules"
  fi
fi

SW_PB_LOG=/tmp/sw-canary-pb-approval.log
SW_PB_DATA=/tmp/sw-canary-pb-approval.sqlite
SW_PB_PID=""
SW_SESSION_PG=""
rm -f "$SW_PB_LOG" "$SW_PB_DATA"

stop_reference_pb() {
  if [ -n "$SW_PB_PID" ]; then
    kill "$SW_PB_PID" 2>/dev/null || true
    wait "$SW_PB_PID" 2>/dev/null || true
    SW_PB_PID=""
  fi
}

stop_session_tree() {
  # run_session enables job control, so the session subshell, script(1),
  # the executor node process, and the host share one process group and can
  # be torn down together. For TUI hosts whose child re-parents (script(1)),
  # also reap the keepalive feeder whose death cascades EOF/SIGHUP through
  # the PTY to the host.
  if [ -n "${SW_SESSION_PG:-}" ]; then
    kill -- "-$SW_SESSION_PG" 2>/dev/null || true
  fi
  pkill -f 'tail -f /dev/null' 2>/dev/null || true
  SW_SESSION_PG=""
}

start_reference_pb() {
  PB_PORT="$SW_PB_PORT" \
  PB_DATA="$SW_PB_DATA" \
  PB_KEY="$SW_API_KEY" \
  PB_APPROVAL_SECRET="$SW_PB_APPROVAL_SECRET" \
  PB_WORKFLOW_FILE="$REPO_ROOT/scripts/canary/${SW_WORKFLOW}.json" \
  node "$REPO_ROOT/scripts/canary/pb-reference-server.mjs" \
    >"$SW_PB_LOG" 2>&1 &
  SW_PB_PID=$!
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

# Host-specific launch args: claude needs headless print mode in a non-TTY
# canary shell. Do not forward -p to other hosts (opencode treats it as its
# server password). pi needs a fallback model because the canary workflow
# carries no route slice.
host_args() {
  case "$SW_CANARY_HOST" in
    claude) printf '%s\n' --host-arg -p ;;
    *) : ;;
  esac
}

# TUI hosts (pi) exit on stdin EOF when their stdin is not a TTY, which kills
# the pane right after the executor's first steering interrupt. Canaries run
# from non-TTY shells, so allocate a PTY via script(1) for the pi host. The
# keepalive (`tail -f /dev/null`) feeds the PTY master a stdin that never
# EOFs: with a dead stdin (e.g. /dev/null), script(1) tears down the master
# and pi still receives EOF/SIGHUP on its own stdin and exits.
run_host() {
  if [ "$SW_CANARY_HOST" = "pi" ] && [ ! -t 0 ] && command -v script >/dev/null 2>&1; then
    if [ "$(uname -s)" = "Darwin" ]; then
      tail -f /dev/null 2>/dev/null | script -q /dev/null "$@"
    else
      tail -f /dev/null 2>/dev/null | script -q -e -c "$*" /dev/null
    fi
  else
    "$@"
  fi
}

session_task() {
  local extra_args=()
  while IFS= read -r line; do extra_args+=("$line"); done < <(host_args)
  (
    cd "$SW_REPO"
    STATEWRIGHT_GATEWAY_URL="http://127.0.0.1:${SW_PORT}" \
    STATEWRIGHT_API_KEY="$SW_API_KEY" \
    STATEWRIGHT_TELEMETRY_PATH="$SW_SESSION_LOG" \
    run_host node plugins/executor/statewright-exec.mjs \
      --host "$SW_CANARY_HOST" \
      ${extra_args[@]+"${extra_args[@]}"} \
      ${SW_FALLBACK_MODEL:+--fallback-model "$SW_FALLBACK_MODEL"} \
      --workflow "$SW_WORKFLOW" \
      --cwd "$SW_REPO" \
      -- \
      "Follow the current state's instructions exactly. Do not ask questions; when a state gives explicit instructions, act on them, then use the statewright state-transition tool to move to the next state." \
      >"$SW_SESSION_OUT" 2>&1
  )
}

SW_SESSION_LOG=/tmp/sw-canary-session-approval.log
SW_SESSION_OUT=/tmp/sw-canary-session-out-approval.log
SW_GATEWAY_LOG=/tmp/sw-canary-gateway-approval.log
rm -f "$SW_SESSION_LOG" "$SW_SESSION_OUT" "$SW_GATEWAY_LOG"

# Register the canary API key with PB through the PB integration.
echo "canary: registering API key with PB"
SW_PB_URL="$SW_PB_URL" node - "$SW_API_KEY" <<'NODE'
const [key] = process.argv.slice(1);
const url = `${process.env.SW_PB_URL}/api/key`;
const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key, name: "canary-approval" }),
});
const body = await response.json();
if (!response.ok || !(body.ok ?? body.status)) {
  console.error(`canary: PB key registration failed (${response.status}): ${JSON.stringify(body)}`);
  process.exit(1);
}
console.log("canary: PB API key active");
NODE

echo "canary: checking workflow fetch from PB"
SW_PB_URL="$SW_PB_URL" SW_CHECK_KEY="$SW_API_KEY" SW_CHECK_WORKFLOW="$SW_WORKFLOW" node - <<'NODE'
const key = process.env.SW_CHECK_KEY;
const workflow = process.env.SW_CHECK_WORKFLOW;
const url = `${process.env.SW_PB_URL}/api/gateway/workflows`;
const response = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
const body = await response.json();
const names = Object.keys(body?.workflows ?? {});
if (!response.ok || !names.includes(workflow)) {
  console.error(`canary: PB workflow fetch failed (${response.status}): ${JSON.stringify(body)}`);
  process.exit(1);
}
console.log("canary: PB workflow list includes " + workflow);
NODE

# Start the reference gateway with PB integration + approval callback secret.
echo "canary: starting reference gateway on 127.0.0.1:${SW_PORT}"
SW_RUST_LOG="${SW_RUST_LOG:-info}"
SW_GATEWAY_PID=""
(
  cd "$REPO_ROOT"
  exec env RUST_LOG="$SW_RUST_LOG" \
  APPROVAL_CALLBACK_SECRET="$SW_PB_APPROVAL_SECRET" \
  ./target/release/statewright-gateway \
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
  stop_session_tree
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

export SW_REPO SW_PORT SW_WORKFLOW SW_CANARY_HOST SW_API_KEY SW_SESSION_LOG SW_SESSION_OUT SW_FALLBACK_MODEL
run_session() {
  set -m
  ( session_task ) &
  local pid=$!
  SW_SESSION_PG=$pid
  # Out-of-band approval orchestration while the session is parked.
  SW_PB_URL="$SW_PB_URL" SW_PORT="$SW_PORT" SW_PB_APPROVAL_SECRET="$SW_PB_APPROVAL_SECRET" \
  SW_REPO="$SW_REPO" node - <<'NODE'
const pb = process.env.SW_PB_URL;
const gw = `http://127.0.0.1:${process.env.SW_PORT}`;
const secret = process.env.SW_PB_APPROVAL_SECRET;
const repo = process.env.SW_REPO;
const fs = await import("node:fs");

async function approvals() {
  const r = await fetch(`${pb}/api/debug/approvals`);
  const b = await r.json();
  return b.approvals ?? [];
}
async function waitFor(timeoutMs, probe) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await probe();
    if (v) return v;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// Phase 1: the pane parks on GO_A; PB must hold a receipt for it. The
// default window tolerates slow local-model panes (minutes per model call).
const RECEIPT_WAIT_MS = Number(process.env.SW_CANARY_RECEIPT_WAIT_MS ?? "900000");
const first = await waitFor(RECEIPT_WAIT_MS, async () => {
  const rows = await approvals().catch(() => []);
  return rows.find(r => r.status === "pending") ?? rows[0] ?? null;
});
if (!first) { console.error("canary: no GO_A approval receipt appeared in PB"); process.exit(1); }
console.log(`canary: GO_A parked; PB receipt ${first.approval_id} (run ${first.run_id})`);

// Negative: a callback with the wrong approval secret must be rejected,
// and the run must stay parked afterwards.
const body = JSON.stringify({ approval_id: first.approval_id, status: "approved" });
const neg = await fetch(`${gw}/api/approval-callback`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer wrong-secret" },
  body,
});
if (neg.status !== 401) {
  console.error(`canary: negative approval callback expected 401, got ${neg.status}`);
  process.exit(1);
}
console.log("canary: wrong-secret approval callback rejected (401)");
await new Promise(r => setTimeout(r, 4000));
if (fs.existsSync(`${repo}/canary-approved.txt`)) {
  console.error("canary: run resumed despite rejected approval");
  process.exit(1);
}

// Positive: the harness approves out-of-band with the shared secret.
const pos = await fetch(`${gw}/api/approval-callback`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
  body,
});
if (!pos.ok) {
  console.error(`canary: external approval failed (${pos.status}): ${await pos.text()}`);
  process.exit(1);
}
console.log("canary: external approval applied to", first.approval_id);

// Phase 2: the pane resumes, reaches GO_B, and parks there; the pane
// (workflow owner) then self-approves by repeating the transition.
const second = await waitFor(RECEIPT_WAIT_MS, async () => {
  const rows = await approvals();
  return rows.find(r => r.approval_id !== first.approval_id) ?? null;
});
if (!second) {
  console.error("canary: no GO_B approval receipt appeared (pane never reached s2)");
  process.exit(1);
}
console.log(`canary: GO_B parked; PB receipt ${second.approval_id} (pane self-approval expected)`);
NODE
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    stop_session_tree
    wait "$pid" 2>/dev/null || true
    set +m
    return "$rc"
  fi
  set +m
  local session_rc=0
  wait "$pid" || session_rc=$?
  if [ "$session_rc" -eq 124 ] || [ "$session_rc" -gt 128 ]; then
    echo "canary: session terminated (timeout or signal)" >&2
    return "$session_rc"
  fi
  return "$session_rc"
}

echo "canary: running statewright executor session (host=${SW_CANARY_HOST})"
run_session
echo "canary: session + approval orchestration completed"

LOG_TEXT=$(cat "$SW_SESSION_LOG" "$SW_GATEWAY_LOG" 2>/dev/null)

# Streamable MCP session identity: the executor authenticates as br_exec_<uuid>.
echo "$LOG_TEXT" | grep -q "br_exec_"
echo "$LOG_TEXT" | grep -q "executor_gateway_connected"
echo "$LOG_TEXT" | grep -q "executor_state_observed"
# The approval-gated run reached its final state and wrote the artifact.
test -f "$SW_REPO/canary-approved.txt"
grep -q "approved" "$SW_REPO/canary-approved.txt"
# No auth/ownership failures in the session or gateway logs.
! echo "$LOG_TEXT" | grep -q "403\|missing owner context"

# PB restart persistence: receipts must survive a PB restart (SQLite-backed).
echo "canary: restarting reference PB to verify approval receipt persistence"
SW_PB_PID_SAVE="$SW_PB_PID"
SW_PB_PID=""
kill "$SW_PB_PID_SAVE" 2>/dev/null || true
wait "$SW_PB_PID_SAVE" 2>/dev/null || true
start_reference_pb
RECEIPTS=$(curl -sf "${SW_PB_URL}/api/debug/approvals")
echo "$RECEIPTS" | tee /tmp/sw-canary-approval-receipts.json
echo "$RECEIPTS" | grep -q '"approval_id"'
echo "$RECEIPTS" | grep -q "approved\|pending"

echo "canary: gateway<->PB approval contract OK (workflow=${SW_WORKFLOW}, host=${SW_CANARY_HOST})"
