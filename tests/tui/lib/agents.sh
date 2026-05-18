#!/usr/bin/env bash
# Agent interfaces for headless TUI testing
# Each agent gets a spawn function that returns a session name

HT="${HT_BIN:-$(which ht-terminal 2>/dev/null || echo "$HOME/bin/ht-terminal")}"
STAGING_GW="${STATEWRIGHT_GATEWAY_URL:?Set STATEWRIGHT_GATEWAY_URL to your staging gateway}"
STAGING_KEY="${STATEWRIGHT_API_KEY:-$(cat "$HOME/.statewright/staging_api_key" 2>/dev/null | tr -d '[:space:]')}"
STAGING_PB="${STATEWRIGHT_PB_URL:?Set STATEWRIGHT_PB_URL to your staging PocketBase}"

spawn_claude() {
  local name="$1" workdir="${2:-$(pwd)}" model="${3:-}"
  local model_env=""
  if [ -n "$model" ]; then
    model_env="ANTHROPIC_MODEL=$model"
  elif [ -n "${ANTHROPIC_MODEL:-}" ]; then
    model_env="ANTHROPIC_MODEL=$ANTHROPIC_MODEL"
  fi
  $HT run --name "$name" --size 120x200 --cwd "$workdir" \
    env STATEWRIGHT_GATEWAY_URL="$STAGING_GW" \
    STATEWRIGHT_API_KEY="$STAGING_KEY" \
    $model_env \
    claude --dangerously-skip-permissions 2>&1 >/dev/null

  # Dismiss startup prompts until interactive prompt appears
  local att=0
  while [ $att -lt 30 ]; do
    sleep 2
    local scr=$($HT view "$name" 2>/dev/null)

    # Interactive prompt ready
    echo "$scr" | grep -qE "^>|╭─" && break

    # Workspace trust prompt
    if echo "$scr" | grep -q "trust this folder"; then
      $HT send "$name" $'\r' 2>/dev/null
      sleep 2
      continue
    fi

    # Dangerous permissions bypass
    if echo "$scr" | grep -q "Yes, I accept"; then
      $HT send "$name" "j" 2>/dev/null
      sleep 1
      $HT send "$name" $'\r' 2>/dev/null
      sleep 2
      continue
    fi

    att=$((att + 1))
  done
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
  local name="$1" workdir="${2:-$(pwd)}"
  local provider="${PI_PROVIDER:-google}"
  local model="${PI_MODEL:-}"
  local model_args=""
  [ -n "$model" ] && model_args="--provider $provider --model $model"

  $HT run --name "$name" --size 120x200 --cwd "$workdir" \
    env STATEWRIGHT_GATEWAY_URL="$STAGING_GW" \
    STATEWRIGHT_API_KEY="$STAGING_KEY" \
    pi $model_args 2>&1 >/dev/null

  # Wait for Pi interactive prompt (> or similar)
  local attempts=0
  while [ $attempts -lt 15 ]; do
    sleep 2
    local screen
    screen=$($HT view "$name" 2>/dev/null)
    # Pi shows horizontal rule + model indicator when ready
    if echo "$screen" | grep -q "gemini\|ollama\|openai\|anthropic\|google"; then
      break
    fi
    attempts=$((attempts + 1))
  done

  echo "$name"
}

spawn_pi_print() {
  local name="$1" prompt="$2" workdir="${3:-$(pwd)}"
  local provider="${PI_PROVIDER:-google}"
  local model="${PI_MODEL:-}"
  local model_args=""
  [ -n "$model" ] && model_args="--provider $provider --model $model"

  $HT run --name "$name" --size 120x200 --cwd "$workdir" \
    env STATEWRIGHT_GATEWAY_URL="$STAGING_GW" \
    STATEWRIGHT_API_KEY="$STAGING_KEY" \
    pi --print $model_args "$prompt" 2>&1 >/dev/null
  echo "$name"
}

spawn_omx() {
  local name="$1" workdir="${2:-$(pwd)}"
  $HT run --name "$name" --size 120x200 --cwd "$workdir" \
    env STATEWRIGHT_GATEWAY_URL="$STAGING_GW" \
    STATEWRIGHT_API_KEY="$STAGING_KEY" \
    omx 2>&1 >/dev/null

  # Dismiss startup prompts until we reach the Codex interactive prompt
  local attempts=0
  while [ $attempts -lt 20 ]; do
    sleep 2
    local screen
    screen=$($HT view "$name" 2>/dev/null)

    # Codex interactive prompt has › and model indicator
    if echo "$screen" | grep -q "gpt-.*fast\|gpt-.*default\|o[34]-mini"; then
      break
    fi

    # Dismiss known prompts
    if echo "$screen" | grep -q "Star it on GitHub"; then
      $HT send "$name" "n" 2>/dev/null
      sleep 1
      $HT send "$name" $'\r' 2>/dev/null
    elif echo "$screen" | grep -q "Update now\|Skip until"; then
      $HT send "$name" "2" 2>/dev/null
      sleep 1
      $HT send "$name" $'\r' 2>/dev/null
    elif echo "$screen" | grep -q "Press enter to continue"; then
      $HT send "$name" $'\r' 2>/dev/null
    fi

    attempts=$((attempts + 1))
  done

  echo "$name"
}

spawn_omx_exec() {
  local name="$1" prompt="$2" workdir="${3:-$(pwd)}"
  $HT run --name "$name" --cwd "$workdir" \
    env STATEWRIGHT_GATEWAY_URL="$STAGING_GW" \
    STATEWRIGHT_API_KEY="$STAGING_KEY" \
    omx exec "$prompt" \
    --dangerously-bypass-approvals-and-sandbox \
    --skip-git-repo-check 2>&1 >/dev/null
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
