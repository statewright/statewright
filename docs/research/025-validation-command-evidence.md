# Validation command evidence repair

## Contract

Canonical `<statewright-checkout>`, `main`, base `2498471b191c03cf6f04edd7e565204334d4a74e`; initial tree clean. The user explicitly authorized working without Statewright while repairing its classifier. A preceding run ended blocked at design. No denied command is to be replayed before repaired admission. Production, credentials, approval-policy expansion, and other-project edits are excluded.

Use the existing native adapter boundary to collect fresh local structural evidence, expand static Taskfile/package-script commands, verify project-local runner resolution, and classify every resulting execution unit. Never infer locality from task names. Never execute a manifest to inspect it. Unsupported dynamic configuration, cycles, paths outside the workspace, missing runners, malformed evidence, and untrusted tool provenance remain unresolved. The local OS account and managed plugin remain trusted, as with the existing Git closeout helper; this is not attestation against a malicious same-user process.

Evidence is bound to the original command and working directory, collected for each invocation, and consumed only by the native pre-tool path. It must not enter System One payloads or visible receipts. All ordinary capabilities and risk checks still apply. Existing known destructive/external effects must not be downgraded.

## Findings

- The prior shim-only `task test:unit` check did not exercise gateway classification.
- Regression fixtures cover task wrappers around package-script commands.
- Task-global shell/environment evaluation can add effects absent from the
  task body; a static task-body-only resolver must leave those cases unresolved.
- Verified project-local runner resolution is required.
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

Read-only collection against a project checkout (name omitted) found complete local
evidence for the exact focused `npx vitest run` command (one execution unit,
three file hashes). `task test:unit` remains incomplete with
`task_global_effects_unresolved` (one manifest hash). Neither command was
executed. No live admission success is claimed from static collection.

Final review also closed a PATH-provenance gap: bare Vitest can resolve to the
verified local runner only inside package scripts, not directly from a shell
or Taskfile. Missing/ambiguous package configuration remains unresolved.

## Candidate and installation receipt

Implementation commit: `f04e96a` on canonical `main`. Candidate bundle:
`0.3.4+codex.20261002033943`. At 2026-10-02T03:39Z onward, the supported
`codex plugin add statewright@personal --json` control returned success for
that version. Its source is the existing personal marketplace entry pointing
to `<statewright-checkout>/plugins/codex`. No credentials were supplied or
printed, no OAuth flow was invoked, and no resident process was restarted.

Independent SHA-256 calculation confirmed source and installed-cache matches:

| File | SHA-256 |
| --- | --- |
| `hook.sh` | `d162c9abdc443de2b930e3f69745d1c2c2d6f9ad237f54fc77eeffba40e7efbb` |
| `scripts/lib/command-evidence.mjs` | `1173275900a52b0be3593bb31071b55e6982be7a45c81d6f6f6641060f98dd05` |
| `scripts/lib/command-yaml.generated.mjs` | `6bc9d43f5435c853da3903224dfb67fa6557d1d0c74a796265a796e6cdd6102c` |

`cargo build --offline --release -p statewright-mcp-gateway` passed. Local
`target/release/statewright-gateway` SHA-256 is
`4a38297ed00f62d3ae60eca5fd7bbecbe2b034a520ae64346dc9e569ffc7895e`.
Existing unused-variable/dead-code warnings remain; no unrelated cleanup.
Local plugin archive `dist/statewright-codex-0.3.4-rc.f04e96a.zip` was generated
directly from the committed plugin subtree; SHA-256:
`fe9cf924e0aef61e36b3948b7929590677056d12a93d0be6a381e102b7b29934`.
The first shasum attempt failed due to the inherited invalid locale; the same
command succeeded with `LC_ALL=C`. This was not a policy denial.

The cache is shared with Desktop, but installation does not prove that an
already-running App Server loaded these bytes. Source/install evidence is not
staging acceptance or authority to interrupt unrelated sessions.
