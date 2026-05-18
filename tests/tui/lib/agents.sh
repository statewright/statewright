#!/usr/bin/env bash
# Agent interfaces for headless TUI testing
# Each agent gets a spawn function that returns a session name

HT="${HT_BIN:-$(which ht-terminal 2>/dev/null || echo "$HOME/bin/ht-terminal")}"
STAGING_GW="${STATEWRIGHT_GATEWAY_URL:-https://statewright-mcp.casa.enhasa.cloud}"
STAGING_KEY="${STATEWRIGHT_API_KEY:-$(cat "$HOME/.statewright/staging_api_key" 2>/dev/null | tr -d '[:space:]')}"
STAGING_PB="${STATEWRIGHT_PB_URL:-https://statewright.casa.enhasa.cloud}"

spawn_claude() {
  local name="$1" prompt="$2" workdir="${3:-$(pwd)}"
  $HT run --name "$name" \
    env STATEWRIGHT_GATEWAY_URL="$STAGING_GW" \
    STATEWRIGHT_API_KEY="$STAGING_KEY" \
    claude -p "$prompt" \
    --dangerously-skip-permissions 2>&1 >/dev/null
  echo "$name"
}

spawn_codex() {
  local name="$1" prompt="$2" workdir="${3:-$(pwd)}"
  $HT run --name "$name" \
    env STATEWRIGHT_GATEWAY_URL="$STAGING_GW" \
    STATEWRIGHT_API_KEY="$STAGING_KEY" \
    codex -q "$prompt" \
    --full-auto \
    -C "$workdir" 2>&1 | jq -r '.id // empty' 2>/dev/null
  echo "$name"
}

spawn_pi() {
  local name="$1" prompt="$2" workdir="${3:-$(pwd)}"
  $HT run --name "$name" \
    env STATEWRIGHT_GATEWAY_URL="$STAGING_GW" \
    STATEWRIGHT_API_KEY="$STAGING_KEY" \
    pi --non-interactive "$prompt" \
    --workdir "$workdir" 2>&1 | jq -r '.id // empty' 2>/dev/null
  echo "$name"
}

agent_view() {
  local name="$1"
  $HT view "$name" 2>/dev/null
}

agent_wait() {
  local name="$1" text="$2" timeout="${3:-30}"
  $HT wait "$name" --wait-text "$text" --timeout "${timeout}s" 2>/dev/null
}

agent_send() {
  local name="$1" keys="$2"
  $HT send "$name" "$keys" 2>/dev/null
}

agent_stop() {
  local name="$1"
  $HT stop "$name" 2>/dev/null
  $HT remove "$name" 2>/dev/null
}
