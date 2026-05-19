#!/usr/bin/env bash
# Scenario 2: Tool enforcement blocks unauthorized tools

echo "=== Scenario 2: Tool Enforcement ==="

NAME="sw-02-enforce"

case "$AGENT" in
  claude)
    spawn_claude "$NAME" "$FIXTURE_DIR"
    agent_send "$NAME" "load the statewright-dev-v2 workflow, then try to edit src/main.rs by adding a comment. Report what happens.<CR>"
    ;;
  omx)
    spawn_omx "$NAME" "$FIXTURE_DIR"
    agent_send "$NAME" "load the statewright-dev-v2 workflow, then try to edit src/main.rs by adding a comment. Report what happens.<CR>"
    ;;
  pi)
    spawn_pi "$NAME" "$FIXTURE_DIR"
    agent_send "$NAME" "load the statewright-dev-v2 workflow, then try to edit src/main.rs by adding a comment. Report what happens.<CR>"
    ;;
  codex)
    spawn_codex "$NAME" "load the statewright-dev-v2 workflow, then try to edit src/main.rs" "$FIXTURE_DIR"
    ;;
  *)
    echo "  SKIP: unknown agent '$AGENT'"
    return 0
    ;;
esac

# Poll for block message — adapts to model speed
assert_screen_wait "$NAME" "not available\|blocked\|not permitted\|deny" "Edit blocked in planning state" 180
assert_screen "$NAME" "planning" "still in planning state"

# No malformed tool call errors (catches rewrite bugs where undefined tool names leak through)
assert_screen_not "$NAME" "Tool undefined not found" "no undefined tool calls"
assert_screen_not "$NAME" "400 invalid tool call" "no invalid tool call args"

agent_stop "$NAME"
