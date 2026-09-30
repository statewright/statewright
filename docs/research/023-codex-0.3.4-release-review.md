# Codex 0.3.4 pre-release review

Date: 2026-09-27. Statewright integration branch:
`release/codex-0.3.4-prep`. Reviewed source head before documentation:
`8a9ae590ef918e8b35842e898929dc537b7ae00e`. Companion Auldwyrm integration
head: `acdbb8b7901c797ab90e8d96942200f5d9fd8b35`.

## Verdict

Conditionally ready for native Desktop acceptance. No remaining critical,
high, or medium product defect was found in the reviewed classifier, OAuth,
managed-route, or historical-thread adoption changes. The release is not yet
approved for tagging or publication because the user-owned native Desktop
witness and exact-commit hosted gates remain outstanding.

## Reviewed boundaries

- Shell AST classification, typed System One fallthrough, and downstream
  capability enforcement.
- OAuth discovery, PKCE authorization-code exchange, resource binding, token
  rotation, replay rejection, revocation, and device credential provisioning.
- Managed Codex route continuity across successive stable-name receipts.
- Historical Desktop thread adoption and same-root ownership transfer.
- Generated plugin bundles, release task entrypoints, formatter state, and
  release-facing documentation.

## Findings repaired during review

The first `task test:plugin-release` stopped before its test corpus because the
Claude packaged managed-client bundle was stale relative to the shared
executor source. That drift could have shipped different behavior across host
plugins even though the canonical implementation was correct.

The canonical generator was run, its check now passes, and the generated
repair is isolated in Statewright commit `8a9ae59` (`chore(claude): sync managed
client bundle`). No source behavior was weakened to make the gate pass.

The next full release-gate run reached its public-source scrub and exposed
private staging infrastructure embedded in the Desktop setup profile, canary
default, and public receipts. The clean base already had four violations, and
the integration receipts added four more. Rather than allowlist or obscure the
private host, the repair makes staging Desktop setup require an explicit
`--gateway-url`, uses the existing portable model identity in the local
canary, and keeps private hostnames out of public receipts. Production Desktop
setup remains unchanged. The focused Desktop suite passed 18/18, the scrub
passed, and the repair is isolated in `0169131` (`fix(release): keep private
infrastructure out of plugin source`).

## Fresh local evidence

- `cargo fmt --all -- --check` passed in both integration worktrees.
- Statewright `cargo test --workspace` passed; the gateway suite reported 310
  passed, zero failed, and one ignored, with all remaining workspace tests and
  doctests completing without failure.
- Auldwyrm PocketBase OAuth and account-cleanup tests passed 12/12.
- Auldwyrm OAuth authorization UI tests passed 3/3.
- Auldwyrm `cargo test -p statewright-mcp-gateway` passed 170/170.
- Auldwyrm `cargo test -p statewright-studio` completed without failures; the
  package currently defines no Rust unit tests.
- Generated Claude and Codex managed-client synchronization checks passed.
- `task test:plugin-release` passed across executor, Codex, Claude, Cursor, Pi,
  OpenCode, OMX, shell contracts, local route canaries, and synchronization
  checks. Networked production-canary cases remained intentionally skipped.
- `git diff --check` passed before the formatter and generated-bundle commits
  and after the final release-hygiene repair.

The Auldwyrm repository-wide Rust test is an inherited baseline non-pass, not
an OAuth regression: `statewright-operator` cannot compile because its tracked
`crates/operator/src/crds.rs` does not define the CRD types referenced by the
reconciler. The OAuth branch does not introduce those types or modify that
boundary except for formatter-only whitespace. The focused gateway and Studio
package results above passed.

## Inherited evidence, not rerun here

The deployed staging receipt records successful desktop and mobile Playwright
OAuth lifecycles and a 10/10 authenticated shell-AST authority canary. Those
checks attest the previously deployed immutable staging digests, not this
local integration head. Production was untouched.

## Residual gates

Native Desktop must still prove that a fresh installed client can select and
resume a same-root historical conversation not originally started through
Statewright, then submit a subsequent turn. Until that succeeds, version
metadata remains at 0.3.3 and no 0.3.4 tag or publication should occur.

That native acceptance covers Codex App Server history only. Before release,
the staging remote MCP endpoint must also be registered as a ChatGPT plugin and
complete OAuth plus a direct Statewright tool call in an ordinary ChatGPT
conversation that originated on mobile. Opening a cloud ChatGPT conversation
inside the wrapped Desktop process does not attach the local Codex MCP server.

After acceptance, update release metadata, rerun exact-commit hosted CI and
plugin canaries, and require clean Statewright and Auldwyrm integration trees
before any tag or push. The current work did not push, tag, publish, deploy to
production, or restart an active Desktop session.
