# Classifier family repair

## Run contract

- Objective: replace command-by-command classifier repairs with one shared,
  provenance-aware intent contract; restore the already-reviewed Bash AST and
  OAuth resource-binding lineage; make denials explain the failed decision
  axis; and prevent another incomplete staging promotion.
- Repository: `/Users/ben/dev/statewright`
- Worktree: `.agent-worktrees/classifier-family-repair`
- Branch: `fix/classifier-family-repair`
- Base: `fff2cd25c7665cfdd019539c23ee010541702824`
- Reconciled supervisor commits: `f92ca57`, `0360744`, `e5f8add`
- Deployment boundary: staging only after committed validation and independent
  review. Production and remote push are excluded.
- Statewright is intentionally inactive because its classifier is the repair
  target and the current staging build has produced false denials. Limits below
  are observed/self-enforced for this run.

## Characterized failures

The live staging preflight matrix on 2026-09-27 showed:

- canonical `apply_patch` is `Moderate/Local` and admitted in `implement`;
- lowercase `write`, `edit`, and `multiedit`, `StrReplace`, and namespaced
  `functions.apply_patch` become `Moderate/Unknown` and are denied;
- `git status --short`, a conditional read, and `mkdir -p` become
  `Moderate/Unknown`, while one hand-recognized compound read and an output
  redirect are admitted;
- all calls reported semantic status `Assessed`, proving that provider
  availability alone does not close the structural-evidence gap.

The deployed `v66` source is descended from the supervisor-only branch and
does not contain the prerelease Bash AST or OAuth resource-binding commits.
The earlier staging AST receipt records a successful ten-case authority canary,
so this was a lineage/promotion regression rather than missing prior work.

## Milestones

1. **Lineage repair**: build on `release/codex-0.3.4-prep` and carry the three
   supervisor presentation commits. Preserve both AST/OAuth behavior and
   transition-output squelching.
2. **Canonical intent**: introduce one native tool-family resolver used by
   enforcement and risk assessment. Normalize case and explicitly supported
   adapter aliases without granting local authority to same-named upstream MCP
   tools. Add cross-adapter alias tests.
3. **Actionable denials**: emit a redacted structured decision receipt with the
   failed axis, selected effect, deterministic bands/source, semantic status
   and bounded vector, required capability or approval class, and retryability.
   Keep raw arguments, paths, payloads, and command text excluded.
4. **Workflow policy**: add schema-validated workflow/state classifier policy
   metadata for bounded risk tolerance. The policy may tune uncertainty and
   local-write handling, but may not silently authorize destructive, external,
   irreversible, or account effects.
5. **Regression gate**: add a matrix spanning host aliases, simple/compound
   shell syntax, substitutions, nested shells, heredoc consumers, delegated
   commands, effects, workflow capabilities, and semantic-provider outcomes.
   Add a deployment assertion for exact source revision and required classifier
   features.
6. **Validation and review**: focused tests first, affected gateway/plugin
   suites second, formatting/diff checks, then one independent non-editing
   adversarial review. Repair findings receive focused revalidation and a fresh
   bounded review.
7. **Staging**: commit locally, build one immutable image from the reviewed
   commit, verify annotations/digest/config, run OAuth and classifier canaries,
   and retain the preceding digest as rollback. Do not touch production.

## Budget and contraction

| Phase | Normal / hard tool calls | Normal / hard output | Wall limit | Contraction |
| --- | ---: | ---: | ---: | --- |
| Implement | 20 / 35 | 80 / 140 KiB | 60 min | Stop adapter breadth; finish shared resolver and focused tests only. |
| Validate | 8 / 14 | 60 / 100 KiB | 30 min | Skip redundant suites, never required focused/security gates. |
| Review/repair | 4 / 8 | 32 / 64 KiB | 20 min | Return cited finding packet; no repository rediscovery. |
| Staging | 8 / 14 | 48 / 80 KiB | 30 min | Roll back/stop on source, digest, OAuth, or classifier mismatch. |

Reserve: one focused repair/revalidation cycle, one staging rollback, and the
final evidence handoff. No speculative refactor, production work, or unrelated
0.3.4 cleanup may consume that reserve.

## Acceptance criteria

- One shared native tool identity contract feeds enforcement and risk.
- The previously failing alias and shell cases have explicit regression tests.
- AST authority remains monotonic and all existing focused AST tests pass.
- System One denial output identifies the failed axis without leaking inputs.
- Workflow risk metadata validates and cannot weaken known high-risk effects.
- Exact reviewed source SHA is the only staging artifact accepted by canaries.
- The milestone is locally committed and both owned worktrees are clean.

