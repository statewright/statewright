#!/usr/bin/env bash
# Scenario 6: Multi-model token/effort comparison
# Runs weather_bug fixture across 6 models, with and without Statewright.
# API models run in parallel, local models run sequentially (shared GPU).
#
# Usage:
#   ./harness.sh --scenario 06              # all models
#   ./harness.sh --scenario 06 --agent pi   # local models only

echo "=== Scenario 6: Multi-Model Token Comparison ==="

TASK="There are 6 tests in tests/test_weather.py. 4 are failing. Find the bug and fix it so all 6 pass. Run pytest to verify."
SW_TASK="Load the bugfix-bench workflow, then: $TASK"

RESULTS_DIR="/tmp/sw-06-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"
echo "  Results: $RESULTS_DIR"

# ── Helpers ──────────────────────────────────────────────────────

make_fixture() {
  local dir=$(mktemp -d /tmp/sw-06-fix-XXXXXX)
  cp -r "$SCRIPT_DIR/fixtures/weather_bug/"* "$dir/"
  (cd "$dir" && git init -q && git checkout -b main -q && git add -A && git commit -q -m "init") 2>/dev/null
  echo "$dir"
}

capture_metrics() {
  local name="$1" label="$2" mode="$3" start="$4"
  local end=$(date +%s)
  local wall=$((end - start))
  local screen=$($HT view "$name" 2>/dev/null)
  local result="FAIL"
  echo "$screen" | grep -qE "6 passed|6/6 pass|All 6 pass" && result="PASS"
  local tools=$(echo "$screen" | grep -cE "⏺|●|Read|Edit|Write|Bash|Grep|Glob|apply_patch" 2>/dev/null | tr -d '[:space:]')
  tools=${tools:-0}

  # Save full screen log
  echo "$screen" > "$RESULTS_DIR/${label// /-}-${mode}.log"

  # Append to TSV
  printf "%s\t%s\t%s\t%d\t%d\n" "$label" "$mode" "$result" "$wall" "$tools" >> "$RESULTS_DIR/results.tsv"

  echo "    ${mode}: ${result} | ${wall}s | ~${tools} tool calls"
}

# ── Single model run (vanilla + constrained) ─────────────────────

run_pair() {
  local label="$1" agent_type="$2" spawn_fn="$3" extra_args="$4" timeout="${5:-300}"
  local slug=$(echo "$label" | tr ' .' '-' | tr '[:upper:]' '[:lower:]')

  echo ""
  echo "  ── $label ──"

  # ── Vanilla ──
  local fv=$(make_fixture)
  local nv="sw-06-${slug}-v"
  $spawn_fn "$nv" "$fv" $extra_args
  local start_v=$(date +%s)
  agent_send "$nv" "${TASK}<CR>"
  $HT wait "$nv" --idle 15s --timeout "${timeout}s" 2>/dev/null || true
  capture_metrics "$nv" "$label" "vanilla" "$start_v"
  agent_stop "$nv"
  rm -rf "$fv"

  # ── Constrained ──
  local fc=$(make_fixture)
  local nc="sw-06-${slug}-c"
  $spawn_fn "$nc" "$fc" $extra_args
  local start_c=$(date +%s)
  agent_send "$nc" "${SW_TASK}<CR>"
  $HT wait "$nc" --idle 15s --timeout "${timeout}s" 2>/dev/null || true
  capture_metrics "$nc" "$label" "constrained" "$start_c"
  agent_stop "$nc"
  rm -rf "$fc"
}

# ── Agent spawners (model-aware wrappers) ────────────────────────

spawn_claude_model() {
  local name="$1" workdir="$2" model="$3"
  spawn_claude "$name" "$workdir" "$model"
}

