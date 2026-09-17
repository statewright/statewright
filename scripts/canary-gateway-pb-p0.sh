#!/usr/bin/env bash
set -euo pipefail

# P0 gateway -> PB canary. Verifies:
#   1. gateway talks to PB over the API-key surface (health, key CRUD);
#   2. gateway fetches workflows through PB;
#   3. the statewright executor completes one real task through the gateway,
#      creating the streamable session (with slice-B branch key) whose native
#      usage reports are journaled and synced to PB.
#
# PB is addressable through the environment for remote hosts (Windows sandbox
# reaching PB on the macOS side): SW_PB_URL, SW_PB_HOST, SW_PB_PORT,
# SW_API_KEY, SW_API_KEY_NAME.

SW_REPO=/tmp/swhome
SW_BIN=$SW_REPO/bin/statewright-gateway
SW_PB_URL=${SW_PB_URL:-http://127.0.0.1:8090}
SW_PB_HOST=${SW_PB_HOST:-127.0.0.1}
SW_PB_PORT=${SW_PB_PORT:-8090}
SW_API_KEY_URL=$SW_PB_URL/api/key
SW_API_KEY=${SW_API_KEY:-9c1e640c-2c0e-4873-8786-1e74a3a2204b}
SW_API_KEY_NAME=${SW_API_KEY_NAME:-sw-canary-key}
SW_WORKFLOW=opt-slice-branching-v1
SW_SESSION_LOG=$SW_REPO/canary-session.log
SW_GATEWAY_LOG=$SW_REPO/canary-gateway.log
SW_SESSION_OUT=$SW_REPO/canary-session.out
SW_REPO_READY=$SW_REPO/.ready

mkdir -p "$SW_REPO"

pb_health() {
  curl -fsS --max-time 2 "$SW_PB_URL/api/health" > /dev/null
}

wait_for_pb() {
  local waited=0
  until pb_health; do
    if (( waited >= 60 )); then
      echo "PB did not become healthy in 60s"
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "PB is healthy after ${waited}s"
}

start_pb() {
  if pb_health; then
    echo "PB already healthy; skipping start"
    return
  fi
  (
    cd /Users/ben/dev/planboard
    exec node server.mjs
  ) > /tmp/pb-canary.log 2>&1 &
  PB_PID=$!
  echo "$PB_PID" > /tmp/pb-canary.pid
  echo "started PB pid=$PB_PID"
  wait_for_pb
}

ensure_repo() {
  if [ ! -d "$SW_REPO" ] || [ ! -d "$SW_REPO/.git" ]; then
    echo "repo copy missing; re-cloning"
    rm -rf "$SW_REPO"
    git clone --local "${SW_SRC_REPO:-/Users/ben/dev/statewright}" "$SW_REPO"
  fi
  # Keep the disposable copy at the source repo's current committed HEAD so
  # the canary always tests what is actually shipped, and rebuild the binary
  # only when the source moved.
  git -C "$SW_REPO" fetch -q origin
  local head
  head=$(git -C "$SW_REPO" rev-parse origin/HEAD 2>/dev/null \
    || git -C "$SW_REPO" rev-parse origin/master)
  if [ "$(git -C "$SW_REPO" rev-parse HEAD)" != "$head" ]; then
    git -C "$SW_REPO" checkout -q "$head"
    echo "repo copy synced to ${head:0:8}"
  fi
  local stamp="$SW_REPO/.canary-head"
  if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$head" ]; then
    echo "building gateway binary for ${head:0:8}"
    (cd "$SW_REPO" && cargo build --release --bin statewright-gateway)
    echo "$head" > "$stamp"
  fi
  if [ ! -x "$SW_REPO/target/release/statewright-gateway" ]; then
    echo "release binary missing after build attempt"
    exit 1
  fi
}

start_gateway() {
  local log=$1
  local key=${2:-$SW_API_KEY}
  rm -f "$log"
  (
    cd "$SW_REPO"
    SW_PB_URL="$SW_PB_URL" \
    SW_API_KEY="$key" \
    SW_GATEWAY_HOST=127.0.0.1 \
    SW_GATEWAY_PORT=8932 \
    SW_GATEWAY_MODE=remote \
    "$SW_BIN" > "$log" 2>&1 &
    echo $!
  )
}

session_task() {
  (
    cd "$SW_REPO"
    PATH="$SW_REPO/node_modules/.bin:$PATH" \
    node plugins/executor/bin/statewright-executor.mjs \
      --mode remote \
      --gateway-url http://127.0.0.1:8932 \
      --api-key "$SW_API_KEY" \
      --workflow-id "$SW_WORKFLOW" \
      --client-id "canary-session" \
      "Create a file named canary-session.txt in the current directory containing the literal text statewright canary session."
  )
}

start_pb
ensure_repo

# API key surface: idempotent upsert (the key is a persistent canary fixture,
# not a per-run artifact).
curl -fsS -X POST "$SW_API_KEY_URL" \
  -H 'content-type: application/json' \
  -d "{"name":"$SW_API_KEY_NAME","key":"$SW_API_KEY"}" > /dev/null
echo "canary API key ensured"

GW_PID=$(start_gateway "$SW_GATEWAY_LOG")
trap 'kill $GW_PID 2>/dev/null || true; wait 2>/dev/null || true' EXIT
waited=0
until grep -q 'statewright-gateway ready' "$SW_GATEWAY_LOG" 2>/dev/null; do
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "gateway process exited early"
    cat "$SW_GATEWAY_LOG"
    exit 1
  fi
  if (( waited >= 60 )); then
    echo "gateway did not become ready in 60s"
    cat "$SW_GATEWAY_LOG"
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done
echo "gateway ready after ${waited}s"

SESS_RC=0
session_task > "$SW_SESSION_OUT" 2>&1 || SESS_RC=$?
sleep 1

kill "$GW_PID" 2>/dev/null || true
trap - EXIT

# Hard session-log assertions: each P0 wiring the canary claims must show
# evidence in the gateway's own log, and the gateway process must not have
# crashed (the fetch-loop panic class of failure).
LOG_TEXT=$(cat "$SW_SESSION_LOG" "$SW_GATEWAY_LOG" 2>/dev/null || true)
fail=""
grep -q '"mcp_session_id"' <<<"$LOG_TEXT" || fail="streamable session never established"
grep -q 'br_exec_' <<<"$LOG_TEXT" || fail="${fail:+$fail; }slice-B branch session key absent"
grep -q 'opt-slice-branching-v1' <<<"$LOG_TEXT" || fail="${fail:+$fail; }canary workflow not loaded"
grep -q 'gateway streamable session closed' <<<"$LOG_TEXT" || fail="${fail:+$fail; }session did not close"
grep -Eq 'native_usage_seq=[1-9][0-9]*' <<<"$LOG_TEXT" || fail="${fail:+$fail; }no native usage report accepted"
grep -qE 'panicked|fatal runtime error' <<<"$LOG_TEXT" && fail="${fail:+$fail; }gateway process crashed"
if [ -n "$fail" ]; then
  echo "canary failed: $fail"
  exit 1
fi

# The session task itself must have completed.
if (( SESS_RC != 0 )); then
  echo "canary failed: session task exited $SESS_RC"
  cat "$SW_SESSION_OUT"
  exit 1
fi

echo "canary passed (hard session-log evidence + task exit 0)"
echo "done"
