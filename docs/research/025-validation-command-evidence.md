# Validation command evidence repair

## Contract

Canonical `/Users/ben/dev/statewright`, `main`, base `2498471b191c03cf6f04edd7e565204334d4a74e`; initial tree clean. The user explicitly authorized working without Statewright while repairing its classifier. The preceding run `e8bc067c-53d7-419a-a431-3e4e82d05f5f` ended blocked at design. No denied Nomad command is to be replayed before repaired admission. Production, credentials, approval-policy expansion, and Nomad edits are excluded.

Use the existing native adapter boundary to collect fresh local structural evidence, expand static Taskfile/package-script commands, verify project-local runner resolution, and classify every resulting execution unit. Never infer locality from task names. Never execute a manifest to inspect it. Unsupported dynamic configuration, cycles, paths outside the workspace, missing runners, malformed evidence, and untrusted tool provenance remain unresolved. The local OS account and managed plugin remain trusted, as with the existing Git closeout helper; this is not attestation against a malicious same-user process.

Evidence is bound to the original command and working directory, collected for each invocation, and consumed only by the native pre-tool path. It must not enter System One payloads or visible receipts. All ordinary capabilities and risk checks still apply. Existing known destructive/external effects must not be downgraded.

## Findings

- The prior shim-only `task test:unit` check did not exercise gateway classification.
- Nomad's `test:unit` wraps `npx vitest run {{.CLI_ARGS}}`.
- Nomad's global `VERSION` shell variable can create `.version`; global environment values reference it. A static task-body-only resolver would miss this effect.
- Nomad currently has `node_modules/.bin/vitest` and `node_modules/vitest/package.json`.
- ADR 018 explicitly deferred opaque Taskfile resolution pending manifest inspection.
- Prior local history counts identify task wrappers, npx runners, package scripts, Cargo options, and Python/Go/Make/Just wrappers as recurring families. Counts are frequency signals, not authority; raw history remains private and uncommitted.

## Validation and delivery

Test the collector with disposable local fixtures, the gateway with positive and adversarial evidence, and the packaged hook with captured requests. Then run the affected Rust and plugin suites and review the owned diff. Independent review is unavailable under the user's instruction not to spawn reviewers; do not claim independent approval. Preserve any failed checks. Full-tree staging and installed runtime verification remain distinct from source tests.

Normal budget: one implementation slice, focused tests, affected/full gates, one repair cycle, and handoff. Stop discovery once evidence boundaries are mapped; preserve remaining effort for regression and integration checks. No model changes or delegation.

## Implementation and validation

The implementation adds the local collector and mirrored Codex bundle, a pinned
YAML parser build, hook/executor transport, native gateway consumption, and AST
capability aggregation. It also covers offline Cargo workspace/test-selection
flags without permitting alternate manifests, target directories or config.

History-family disposition: static Task/npm/pnpm wrappers are inspected; Vitest
with verified local resolution is supported; Cargo workspace flags are covered;
network-capable npx/Playwright, opaque Go/Make/Just/UV/Python, unsupported runner
flags and dynamic manifest configuration stay unresolved. These are synthetic
family regressions; raw historical commands are not committed or executed.

Executed: focused collector/hook/adapter checks passed (27 tests after the final
PATH-provenance fixture), gateway evidence/capability checks passed,
and `cargo test --offline --workspace` passed (gateway 353 passed, one ignored).
The complete `task test:plugin-release` gate passed before the final PATH-only
tightening; the 27-test focused rerun covers that final change. The later Cargo
workspace-flag change passed its focused grammar test. Formatting, mirror
synchronization and `git diff --check` passed. A first YAML bundle attempt
failed on CommonJS dynamic require; using the dependency's browser ESM build
fixed that packaging defect. This failure is retained, not counted as a pass.

Parser source: https://eemeli.org/yaml/ (accessed 2026-10-02), `yaml@2.9.1` pinned
in the executor lockfile, bundled with pinned `esbuild@0.28.2` and upstream ISC
license. npm local-bin precedence was checked against the installed
`/opt/homebrew/lib/node_modules/npm/node_modules/libnpmexec/lib/index.js`.

Read-only collection against the actual Nomad checkout found complete local
evidence for the exact focused `npx vitest run` command (one execution unit,
three file hashes). `task test:unit` remains incomplete with
`task_global_effects_unresolved` (one manifest hash). Neither command was
executed. No live admission success is claimed from static collection.

Final review also closed a PATH-provenance gap: bare Vitest can resolve to the
verified local runner only inside package scripts, not directly from a shell
or Taskfile. Missing/ambiguous package configuration remains unresolved.

Source candidate bundle: `0.3.4+codex.20261002033943`. Local commit and
installed/staging provenance are pending. No new staging pass claimed.
