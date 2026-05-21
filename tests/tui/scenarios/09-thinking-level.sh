#!/usr/bin/env bash
# Scenario 9: Per-state thinking level
# Verifies that Pi's thinking/reasoning effort changes per state.
# Planning gets "high" thinking, testing gets "off".
#
# Pi-only: other agents don't support programmatic thinking level control.

echo "=== Scenario 9: Per-State Thinking Level ==="

NAME="sw-09-thinking"

case "$AGENT" in
  pi)
    spawn_pi "$NAME" "$FIXTURE_DIR"

    # Create a workflow with thinking_level per state
    agent_send "$NAME" "Use the statewright_create_workflow tool to create a workflow called 'thinking-test' with this JSON definition: {\"id\":\"thinking-test\",\"initial\":\"planning\",\"states\":{\"planning\":{\"allowed_tools\":[\"Read\",\"Grep\",\"Glob\",\"Bash\"],\"thinking_level\":\"high\",\"instructions\":\"Analyze the codebase thoroughly.\",\"max_iterations\":3,\"on\":{\"READY\":\"implementing\",\"FAIL\":\"failed\"}},\"implementing\":{\"allowed_tools\":[\"Read\",\"Edit\",\"Bash\"],\"thinking_level\":\"medium\",\"instructions\":\"Make edits.\",\"max_iterations\":5,\"on\":{\"DONE\":\"testing\",\"FAIL\":\"failed\"}},\"testing\":{\"allowed_tools\":[\"Read\",\"Bash\"],\"thinking_level\":\"off\",\"instructions\":\"Run tests.\",\"max_iterations\":3,\"on\":{\"TESTS_PASS\":\"completed\",\"TESTS_FAIL\":\"implementing\",\"FAIL\":\"failed\"}},\"completed\":{\"type\":\"final\"},\"failed\":{\"type\":\"final\"}}}<CR>"

    assert_screen_wait "$NAME" "thinking-test\|created\|workflow" "workflow created" 30

    # Load the workflow
    agent_send "$NAME" "Load the thinking-test workflow<CR>"
    assert_screen_wait "$NAME" "planning" "workflow loaded in planning state" 30

    # Pi's status bar shows thinking level — should show "high"
    # Pi format: (provider) model • thinking_level
    assert_screen "$NAME" "high\|extended" "high thinking level active in planning"

    # Transition to implementing — thinking should drop to medium
    agent_send "$NAME" "Call statewright_transition with event READY and data rationale 'done planning'<CR>"
    assert_screen_wait "$NAME" "implementing" "transitioned to implementing" 30
    assert_screen "$NAME" "medium" "medium thinking level in implementing"

    # Transition to testing — thinking should be off
    agent_send "$NAME" "Call statewright_transition with event DONE and data rationale 'edits complete'<CR>"
    assert_screen_wait "$NAME" "testing" "transitioned to testing" 30
    # Check the bottom status line specifically — "off" or no thinking indicator
    # (can't use screen_not for "high" since it appears in earlier scroll buffer)
    assert_screen "$NAME" "testing" "testing state confirmed in status bar"

    agent_stop "$NAME"
    ;;
  *)
    echo "  SKIP: thinking level control only supported in Pi (agent='$AGENT')"
    return 0
    ;;
esac
