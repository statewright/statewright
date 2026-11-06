# Classifier denial explanation: pane 7

## Scope and ownership

Source-only presentation repair on `release/codex-0.3.4-prep`, existing worktree
`.agent-worktrees/codex-0.3.4-release`, base
`777cd98f05efacd45e250a65197c116f08293729`; initial worktree clean.
No classifier, thresholds, workflow, approval eligibility, credentials, installed
runtime, or gateway changes. No blocked operation replayed. Local native state
reported no active workflow; retained Ben's skip-workflow direction for this repair.
The substantive SDLC boundary is one local commit, not installation or deployment.

Budget: one receipt investigation, one focused repair, one independent static
review and bounded re-review; focused tests only, no broad release build. Validation
and handoff were reserved before any installation work, which is outside this cut.

## Observed evidence versus inference

`death-rebirth:7.1` / `%8`, shell PID 6672, cwd `/Users/ben/dev/oathshaper`.
Native App Server PID 30109 has thread
`01a155f0-eebd-7cd1-9be5-af1120b55d37` open. Its original rollout is
`~/.codex/sessions/2026/10/19/rollout-2026-10-19T16-53-35-01a155f0-eebd-7cd1-9be5-af1120b55d37.jsonl`.

Recorded on 2026-10-22 UTC:

- 01:36:37.678: web tool blocked; rework 2/2.
- 01:37:19.238: Godot headless baseline blocked; rework 1/2.
- 01:37:31.690: Godot version read blocked; rework 2/2.

All three visible outputs say only that classifier policy requires
`complete_structural_evidence_or_separate_approval`, followed by a promise that
the classified intent will be sent for native approval. The retained outputs do
not expose their full machine receipts. Do not infer a specific semantic status,
score, failing argv fragment, or classification cause for those exact invocations.

Source-confirmed explanation defects: `semantic_authorization_disabled` was
missing from the formatter's reason mapping; several other distinct failures
were collapsed into a generic System One claim; speculative heredoc/interpreter
advice was shown regardless of actual command shape; missing scores became 0%;
rework wording promised a dialog without confirming submission or availability.

## Repair

`plugins/codex/scripts/guard-denial.mjs` supplies a shared, receipt-only formatter
for `hook.sh` and `executor-hook.mjs`. It explains reason codes, preserves known
gateway risk/exposure/source/status labels, distinguishes uncalibrated scores
from absent evidence, and states approval eligibility separately from approval.
Unknown labels are not reflected into display text. No command payload is used
to guess a cause. Existing machine receipts remain available to the agent.

Missing formatter/Node retains a denial with an explicit diagnostic-unavailable
message; it cannot allow a command. Existing approval results and delegation
handling remain authoritative. Rework counts do not imply submitted approval.

## Executed validation

- Red baseline: all 6 newly added diagnostic tests failed against old formatting.
- First focused run: 20 passed, zero failures.
- Final affected run: 30 passed, zero failures/skips, about 28 seconds:

  `node --test plugins/codex/tests/guard-denial.test.mjs plugins/codex/tests/executor-bridge.test.mjs plugins/codex/tests/classifier-approval.test.mjs plugins/codex/tests/desktop-runtime-bundle.test.mjs plugins/codex/tests/executor-core-bundle.test.mjs`

- `bash -n plugins/codex/hook.sh`: passed (host emits an existing locale warning).
- `git diff --check`: passed.
- Existing real hook/loopback fixture coverage retains deny, allow-once, rework,
  unavailable approval, stale authority, payload redaction, and symlinked loading.
- New cases cover disabled/incomplete/missing/threshold explanations, absent
  scores, eligibility unknown/false, policy restrictions, gateway source labels,
  and malformed/private-label exclusion.
- Independent static review identified omitted valid source/Account labels;
  corrected with closed-set coverage. Bounded re-review found no new concerns.

Full workspace tests and installed/live UI acceptance: not run, not claimed.
No Godot or web invocation was retried. Existing package/source consistency tests
pass; no version bump, package build, install, or session restart occurred.

Rollback: revert this presentation-only commit. Delivery requires the ordinary
reviewed plugin packaging/install lifecycle; pane 7 still uses its prior hook.
