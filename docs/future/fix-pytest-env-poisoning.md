# Statewright - Fix Pytest Environment Poisoning in SWE-bench Direct Drive

## Overview

The current SWE-bench direct-drive setup is wasting time on fake test failures.
The agent container can run `python3`, but it does not have the repo-specific
test environment or `pytest` installed, so `run_test` often falls into
`python3 -m pytest ...` and reports `No module named pytest`.

That is not a model problem. It is an environment mismatch.

The fix is to stop treating the agent image as the test environment. Instead,
run `sw-agent` inside the official SWE-bench eval image for each instance, where
the repo, fixtures, and dependency set are already present.

## Decision

Use the SWE-bench eval image as the main container for each instance and inject
the `sw-agent` binary into it via an init container or a small bootstrap layer.

This keeps the test environment authentic and removes the current failure mode
where the harness asks a generic image to behave like a fully provisioned repo
fixture environment.

## Why This Is The Right Pivot

- The tmux `death-rebirth` discussion converged on this model: eval image first,
  agent binary second.
- The current agent image is minimal by design and does not contain pytest or
  repo dependencies.
- The current harness heuristics are good enough for generic repos, but they are
  wrong for SWE-bench direct-drive when the official fixtures already exist in
  the eval image.
- The operator already models an `evaluation.registry`, so the architecture has
  a place for this concept even though it is not wired into the current job path.

## Current Failure Mode

Today the flow is:

1. Operator creates a single Job per instance.
2. The Job runs `ghcr.io/statewright/sw-agent:latest` or a pinned variant.
3. `entrypoint.sh` clones the repo and applies the test patch.
4. `sw-agent` runs `run_test`.
5. `run_test` often chooses `python3 -m pytest ...`.
6. The container does not have pytest installed, so the harness reports a test
   failure that is really an environment failure.

This causes:

- wasted steps
- misleading auto-test feedback
- false aborts
- lower solve rate on valid edits

## Target Architecture

For each SWE-bench instance:

1. The operator selects the per-instance eval image from the benchmark registry.
2. An init container copies the `sw-agent` binary and any small bootstrap assets
   into a shared `emptyDir`.
3. The main container is the eval image itself.
4. The main container uses the preinstalled repo checkout and dependencies.
5. `sw-agent` runs against `/testbed` directly.
6. `run_test` executes the repo's real test command inside that environment.

### Concrete Shape

```text
initContainer: sw-agent bootstrap
  - fetch instance metadata
  - stage /setup/test.patch
  - stage /setup/sw-agent

mainContainer: SWE-bench eval image
  - /testbed already populated
  - repo dependencies already installed
  - run /setup/sw-agent --workdir /testbed
  - run tests directly in the eval environment
```

## Harness Rules

### Test Execution

`run_test` should behave as follows:

- If the image has the official SWE-bench environment available, run the
  instance's test command directly in that environment.
- If pytest is not present but a repo-native test runner is available, use the
  repo-native runner.
- If neither is available, report `TEST_ENV_UNAVAILABLE` rather than pretending
  the model edit caused the failure.

### Auto-Test Feedback

When auto-test fails because the environment is missing the runner or deps:

- do not tell the model the edit failed tests
- do not restore the edit as a correctness failure
- surface the failure as environment/setup noise

When auto-test fails in a real environment:

- keep the current post-edit feedback flow
- still preserve the v12 improvement that keeps small failed source edits

## Operator Changes

1. Use the instance-specific eval image as the Job's main container image.
2. Inject the `sw-agent` binary through an init container or bootstrap step.
3. Preserve the current `/results` PVC capture flow.
4. Keep the current job-level timeout and backoff semantics.
5. Do not add a second sibling pod unless the eval image approach proves
   impossible.

## Harness Changes

1. Add environment detection for the SWE-bench eval image.
2. Add a direct test-runner path for the eval image.
3. Add `TEST_ENV_UNAVAILABLE` classification.
4. Keep `run_test` conservative for generic repos, but stop forcing pytest when
   the environment clearly does not support it.
5. Preserve the post-edit keep-on-small-failure behavior from v12.

## Acceptance Criteria

The fix is good enough when all of the following are true:

- `No module named pytest` no longer appears on normal SWE-bench eval runs.
- A valid Django or pytest-based repo runs its tests directly in the eval image
  without harness-specific test-env setup.
- The current 50-instance cohort can be rerun with the same instance set.
- Test failures caused by missing test tooling are classified separately from
  model mistakes.
- The existing v12 gains from keeping small failed edits remain intact.

## Rollout Plan

1. Implement the eval-image/main-container path behind a run flag if needed.
2. Validate on one or two instances from the current 50 cohort.
3. Rerun the full 50-instance cohort once the test path is stable.
4. Compare solve rate and abort rate against v13.

## Notes

This is a harness fix, not a model fix. The goal is to give the model a real
test environment, not better excuses for a missing one.
