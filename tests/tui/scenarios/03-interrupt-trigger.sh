#!/usr/bin/env bash
# Scenario 3: PB hook edit triggers interrupt

echo "=== Scenario 3: Interrupt Trigger ==="

NAME="sw-03-interrupt"
SID=$(spawn_claude "$NAME" "load the statewright-dev-v2 workflow, transition to implementing (skip through planning/scoping/branching quickly), then edit site/pb/hooks/test.pb.js to add a console.log line. Report what happens after the edit." "$FIXTURE_DIR")

# Agent should work through states, edit the PB file, and interrupt should fire
agent_wait "$NAME" "INTERRUPT" 60

assert_screen "$NAME" "INTERRUPT" "interrupt triggered by PB hook edit"
assert_screen "$NAME" "pb_validating" "transitioned to pb_validating"

agent_stop "$NAME"
