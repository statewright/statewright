# Classifier candidate review

Status: source prepared; required direct parity check and installed native
acceptance remain blocked/unperformed. No new installation or deployment.

Candidate root: `/Volumes/sidecar/.agent-worktrees/statewright-effect-bundle-20261107`.
Committed base: `1b31772eecf4f99966270cfe34346bed8a6c4dfc`.
The effective candidate is the uncommitted patch, not the base commit alone.
Eleven tracked paths changed, 252 insertions and 17 deletions; research receipts
are additional untracked files. Earlier preparation worktrees are preserved.

## Review findings

The external effect reducer preserves external exposure while separating
unresolved effects from established high risk. `ExternalUnknown` cannot become
a read proof or grant execution. Known dangerous effects dominate in legacy,
AST and native reductions. Gateway approval clearance still checks independent
policy/capability restrictions, including local writes required by wget.

Both executor approval consumers recognize `external_effect_unresolved` only
with the existing eligible receipt and identity fields. Native acceptance
rechecks authoritative run/session/state/epoch before issuing a one-use grant.
The two generated Codex copies have independently measured hashes identical
to their respective executor sources. Laya remains evaluation-only; actual
semantic inference and native dialog behavior are not established here.

The controller records every unsuccessful completion as a denied intent,
including `approval_request_aborted` (controller `finish`, lines 190–205).
`begin` then rejects that intent as `approval_previously_denied` (lines 128–131).
There is no advertised local MCP tool to reopen this exact classifier approval.
The local workflow was independently read as terminal `blocked`, no pending
approval and no transitions. Loading a new run merely to clear that denial
would not be a supported recovery.

## Verification ledger

- Gateway focused external-effect test: passed in effect-approval preparation.
- Gateway library: 460 passed, 7 ignored, 0 failed in that preparation.
- Final candidate Rust diff compared byte-for-byte equal to tested preparation.
- Final executor controller/rework suites: 15 passed, 0 failed.
- Final `git diff --check`: passed.
- Direct generator parity command: blocked before execution; not retried.
  Receipt: `semantic_authorization_disabled`, `native_command_evidence_incomplete`,
  `separate_approval_allowed=true`, `approval_previously_denied`,
  prior reason `approval_request_aborted`. Intent
  `intent_v1_56ec242225cc5bf0a768671d0d8d2d13`; invocation
  `invocation_v1_33e6b884be1c5084ba88ea2bdfc937e9`.
- Desktop bundle test: passed, but indirectly invokes the denied drift function;
  retain the execution record and do not use it to discharge the denied gate.
- Proxy transport suite: unavailable because executor `ws` dependency is absent;
  earlier import failure retained. No install workaround attempted.
- Initial shared-target Rust request and parallel verification orchestration
  were stopped after returning no result; neither is a successful test receipt.
- Initial SHA-256 command failed in Perl locale initialization, exit 9. A normal
  `LC_ALL=C` invocation succeeded; this was a runtime failure, not policy denial.

## Remaining supported boundary

Obtain a supported exact native approval window for the denied parity command
without changing policy or deleting denial state; then complete transport and
installed acceptance under the normal dependency/install/delivery authority.
No approval tool for this recovery is advertised in the current conversation.
Do not substitute fixtures for actual native approve/deny/cancel execution.

## SHA-256 of effective code and test files

```
418fc61df5e53998d376dc2b7da71863d75216fdddbed3dbadc4d95042e8115e  crates/mcp-gateway/src/bash_classifier.rs
4334e056ff1db32babfaa57046f08bccb361ffd093a73d1d7771afe2a8702979  crates/mcp-gateway/src/gateway.rs
c2e010d8836d8be2e4630d52fe407f71d784b44656175b255c96ffd2a4b87cbd  crates/mcp-gateway/src/interceptors.rs
733939adf5e650ce886ec470c3ab568a0850a1dbd780b0ed700e0a39f49ea600  crates/mcp-gateway/src/risk_assessment.rs
7bf894bd93936275207dc916cc8d0d548f91b93b931409bfde34db9c898efe96  crates/mcp-gateway/src/shell_ast_shadow.rs
bb391a13fe3dd9af583a2e38247a78794dc57fef97e0d108484a1d25f9ef804f  plugins/executor/lib/classifier-approval-controller.mjs
6bda44b75e3978704951210408a94727d2cb22e3d4d78c12c44aa74e371985c5  plugins/executor/lib/classifier-rework-gate.mjs
c598ada3af97dadf0c55ef7e55c7b185c453ef3fcb1a0905b62dca0c58f565cd  plugins/executor/tests/classifier-approval-controller.test.mjs
d62e3f483a0bedb87e0d722eaf225511dea0944f1f419c86e7f575ab237981b3  plugins/executor/tests/classifier-rework-gate.test.mjs
bb391a13fe3dd9af583a2e38247a78794dc57fef97e0d108484a1d25f9ef804f  plugins/codex/scripts/lib/desktop-runtime/classifier-approval-controller.mjs
6bda44b75e3978704951210408a94727d2cb22e3d4d78c12c44aa74e371985c5  plugins/codex/scripts/lib/desktop-runtime/classifier-rework-gate.mjs
```

Rollback: inverse of only this owned patch. Preserve the denial ledger, all
earlier preparation trees, and newer canonical/staging changes. No canonical
source, runtime, alias, trust setting or deployed byte was changed in this turn.
