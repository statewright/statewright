#!/usr/bin/env bash
# Scenario 4: Fork/join — sequential branch execution

echo "=== Scenario 4: Fork/Join ==="

NAME="sw-04-fork"

case "$AGENT" in
  claude) spawn_claude "$NAME" "$FIXTURE_DIR" ;;
  omx)    spawn_omx "$NAME" "$FIXTURE_DIR" ;;
  pi)     spawn_pi "$NAME" "$FIXTURE_DIR" ;;
  *)      echo "  SKIP: unknown agent '$AGENT'"; return 0 ;;
esac

agent_send "$NAME" "load the fork-staging-test workflow, trigger BUILD_DONE to fork, then work through all branches sequentially calling BRANCH_DONE for each. Report the final state after join.<CR>"

assert_screen_wait "$NAME" "FORK\|fork\|branches" "fork triggered" 120
assert_screen_wait "$NAME" "staging_deploy\|deploying\|joined\|BRANCH_DONE\|complete" "fork joined or branches progressed" 180

agent_stop "$NAME"
