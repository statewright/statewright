#!/usr/bin/env bash
# Scenario 8: Native tool restrictions via setActiveTools
# Verifies that Pi's available tool set changes per state — tools not in
# allowed_tools are removed from the schema entirely, not just blocked.
#
# Pi-only: other agents use block-and-explain in tool_call hooks.

echo "=== Scenario 8: Native Tool Restrictions ==="

NAME="sw-08-tools"

case "$AGENT" in
  pi)
    spawn_pi "$NAME" "$FIXTURE_DIR"

    # Create a workflow where planning only allows Read/Grep (no Edit/Write/Bash)
    agent_send "$NAME" "Use the statewright_create_workflow tool to create a workflow called 'tool-restrict-test' with this JSON definition: {\"id\":\"tool-restrict-test\",\"initial\":\"planning\",\"states\":{\"planning\":{\"allowed_tools\":[\"Read\",\"Grep\"],\"instructions\":\"Read files only. Do NOT edit.\",\"max_iterations\":3,\"on\":{\"READY\":\"implementing\",\"FAIL\":\"failed\"}},\"implementing\":{\"allowed_tools\":[\"Read\",\"Edit\",\"Write\",\"Bash\"],\"instructions\":\"Make edits.\",\"max_iterations\":5,\"on\":{\"DONE\":\"completed\",\"FAIL\":\"failed\"}},\"completed\":{\"type\":\"final\"},\"failed\":{\"type\":\"final\"}}}<CR>"

    assert_screen_wait "$NAME" "tool-restrict-test\|created\|workflow" "workflow created" 30

    # Load the workflow
    agent_send "$NAME" "Load the tool-restrict-test workflow<CR>"
    assert_screen_wait "$NAME" "planning" "workflow loaded in planning state" 30

    # Ask the agent to list its available tools — should only see read/grep + statewright tools
    agent_send "$NAME" "What tools do you have available right now? List them.<CR>"
    assert_screen_wait "$NAME" "read\|grep" "read/grep tools visible" 30

    # Edit and write should NOT be in the tool list
    # (with native restrictions, the model shouldn't even know about them)
    assert_screen_not "$NAME" "\"edit\"\|\"write\"\|\"bash\"" "edit/write/bash not in tool list"

    # Transition to implementing — tools should expand
    agent_send "$NAME" "Call statewright_transition with event READY and data rationale 'done planning'<CR>"
    assert_screen_wait "$NAME" "implementing" "transitioned to implementing" 30

    # Now edit should be available
    agent_send "$NAME" "What tools do you have available right now? List them.<CR>"
    assert_screen_wait "$NAME" "edit\|write\|bash" "edit/write/bash tools now visible" 30

    agent_stop "$NAME"
    ;;
  *)
    echo "  SKIP: native tool restrictions only supported in Pi (agent='$AGENT')"
    return 0
    ;;
esac
