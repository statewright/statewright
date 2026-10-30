# Repository execution contract repair — 2026-10-22

## Scope and evidence

Statewright workflow execution is intentionally inactive at the user's request.
No workflow, semantic feature flag, threshold, approval adapter or live runtime
is changed. The milestone is source repair and local validation, not deployment.
Use the existing `classifier-denial-audit-20261020` worktree, not another fork.
Base: `558e807212001b37571db0b01adbe7f98bc303eb`.

Canonical `0dff16e` lacks commits `484eeda` and `558e807`. The latter fixes Rust
validation shapes but deliberately leaves online Cargo validation unresolved.
Thus integration drift and a remaining contract inconsistency both exist.
Source inspection is not proof of which gateway binary a remote session loads.

The latest denied invocation is retained, not replayed:
`cargo check -p statewright-engine -p statewright-mcp-gateway`, in
`.agent-worktrees/workflow-adaptation-revisions`, invocation
`example-denied-invocation` (a public label; the original identifier is private).
The command is used in the new suite only as an inert string passed to
classification. No repository task represented
by a fixture is executed.

## Decision and security boundary

Use the existing shared repository-execution intent and explicit
`BoundedLocalExecution` capability consistently across recognized runners.
Cargo test/check/build no longer require an offline spelling to be recognized.
`--offline` and `--frozen` retain their argument semantics; unsupported flags,
runtime injection, escaping manifest/output paths, publish/install/run and
unknown plugins remain unresolved. No generic executable/name allowlist or
model confidence can grant this capability.

This deliberately expands the recognized Cargo entrypoints to ordinary online
build/test/check forms. It can permit dependency resolution from configured
registries **only when repository execution is already explicitly authorized**.
It is not a read-only classification or a claim of local-only runtime effects.
Offline mode never sandboxed build scripts, proc macros or test code; Node/npm
test entrypoints already expose the same repository-code execution boundary.
Enforcing no network or restricted filesystem effects inside repository code
requires an execution sandbox and is not implemented here. Independent native
permissions, explicit workflow denials and user scope remain mandatory.

The launcher grammar still preserves option/value bindings and rejects unknown
options. AST composition accumulates all leaves: a build cannot launder a
substitution, unknown command, explicit remote action or destructive companion.
Write and local Git companions retain their independent capabilities. A
read-only policy, Bash alone, Write alone, or absent execution capability cannot
authorize a recognized build. Explicit deny overrides explicit allow.

This is a shared-capability consistency correction plus integration of prior
reviewed families, **not universal command understanding**. Arbitrary engines
and delegated scripts still need trusted structural evidence or a separately
reviewed workflow adaptation. The unfinished adaptation/publication worktree
is preserved and excluded. The existing 100-record audit remains unadjudicated;
this work does not establish an overall false-positive rate.

## Validation ledger

- Red: `cargo test --offline -p statewright-mcp-gateway --lib repository_execution_contract`
  ran the new inert classifier regression: 0 passed, 1 failed. Exact observed
  mismatch was DenyUncertain versus BoundedLocalExecution for the Cargo check
  string above, with AST disabled.
- Green, same test filter after repair: 2 passed, 0 failed. Covers both AST
  enabled/disabled, six runner families, online/offline selection, wrappers,
  bindings, unknown/injected forms, effect composition, explicit allow/deny and
  read-only policy. Semantic authorization is disabled in the contract matrix.
- `cargo fmt --all` and `git diff --check`: passed.
- First full gateway library suite: 366 passed, 3 failed, 1 ignored. Failures
  were `cargo_test_is_passthrough`, `cargo_test_allowed_with_just_bash`, and
  `semantic_effect_resolution_requires_high_confidence_and_structural_evidence`.
  These asserted the superseded online-Cargo classification. The updated
  regressions require explicit execution authority even in legacy policy,
  prohibit read-only classification, and retain semantic abstention for custom
  Cargo plugins/configuration injection. No failed receipt is discarded.
- Independent bounded static review (`rust_classifier_review`): no actionable
  findings; explicitly noted network/filesystem sandbox and live-admission
  limitations. Final delta review of the three assertion repairs found no
  regression weakening. Reviewer did not execute tests or historical commands.
- Final `cargo test --offline -p statewright-mcp-gateway --lib --quiet`:
  **369 passed, 0 failed, 1 ignored**. Existing unused-variable warnings remain.
  These tests include local mock-provider services; S1 was not enabled in any
  live environment. `cargo fmt --all --check` and `git diff --check` passed.
- Live command admission, package/install/staging: not performed.

## Ownership, delivery and rollback

Canonical plugin/profile changes and all unfinished workflow-adaptation changes
are unrelated; do not stage, overwrite or include them. Local integration must
verify canonical preimages and that unrelated file bytes/staged changes remain
unchanged. Source integration must not be represented as installed repair.
No deployment or workflow reactivation is part of this milestone.

Pre-integration preservation receipts (SHA256):

- Canonical HEAD: `0dff16e8ea965b43f8fbd708a1b18055414a5d1b`.
- Canonical tracked plugin diff:
  `1e78270c160a69f1be21c54181441e5e798313ff6594249ce719b9e5e1dc8dc9`.
- Both canonical and adaptation staged diffs are empty (SHA256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).
- Canonical untracked `plugins/codex/gateway-profile.sh`:
  `6bf8e9291b5dfa82a632e06005a1d9b62b707d48d3757f86b14192f96d048852`.
- Canonical untracked `plugins/executor/lib/gateway-profile.mjs`:
  `6dddb82d9822120bea80485db637d3b4419a108ed588a4dd18546e49b7efa625`.
- Adaptation tracked diff:
  `a0b31c40061ba5801211792e8749863688b14cc2dcde9038532368536bdc0b08`.
- Adaptation untracked `command_profile.rs`:
  `e324936eeaaa46c3bf7bbc4eccc86880158fad1d3178a4267c4919bc67b2ee42`.
- Adaptation untracked `workflow_revision.rs`:
  `6f5d868182d3bf757dbb42b290266f314c477653a910b9ad2d7f2cfade5ea259`.

Intended source integration is fast-forward only with disjoint owned paths;
any changed preimage or overlap stops integration for reconciliation. This does
not validate or publish the unfinished adaptation code.

Rollback is an ordinary reviewed revert of the new contract commit; previous
audit/Rust-family fixes are separate ancestors. Do not reset a dirty checkout.
Budget: one characterized red, one focused green, one affected suite and one
bounded independent review; only discriminating failures justify further runs.
