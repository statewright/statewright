#!/usr/bin/env bash
# Scenario 1: Workflow loads, state context injected, tools restricted

echo "=== Scenario 1: Workflow Load ==="

NAME="sw-01-load"

case "$AGENT" in
  claude)
    spawn_claude "$NAME" "$FIXTURE_DIR"
    agent_send "$NAME" "load the statewright-dev-v2 workflow<CR>"
    ;;
  codex)
    spawn_codex "$NAME" "load the statewright-dev-v2 workflow" "$FIXTURE_DIR"
    ;;
  omx)
    spawn_omx "$NAME" "$FIXTURE_DIR"
    agent_send "$NAME" "load the statewright-dev-v2 workflow<CR>"
    ;;
  pi)
    spawn_pi "$NAME" "$FIXTURE_DIR"
    agent_send "$NAME" "load the statewright-dev-v2 workflow<CR>"
    ;;
  *)
    echo "  SKIP: unknown agent '$AGENT'"
    return 0
    ;;
esac

assert_screen_wait "$NAME" "planning" "workflow loaded in planning state" 60

# Tool list display varies by agent — Pi uses status bar, Claude/OMX show in hook output
case "$AGENT" in
  pi) assert_screen "$NAME" "\[sw\].*planning" "statewright status bar active" ;;
  *)  assert_screen "$NAME" "Read" "Read tool available" ;;
esac

assert_screen "$NAME" "statewright_load_workflow\|statewright-dev\|Workflow loaded\|\[sw\]" "MCP tool called or workflow context injected"

agent_stop "$NAME"
