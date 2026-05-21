#!/usr/bin/env bash
# Scenario 7: Per-state model routing (cross-provider)
# Verifies that Pi switches models and shows indicators in the status bar
# when states define a model field. Tests cross-provider switching:
# openai-codex/gpt-5.4-mini (cheap) -> openai-codex/gpt-5.4 (default, restored).
#
# Requires: ChatGPT Plus/Pro subscription via /login (openai-codex provider).
# Falls back to Anthropic models if openai-codex is not authenticated.
#
# Pi-only: other agents don't support programmatic model switching yet.

echo "=== Scenario 7: Per-State Model Routing ==="

NAME="sw-07-model"

case "$AGENT" in
  pi)
    spawn_pi "$NAME" "$FIXTURE_DIR"

    # Create a workflow with per-state model fields.
    # Uses openai-codex models (subscription, no metered token cost).
    # "planning" gets gpt-5.4-mini (cheap), "implementing" inherits gpt-5.4 default.
    agent_send "$NAME" "Use the statewright_create_workflow tool to create a workflow called 'model-routing-test' with this JSON definition: {\"id\":\"model-routing-test\",\"initial\":\"planning\",\"meta\":{\"default_model\":\"openai-codex/gpt-5.4\"},\"states\":{\"planning\":{\"allowed_tools\":[\"Read\",\"Grep\",\"Glob\",\"Bash\"],\"model\":\"openai-codex/gpt-5.4-mini\",\"instructions\":\"Read files and plan. Do NOT edit.\",\"max_iterations\":3,\"on\":{\"READY\":\"implementing\",\"FAIL\":\"failed\"}},\"implementing\":{\"allowed_tools\":[\"Read\",\"Edit\",\"Bash\"],\"instructions\":\"Make edits.\",\"max_iterations\":5,\"on\":{\"DONE\":\"completed\",\"FAIL\":\"failed\"}},\"completed\":{\"type\":\"final\"},\"failed\":{\"type\":\"final\"}}}<CR>"

    # Wait for workflow creation confirmation
    assert_screen_wait "$NAME" "model-routing-test\|created\|workflow" "workflow created" 30

    # Load the workflow
    agent_send "$NAME" "Load the model-routing-test workflow<CR>"
    assert_screen_wait "$NAME" "planning" "workflow loaded in planning state" 30

    # Verify status bar shows model with downgrade indicator (mini < default gpt-5.4)
    assert_screen "$NAME" "\[sw\]" "statewright status bar active"
    assert_screen "$NAME" "gpt-5.4-mini\|mini" "mini model shown in status bar"

    # Verify model switch notification appeared
    assert_screen "$NAME" "Model switched\|model.*mini\|model.*gpt" "model switch notification"

    # Transition to implementing (no explicit model — should restore to gpt-5.4 default)
    agent_send "$NAME" "Call statewright_transition with event READY and data rationale 'planning complete'<CR>"
    assert_screen_wait "$NAME" "implementing" "transitioned to implementing" 30

    # Status bar should no longer show mini
    assert_screen_not "$NAME" "mini.*implementing" "mini not shown for implementing state"

    # Should show restore notification
    assert_screen "$NAME" "restored\|Model.*gpt-5.4[^-]" "model restored notification"

    agent_stop "$NAME"
    ;;
  *)
    echo "  SKIP: model routing only supported in Pi (agent='$AGENT')"
    return 0
    ;;
esac
