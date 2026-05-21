#!/usr/bin/env bash
# Scenario 10: Model routing with local models (qwen3.6 + gemma4)
# Tests that tool restrictions survive cross-provider model switches.
# Reproduces the bug where qwen3.6 sees planning tools after transitioning
# to implementing (tools not updated on model switch).
#
# Pi-only. Requires ollama providers configured in models.json.

echo "=== Scenario 10: Model Routing with Local Models ==="

NAME="sw-10-local"

case "$AGENT" in
  pi)
    spawn_pi "$NAME" "$FIXTURE_DIR"

    # Load model-routing-v8 (must exist on staging)
    agent_send "$NAME" "Load the model-routing-v8 workflow<CR>"
    assert_screen_wait "$NAME" "planning" "workflow loaded in planning state" 30

    # Planning: gpt-5.5, tools should be read/grep/find/bash/ls
    assert_screen "$NAME" "\[sw\].*planning" "statewright status bar in planning"

    # Tell it to transition to implementing
    agent_send "$NAME" "Call statewright_transition with event PLAN_READY and data rationale 'plan complete'<CR>"
    assert_screen_wait "$NAME" "implementing" "transitioned to implementing" 30

    # Implementing: qwen3.6, tools should include edit/write/bash
    # This is the critical check — tools must expand after model + state change
    assert_screen "$NAME" "Model.*qwen\|ollama-qwen" "qwen model switch notification"

    # Ask qwen to list tools — edit must be present
    agent_send "$NAME" "Call statewright_get_state to check your current tools<CR>"
    assert_screen_wait "$NAME" "Edit\|edit" "edit tool in implementing state" 30
    assert_screen "$NAME" "Write\|write" "write tool in implementing state"
    assert_screen "$NAME" "Bash\|bash" "bash tool in implementing state"

    # Transition to testing (gemma4)
    agent_send "$NAME" "Call statewright_transition with event DONE and data rationale 'edits complete'<CR>"
    assert_screen_wait "$NAME" "testing" "transitioned to testing" 30
    assert_screen "$NAME" "Model.*gemma\|ollama/" "gemma model switch notification"

    agent_stop "$NAME"
    ;;
  *)
    echo "  SKIP: local model routing only supported in Pi (agent='$AGENT')"
    return 0
    ;;
esac
