# MCP tool-intent repair receipt — 2026-09-27

## Scope and ownership

User requested repair of false MCP denials and explicitly deactivated Statewright
until fixed. The native deactivate call succeeded. No workflow was reactivated,
no Google Tasks/messages were changed, and no production deployment occurred.

Implementation branch: `fix/mcp-tool-intent`, isolated worktree
`.agent-worktrees/mcp-tool-intent`, base `11ac021`.
Main remained at `64c37a4` with the pre-existing untracked `package-lock.json`
preserved. Prerequisites are the four commits on `fix/semantic-risk-fallthrough`
through `11ac021`; these are not yet integrated into main.

The source change and decisions are recorded in [ADR 015](../adr/015-mcp-intent-and-explicit-authorization.md).

## Executed evidence (this repair, not inherited)

- Added a real hook subprocess regression before implementation. It reproduced
  the exact `list_task_lists` opaque-mutation denial despite exact phase permission.
- A new MCP intent regression failed before implementation because a server
  namespace containing `delete` incorrectly raised a list operation to High.
- Final `/Users/ben/.cargo/bin/cargo test -p statewright-mcp-gateway --quiet`:
  **274 passed, 0 failed, 1 ignored**; binary and doc-test targets had zero tests.
  Existing unused-variable/dead-code warnings remain; no warning-free claim.
- `task test:tool-policy`: passed Codex shell policy tests, all **10** Node
  hook/bridge tests, Claude shell discernment tests, shell syntax checks, and
  `git diff --check`. Harmless existing locale warnings appeared.
- Provider verification uses a local HTTP fixture implementing the typed
  System One response, not a live Jev call or model-quality evaluation. It
  demonstrates that a redacted MCP selector shape reaches the provider and
  an opaque read resolves through the existing authoritative fallback.
- Regressions cover exact allow/deny identity and punctuation collisions,
  embedded namespace separators, negative annotations, mutation selectors,
  hidden execution payloads, privacy sentinels, disabled/failing inference,
  dispatch-bound metadata, conflicting descriptors, and read-only exploratory
  enforcement through both adapter and direct gateway calls.

During development, strengthened invocation checks exposed existing assumptions
about native aliases. Reserved filesystem adapters retain their established
read/write semantics; the Grep telemetry assertion now expects Low/native_read.
No provider-specific allowlist or shell-command exception was added.

## Independent review

Fresh-context read-only reviewer `/root/mcp_intent_review` found namespace
truncation, deny-identity collision, a closed-world/locality confusion,
dispatch metadata ambiguity, and exploratory invocation-effect bypasses.
All were corrected before the final test run. Final reviewer verdict:
**no remaining blocking findings**. Its earlier stale-library probes were
explicitly withdrawn and are not counted as final validation evidence.

## Remaining work and rollback

This is a local source milestone, not an installed/runtime fix. No live model
calibration, hosted gateway rollout, plugin reinstall, or approved-task canary
was performed. The installed plugin and marketplace source were not changed.

Next: integrate and deploy the gateway and reinstall the plugin from one
reviewed SHA, verify actual MCP tool identities/metadata and semantic provider
availability, then run isolated allow/deny/timeout canaries. Keep Statewright
deactivated meanwhile. Remote/account mutation authorization remains distinct
from inference; do not use a read probability to manufacture consent.

Rollback with a normal revert of this repair, retaining fail-closed inference
and the user's deactivated workflow. Do not reset unrelated trees or reintroduce
shell grep exceptions. The repair worktree must be clean after its commit.
