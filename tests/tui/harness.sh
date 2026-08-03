#!/usr/bin/env bash
# Statewright TUI E2E Test Harness
# Spawns real agent terminals, runs scenarios, and verifies durable artifacts.
#
# Usage:
#   ./harness.sh                    # run all scenarios against claude
#   ./harness.sh --agent codex      # run against codex
#   ./harness.sh --scenario 03      # run specific scenario
#   ./harness.sh --list             # list available scenarios
set -uo pipefail
# No set -e — assertions handle failures, don't abort on non-zero

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Parse args
AGENT="claude"
SCENARIO_FILTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) AGENT="$2"; shift 2 ;;
    --scenario) SCENARIO_FILTER="$2"; shift 2 ;;
    --list) ls "$SCRIPT_DIR/scenarios/" | sed 's/\.sh$//' && exit 0 ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

# Load libraries
source "$SCRIPT_DIR/lib/agents.sh"
source "$SCRIPT_DIR/lib/assertions.sh"
source "$SCRIPT_DIR/lib/fixtures.sh"
source "$SCRIPT_DIR/lib/workflows.sh"

# Preflight
echo "=== Statewright TUI E2E Tests ==="
echo "Agent: $AGENT"
echo "Gateway: $STAGING_GW"
echo ""

# Scenario 11 uses a real, attachable tmux session. Legacy scenarios still use ht-terminal.
if [[ "$SCENARIO_FILTER" == *"11"* ]]; then
  if ! command -v tmux &>/dev/null; then
    echo "ERROR: tmux is required for scenario 11"
    exit 1
  fi
elif ! command -v "$HT" &>/dev/null; then
  echo "ERROR: headless-terminal (ht) not found at $HT"
  echo "Install: brew install montanaflynn/tap/ht"
  echo "  or: curl -L https://github.com/montanaflynn/headless-terminal/releases/latest/..."
  exit 1
fi

# Check API key
if [ -z "$STAGING_KEY" ]; then
  echo "ERROR: No staging API key. Set STATEWRIGHT_API_KEY or create ~/.statewright/staging_api_key"
  exit 1
fi

# Verify workflows exist
ensure_test_workflows
echo ""

# Setup fixture
echo "Setting up test fixture..."
FIXTURE_DIR=$(setup_fixture)
echo "Fixture: $FIXTURE_DIR"
echo ""

# Clean up on exit
cleanup() {
  echo ""
  echo "Cleaning up..."
  if declare -F cleanup_delivery_scenario >/dev/null; then
    cleanup_delivery_scenario
  fi
  # Stop any running ht sessions
  for name in $($HT list 2>/dev/null | jq -r '(.sessions // .)[]?.name // empty' 2>/dev/null); do
    if [[ "$name" == sw-* ]]; then
      $HT stop "$name" 2>/dev/null || true
      $HT remove "$name" 2>/dev/null || true
    fi
  done
  for name in $(tmux list-sessions -F '#S' 2>/dev/null); do
    if [[ "$name" == sw-* ]]; then
      tmux kill-session -t "$name" 2>/dev/null || true
    fi
  done
  teardown_fixture
}
trap cleanup EXIT

# Run scenarios
SCENARIOS="$SCRIPT_DIR/scenarios"
for scenario in "$SCENARIOS"/*.sh; do
  scenario_name=$(basename "$scenario" .sh)

  # Filter if specified
  if [ -n "$SCENARIO_FILTER" ] && [[ "$scenario_name" != *"$SCENARIO_FILTER"* ]]; then
    continue
  fi

  echo ""
  source "$scenario"
done

# Report
echo ""
report
exit $?
