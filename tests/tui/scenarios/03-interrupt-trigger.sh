#!/usr/bin/env bash
# Scenario 3: PB hook edit triggers interrupt

echo "=== Scenario 3: Interrupt Trigger ==="

NAME="sw-03-interrupt"
spawn_claude "$NAME" "$FIXTURE_DIR"

# Load workflow and advance to implementing
agent_send "$NAME" "load the statewright-dev-v2 workflow, then transition through planning scoping and branching to get to implementing. Create a feature branch first.<CR>"
agent_wait "$NAME" "implementing" 45

assert_screen "$NAME" "implementing" "reached implementing state"

# Edit a PB hook file — should trigger interrupt
agent_send "$NAME" "edit site/pb/hooks/test.pb.js and add a console.log line<CR>"
agent_wait "$NAME" "INTERRUPT\|pb_validating" 30

assert_screen "$NAME" "INTERRUPT\|pb_validating" "interrupt triggered by PB hook edit"

# Complete the interrupt
agent_send "$NAME" "the hook is valid, transition VALIDATED<CR>"
agent_wait "$NAME" "implementing" 20

assert_screen "$NAME" "implementing" "returned to implementing after interrupt"

agent_stop "$NAME"
