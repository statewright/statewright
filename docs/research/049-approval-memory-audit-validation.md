# Approval memory, audit and stream-contract validation

Date: 2026-11-09. Base: db69cb23503b33ba4bed4fff6a92ef86bb76a5a6.
Source preparation only in the existing Sidecar worktree. No workflow activation,
model calls, corpus-command execution, installation, deployment or flag changes.
Canonical source, its index, other worktrees and running owners were not modified.

## Implemented

Native classifier dialog durations once/2h/4h/8h/always, private durable grants,
expiry/revocation and restart/reconnect reuse, current policy/dependency/owner
checks, authenticated list/revoke helper and existing lifecycle telemetry path.
Reusable approval currently requires complete supported native dependency bounds
or declarative native web actions. Incomplete scripts still offer once. No global
command permission and no bypass of platform permission or workflow review.

Workflow metadata `meta.classifier_audit.mode: audit` is accepted only with trusted
server staging/dev/dev1/dev2/dev3 identity. A preexisting private directory in
`STATEWRIGHT_CLASSIFIER_AUDIT_DIR` is required. Uncertain holds persist bounded
structural cases before proceeding to host permissions. Known risk/explicit policy
denials remain enforced. Captures are unlabelled and excluded from accuracy rates.
The importer groups duplicate evidence but retains artifact observations. Raw
commands must be separately sanitized/reviewed before complete command replay.

Bounded literal sort/diff/sed contracts and invariant observer contracts compose
with every AST child. In-place/script-file/external-program options, dynamic
programs and unknown semantics stay unresolved. Sort keeps a Read|Write ceiling.

## Executed verification

All logs below are under `/Volumes/sidecar/build-tmp/` and are local-only evidence.

| Check | Result | Receipt |
|---|---|---|
| Gateway full library suite | 525 passed, 8 ignored | statewright-approval-audit-stream-full-20261109-v1.log |
| Gateway metering build check, offline | passed with warnings | statewright-approval-audit-metering-check-20261109-v1.log |
| Native memory/controller/proxy/service/interaction | 75 passed | statewright-approval-memory-affected-20261109-v4.log |
| Approval pipeline | 7 passed | statewright-approval-pipeline-20261109-v1.log |
| Audit importer | 3 passed | direct native test output; no retained log |
| Runtime source synchronization check | passed | sync-desktop-runtime.mjs --check |
| Hook and packaged helper syntax | passed | bash -n; node --check |
| Whitespace check | passed | git diff --check |

Gateway tests include audit revocation during assessment, state ABA during record,
session replacement, persistence failure, production rejection and explicit-policy
denial. Memory tests include exact expiry, revoke during state reread, corruption,
dependency/policy/owner changes, reconnect, duplicate replies and dead lock owners.
Proxy tests exercise the real local request/controller/store path with simulated
AppServer transport, not an installed TUI or a live human/native approval dialog.

Earlier failures are retained: proxy v1 missing ws dependency (resolved using the
existing lockfile with offline npm ci --ignore-scripts), memory Rust v2 missing
test import, audit v1 private-field test access. These were setup/compiler failures,
not permission denials, and are not relabelled as passes. No broad full executor,
whole workspace, installed native UI or staging suite was run in this slice.

## Frozen offline source-capability replay

Same frozen case bytes and labels; AST runtime flags remain false. Replay is a
source-capability projection, not a deployed rejection-rate measurement. It does
not invoke commands, Laya, hosted inference, or approval memory.

| Corpus | Permitted | Previous pass | Current pass | Current held | Forbidden admitted | Unknown admitted |
|---|---:|---:|---:|---:|---:|---:|
| Public | 115 | 40 | 53 | 62 | 0/11 | 0/8 |
| Sanitized local history | 154 | 57 | 59 | 95 | 0/13 | 0/63 |
| Combined | 269 | 97 | 112 | 157 | 0/24 | 0/71 |

Automatic passage rose 36.1% -> 41.6%; unnecessary holds 63.9% -> 58.4%.
15 additional permitted cases recovered. The >=135/269 (50.2%) initial gate is
NOT met: 23 further recoveries are needed. Zero observed admissions in these small
negative samples does not establish a general sub-1% unsafe-escape rate.

New immutable replay receipts:

- `/Volumes/sidecar/statewright-model-eval-20261105/effect-evidence-public-replay-20261109-v10.json`
- `/Volumes/sidecar/statewright-history-corpus-20261108-v5/effect-evidence-replay-20261109-v9.json`

Each receipt embeds frozen case and compiled classification-source hashes. Raw
private argv are not copied here. Deterministic improvement must continue through
missing operation/dependency contracts, not arbitrary utility allowlisting.

## Review and remaining gates

Independent memory review closed incomplete-provenance eligibility, expiry/revoke
release race and crash-lock findings after repair. Independent audit review closed
stale/ABA/replaced authority, false host-approval evidence and dedup findings.
Those reviewers inspected source; their reports are not independent test execution.
The bounded independent stream review found no must-fix; it confirmed retained AST
children and conservative option/grammar boundaries, but did not prove the
existing trusted-bare-utility executable-identity assumption.

Installed TUI/Desktop duration UX, live server telemetry delivery, durable server
capture deployment/retention and staging integration are still unverified. No
permission to change environments or release is inferred. Keep the classifier
gated until the measured target and required native/staging acceptance pass.
Rollback: revert the scoped source commits; revoke local grants through the helper
if desired. Changed workflow/dependency policy invalidates grant reuse.
