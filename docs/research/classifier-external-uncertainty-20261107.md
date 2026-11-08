# External effect uncertainty

The classifier previously mapped every generic HTTP client invocation to a
known high-risk network effect. A staging health request was denied before
execution with `effective_known_risk` and no separate approval. That receipt
is retained in the denial ledger; the command was not replayed.

This candidate represents unresolved external effects separately from known
restricted effects. The external location remains visible and an unresolved
effect requires native review; it never becomes a read-only proof. Recognized
uploads, writes, configuration, credential and remote-execution effects keep
their stronger treatment. A wget invocation retains a local Write capability.
Explicit external-capability restrictions still apply before approval.

The local assessor receives bounded, code-owned per-invocation effect and
option categories, with incomplete markers. Operand and option values are not
included. Hosted providers retain the existing redacted input. Laya remains
evaluation-only; neither these categories nor documentation grant authority.

Base: `1b31772eecf4f99966270cfe34346bed8a6c4dfc`, prepared in a Sidecar
worktree. Staging's newer history-recovery commits require reconciliation
before any delivery. The focused baseline was red (High instead of Moderate).
An intermediate gateway suite had eight expected old-classification failures;
the revised suite passed 460 tests with seven ignored before the final
additional adversarial cases. The final prepared candidate passed the focused
external-effect Rust test and the gateway library suite (460 passed, seven
ignored). Executor controller and rework fixtures passed 15 tests, including
the uncertainty reason, prompt text, exact-invocation binding and ineligible
receipts. The two new reason-compatibility tests failed before the fix. The
proxy fixture could not start because the clean worktree lacks `ws`; installed
native review has not been tested. A full test request with an explicit shared
target did not return and was stopped; the subsequent Sidecar build passed.

The Codex generated approval modules were synchronized with the executor
sources. The direct `sync-desktop-runtime.mjs --check` invocation was denied
before execution after an earlier approval was aborted. The subsequently run
desktop bundle test passed, but calls the same drift function indirectly;
it must not be treated as a substitute for the denied check. The direct
denial is retained in the classifier ledger. The two executor suites passed
15 tests on the final preparation worktree. Its Rust diff matches the prior
worktree where the 460-test gateway suite ran.

Rollback is the inverse of the owned patch, retaining the denial ledger and
newer staging history. No plugin, workflow definition, staging deployment,
classifier authority flag, or production configuration was changed here.