spawn_omx_model() {
  local name="$1" workdir="$2" model_flag="$3"
  $HT run --name "$name" --size 120x200 --cwd "$workdir" \
    env STATEWRIGHT_GATEWAY_URL="$STAGING_GW" STATEWRIGHT_API_KEY="$STAGING_KEY" \
    omx $model_flag 2>&1 >/dev/null
  local att=0
  while [ $att -lt 20 ]; do
    sleep 2
    local scr=$($HT view "$name" 2>/dev/null)
    echo "$scr" | grep -qE "gpt|o[34]|model|ready" && break
    echo "$scr" | grep -q "Star it" && { $HT send "$name" "n" 2>/dev/null; sleep 1; $HT send "$name" $'\r' 2>/dev/null; }
    echo "$scr" | grep -qE "Update now|Skip until" && { $HT send "$name" "2" 2>/dev/null; sleep 1; $HT send "$name" $'\r' 2>/dev/null; }
    echo "$scr" | grep -q "Press enter" && $HT send "$name" $'\r' 2>/dev/null
    att=$((att + 1))
  done
}

spawn_pi_model() {
  local name="$1" workdir="$2" provider="$3" model="$4"
  PI_PROVIDER="$provider" PI_MODEL="$model" spawn_pi "$name" "$workdir"
}

# ── Run matrix ───────────────────────────────────────────────────

printf "model\tmode\tresult\twall_s\ttool_calls\n" > "$RESULTS_DIR/results.tsv"

# Respect --agent filter: "claude" = Claude only, "pi" = local only, anything else = all
case "${AGENT:-all}" in
  claude)
    # run_pair "Opus 4.6"   claude spawn_claude_model "claude-opus-4-6"   120
    run_pair "Sonnet 4.6" claude spawn_claude_model "claude-sonnet-4-6" 120
    ;;
  omx)
    run_pair "GPT-5"        omx spawn_omx_model "--model gpt-5"        120
    run_pair "GPT-4.1-mini" omx spawn_omx_model "--model gpt-4.1-mini" 90
    ;;
  pi)
    run_pair "Llama 70B"   pi spawn_pi_model "ollama-nvlink llama3.3:latest" 300
    run_pair "GPT-OSS 20B" pi spawn_pi_model "ollama-nvlink gpt-oss"         300
    ;;
  *)
    # API models — run in parallel (each run_pair is sequential internally)
    echo ""
    echo "── API Models (parallel) ──"
    run_pair "Opus 4.6"     claude spawn_claude_model "claude-opus-4-6"     120 &
    PID_OPUS=$!
    run_pair "Sonnet 4.6"   claude spawn_claude_model "claude-sonnet-4-6"  120 &
    PID_SONNET=$!
    run_pair "GPT-5"        omx    spawn_omx_model    "--model gpt-5"      120 &
    PID_GPT5=$!
    run_pair "GPT-4.1-mini" omx    spawn_omx_model    "--model gpt-4.1-mini" 90  &
    PID_MINI=$!

    echo "  Waiting for API models (4 parallel pairs)..."
    wait $PID_OPUS $PID_SONNET $PID_GPT5 $PID_MINI

    # Local models — sequential (shared GPU)
    echo ""
    echo "── Local Models (sequential) ──"
    run_pair "Llama 70B"   pi spawn_pi_model "ollama-nvlink llama3.3:latest" 300
    run_pair "GPT-OSS 20B" pi spawn_pi_model "ollama-nvlink gpt-oss"         300
    ;;
esac

# ── Results table ────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  RESULTS: weather_bug fixture (4 failing → 6 passing)"
echo "════════════════════════════════════════════════════════════"
echo ""
printf "%-16s  %-12s %-7s %6s %6s\n" "Model" "Mode" "Result" "Wall" "Tools"
printf "%-16s  %-12s %-7s %6s %6s\n" "────────────────" "────────────" "───────" "──────" "──────"
while IFS=$'\t' read -r model mode result wall tools; do
  [[ "$model" == "model" ]] && continue  # skip header
  printf "%-16s  %-12s %-7s %5ds %5d\n" "$model" "$mode" "$result" "$wall" "$tools"
done < "$RESULTS_DIR/results.tsv"

echo ""
echo "Full logs: $RESULTS_DIR/"
echo "════════════════════════════════════════════════════════════"
