#!/usr/bin/env bash
# Scenario 3: PB hook edit triggers interrupt

echo "=== Scenario 3: Interrupt Trigger ==="

NAME="sw-03-interrupt"

case "$AGENT" in
  claude) spawn_claude "$NAME" "$FIXTURE_DIR" ;;
  omx)    spawn_omx "$NAME" "$FIXTURE_DIR" ;;
  pi)     spawn_pi "$NAME" "$FIXTURE_DIR" ;;
  *)      echo "  SKIP: unknown agent '$AGENT'"; return 0 ;;
esac

# Load workflow and advance to implementing
agent_send "$NAME" "load the statewright-dev-v2 workflow, then transition through planning scoping and branching to get to implementing. Create a feature branch first.<CR>"

assert_screen_wait "$NAME" "implementing" "reached implementing state" 120

# Edit a PB hook file — should trigger interrupt
agent_send "$NAME" "edit site/pb/hooks/test.pb.js and add a console.log line<CR>"

assert_screen_wait "$NAME" "INTERRUPT\|pb_validating" "interrupt triggered by PB hook edit" 90

# Complete the interrupt
agent_send "$NAME" "the hook is valid, transition VALIDATED<CR>"

assert_screen_wait "$NAME" "implementing" "returned to implementing after interrupt" 60

# No malformed tool calls from rewrite bugs
assert_screen_not "$NAME" "Tool undefined not found" "no undefined tool calls"
assert_screen_not "$NAME" "400 invalid tool call" "no invalid tool call args"

agent_stop "$NAME"
