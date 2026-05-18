#!/usr/bin/env bash
# Scenario 1: Workflow loads, state context injected, tools restricted

echo "=== Scenario 1: Workflow Load ==="

NAME="sw-01-load"
spawn_claude "$NAME" "$FIXTURE_DIR"

# Load workflow
agent_send "$NAME" "load the statewright-dev-v2 workflow<CR>"
sleep 20

assert_screen "$NAME" "planning" "workflow loaded in planning state"
assert_screen "$NAME" "Read" "Read tool available"
assert_screen "$NAME" "statewright_load_workflow\|statewright-dev" "MCP tool called"

agent_stop "$NAME"
