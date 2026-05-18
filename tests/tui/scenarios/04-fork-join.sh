#!/usr/bin/env bash
# Scenario 4: Fork/join — sequential branch execution

echo "=== Scenario 4: Fork/Join ==="

NAME="sw-04-fork"
SID=$(spawn_claude "$NAME" "load the fork-staging-test workflow, trigger BUILD_DONE to fork, then work through all branches sequentially calling BRANCH_DONE for each. Report the final state after join." "$FIXTURE_DIR")

# Agent should fork, work branches, join
agent_wait "$NAME" "FORK" 30
assert_screen "$NAME" "FORK" "fork triggered"

agent_wait "$NAME" "staging_deploy\|deploying\|joined" 90
assert_screen "$NAME" "deploying\|staging_deploy\|joined" "fork joined successfully"

agent_stop "$NAME"
