#!/usr/bin/env bash
# Scenario 1: Workflow loads, state context injected, tools restricted

echo "=== Scenario 1: Workflow Load ==="

NAME="sw-01-load"
spawn_claude "$NAME" "load the statewright-dev-v2 workflow and report your current state and available tools"

# claude -p exits after responding — wait for process to finish
sleep 20

assert_screen "$NAME" "planning" "workflow loaded in planning state"
assert_screen "$NAME" "Read" "Read tool available"
assert_screen "$NAME" "SCOPED" "SCOPED transition available"

agent_stop "$NAME"
