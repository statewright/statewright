# Rust classifier repair: death-rebirth:8.1

## Evidence and ownership

Read-only pane inspection identified `%9`, cwd `/Users/ben/dev/harbringer`.
Its durable thread is `01a02bb3-832b-7443-acb5-69ef156bc18a`, at
`/Users/ben/.codex/sessions/2026/08/22/rollout-2026-08-22T18-59-39-01a02bb3-832b-7443-acb5-69ef156bc18a.jsonl`.
These October 20 incidents postdate the original 100-command audit cutoff.
No historical command was executed by this investigation.

Relevant original JSONL records (UTC):

| Line | Time | Recorded result |
| --- | --- | --- |
| 60863 | 14:29:14.819 | `/Users/ben/.cargo/bin/cargo test -p harbringer-core -p harbringer-cli` denied before execution |
| 60972 | 14:36:14.745 | `cargo test --manifest-path crates/harbringer-core/Cargo.toml --lib` denied; human-approval request could not complete |
| 61103 | 14:44:56.463 | `cargo fmt --all` denied before execution |
| 61116 | 14:45:18.889 | absolute `.cargo/bin/rustfmt --edition 2024 ...` denied |
| 61127 | 14:45:39.639 | manifest-selected focused Cargo test denied |
| 61150 | 14:46:37.359 | `command -v cargo-nextest` denied |
| 61174 | 14:47:06.417 | manifest-selected `cargo check --tests` denied |
| 61208 | 17:50:55.028 | Cargo actually ran after user-directed skip; vendored crate bound to outer workspace and formatting failed |
| 61373 | 17:55:53.365 | Other owner recorded eight focused tests passing after relocating its worktree |

The classifier denials say
`complete_structural_evidence_or_separate_approval`.
At line 60972 the exact additional message is:
“Statewright could not complete its human-approval request. Reconnect or update
the plugin; the invocation remains denied.”
This is evidence of an approval failure, not proof of its internal cause.

Harbringer's owner independently moved its nested worktree to
`/Users/ben/dev/harbringer-hackmaster-adaptation` and continued validation.
Those are inherited results, not checks performed by this repair.
No Harbringer files, processes, or sessions were mutated here.

## Root causes and repair

The old Cargo adapter recognized only `test --offline` with a narrow argument
set. It did not understand manifest selection, check/build modes, feature
arguments, or the Cargo/test-binary `--` boundary. Formatting had no typed
classification. Separately, `command -v` was rejected by execution-wrapper
normalization before its existing read-only lookup rule could help AST policy.

This patch keeps classification separate from authorization:

- Literal shell `command -v NAME...` is a lookup, not execution of NAME.
  Shell expansion, substitutions, redirects and compound companions are still
  classified separately; the complete command cannot inherit lookup authority.
- Bare `rustfmt` with literal relative Rust paths is Write; `--check` is Read.
  Edition selection is bounded; configuration/output overrides stay unresolved.
- Bare `cargo fmt`, including check mode, requires **BoundedLocalExecution**.
  Cargo aliases can redirect an external subcommand, so its name and `--check`
  are **not** proof of read-only behavior. Read-only and Write-only states cannot
  authorize this entrypoint. Explicit execution denial still wins.
- Cargo `test`, `check`, and `build` share option/value handling. The existing
  offline requirement remains (`--frozen` also implies offline). Relative
  `Cargo.toml` selection, package/target/feature selectors and bounded test
  runner options are recognized without dropping their argument bindings.
- Compiler/formatter injection variables are rejected during normalization. No threshold,
  workflow, S1, hook approval, or deployment settings change.
- New formatter classifications require bare executable spelling. An arbitrary
  path ending in `/.cargo/bin/rustfmt` or `/.cargo/bin/cargo` proves nothing
  about executable identity. The existing Cargo validation-path behavior is
  unchanged, not newly certified.

The execution capability has the existing ADR 018 trust boundary: it authorizes
repository-code execution, **not** a filesystem/network sandbox. Cargo's offline
flag constrains dependency resolution; it cannot prevent a test/build script
from using the network. Cargo configuration and source imports are not audited
by this argv classifier. This patch does not make such a claim.

Primary contract references:
[Cargo test](https://doc.rust-lang.org/cargo/commands/cargo-test.html),
[Cargo aliases/configuration](https://doc.rust-lang.org/cargo/reference/config.html#alias),
[Rustfmt](https://github.com/rust-lang/rustfmt/blob/main/README.md),
and [ADR 018](../adr/018-classifier-intent-and-risk-policy.md).

## Validation and limits

Regression tests treat recorded commands as inert strings; they do not run
Harbringer, historical denied commands, or attacker payloads.

Red evidence:

- The new Rust-family test initially failed: `cargo fmt --all` was Passthrough.
- The lookup pipeline test initially failed: `command -v cargo-nextest` resolved
  DenyUncertain instead of ReadOnly.

Coverage includes paired formatting/check modes, option/value and `--` boundary
handling, manifest traversal, spoofed executable paths, runtime injection,
unsupported config/output/installation/publish operations, missing values,
offline versus online execution, composed writes/destruction/network, and
explicit capability allow/deny precedence with semantic assessment disabled.

Review found and removed two unsafe draft assumptions: absolute suffix-based
formatter trust, and treating Cargo fmt check mode as read-only. The final
execution-capability design was independently reviewed against ADR 018.

Final executed check:
`cargo test --offline -p statewright-mcp-gateway --lib`
completed with **368 passed, 0 failed, 1 ignored**. This includes classifier,
AST, risk-pipeline and capability-enforcement tests. Existing unused-variable
compiler warnings remain; the ignored test is not claimed as passed. The
semantic provider tests use their existing local mock services, not an
enablement of S1 in the live environment.

Remaining issues are explicit:

- The exact online Cargo test/check invocations in the incident still need the
  existing approval path or additional trusted effect evidence. They are not
  silently relabeled offline, and no denied invocation was reformulated/replayed.
- Absolute formatter launchers still need executable identity evidence.
- The human-approval transport failure is not fixed by this classifier patch.
- Other corpus families, including the denied `ps` pipeline, are separate work.
- This is a source/test candidate only, not an installed or deployed fix.

Canonical Statewright plugin edits and the active Harbringer owner remain
untouched. No workflow was activated for this repair.
