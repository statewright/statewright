#!/usr/bin/env bash
# Scenario 2: Tool enforcement blocks unauthorized tools

echo "=== Scenario 2: Tool Enforcement ==="

NAME="sw-02-enforce"
SID=$(spawn_claude "$NAME" "load the statewright-dev-v2 workflow, then try to edit src/main.rs by adding a comment. Report what happens." "$FIXTURE_DIR")

# Agent should load workflow (planning state), then try Edit which should be blocked
agent_wait "$NAME" "not available" 30

assert_screen "$NAME" "not available" "Edit blocked in planning state"
assert_screen "$NAME" "planning" "still in planning state"

agent_stop "$NAME"