## Implementation evidence

- One provenance-aware native tool resolver now supplies both adapter
  authorization and deterministic risk assessment. Supported native aliases
  are case-insensitive, while registered upstream MCP tools retain exact
  identity even when their names collide with `apply_patch` or another native
  alias.
- Shell AST authority again covers compound syntax. Plain `git status --short`
  is a proven read, and `mkdir -p` is a deterministic bounded local write.
- Workflow and state definitions accept `classifier_policy.risk_tolerance` with
  `low_local`, `moderate_local`, and `assessed_moderate_local`. State policy
  overrides workflow policy, and none of the values can downgrade a known
  destructive, external, irreversible, account, high, or critical effect.
- Denial receipts now separate classifier resolution from the final policy
  outcome with `resolution_basis`, `final_denial_basis`, final
  `required_authority`, the bounded System One vector, and accurate equivalent
  retry guidance.
- The Codex hook renders only those bounded receipt fields into the visible
  denial reason. Its fixture includes private command/input sentinels and proves
  they are not projected.
- ADR 018 records the authorization, privacy, rollout, and rollback decisions.
  Arbitrary Taskfile target resolution remains a deliberate follow-up because a
  target name does not prove the recipe's effects.

## Validation evidence

Checks executed successfully in this worktree:

- `cargo fmt --all` and `git diff --check`;
- `cargo test --workspace` before the final origin hardening;
- `cargo test -p statewright-engine`: 90 passed;
- final `cargo test -p statewright-mcp-gateway`: 317 passed, 0 failed, 1
  ignored;
- focused registered-alias allowlist, classifier-policy, native-alias, AST,
  final-denial, and checkpoint regressions;
- `node --test plugins/codex/tests/executor-bridge.test.mjs`: 10 passed;
- `npm test` in `plugins/pi`: 356 passed, 1 production canary skipped;
- supervisor transition-presentation tests: 10 passed;
- `task test:plugin-release` passed before the terminology migration after
  lockfile-pinned plugin dependencies were installed in the fresh worktree. A
  post-migration rerun exposed one unrelated Desktop setup concurrency failure;
  its complete focused file then passed 18/18. This intermittent gate result is
  retained as a release caveat rather than reported as green;
- shell and JavaScript syntax checks for the Codex hook and staging canary;
- a first-party terminology sweep replaced legacy inclusionary/exclusionary
  wording with allowlist/denylist wording; the old policy wire value remains accepted
  only as a deprecated input alias during migration. The affected gateway
  Bash-guard and executor approval-service tests passed.

The live staging canary passed against gateway `v67` (OCI digest
`sha256:9a1230350b74863a7913607b0dca9013c60ab4f745caf7fe3b78551c677a39a9`),
annotated to source `f8309e6ca76facc1e2190dfbec249bf4fb243cf8`. It provisioned
and revoked its credential through the OAuth device grant, exercised 12 shell
AST/System One cases and 10 native write aliases, and deleted its temporary
user. `mkdir` and a data-only heredoc redirect were admitted as assessed
moderate local writes; executable heredocs, external pushes, recursive delete,
malformed shell, and opaque execution were denied. No production deployment,
remote push, tag, or publication occurred.

## Independent adversarial review

The first read-only review found three substantive issues before deployment:

1. registered upstream aliases could inherit native write risk provenance;
2. the Codex hook discarded the structured classifier receipt;
3. structured `required_authority` described the intermediate effect instead
   of the final denial.

The repairs added typed origin and final-decision boundaries, adapter-level
collision coverage, and bounded frontend presentation. A second review found
the same origin marker also had to reach allowlist capability normalization;
that repair now preserves exact registered identity in pre-tool authorization
and post-tool accounting. The final bounded re-review approved all P0-P2
findings with none remaining. The reviewer did not run tests; the validation
above was executed independently in this run.

A terminology-migration re-review then found that accepting the deprecated
policy value without canonicalizing session projections would re-emit it to
adapters and caches. Session creation, checkpoint recovery, state updates, and
subflow boundaries now normalize the reserved value, while `get_state` also
canonicalizes defensively. A regression loads the deprecated input and proves
the projected and stored mode are both `denylist_heuristic_v1`.
The final bounded re-review approved this compatibility repair with no
remaining P0-P2 finding.
