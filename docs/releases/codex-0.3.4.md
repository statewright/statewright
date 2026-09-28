# Statewright Codex Plugin 0.3.4 (Draft)

Statewright Codex Plugin 0.3.4 is a classifier, onboarding, and managed Desktop
continuity release. These notes describe the reviewed release candidate; 0.3.4
has not been tagged or published.

## What changed

- Shell commands are parsed into bounded effects before enforcement. Compound
  reads can be admitted without teaching the policy every LLM-generated shell
  spelling, while hidden writes, executable heredocs, malformed input, and
  opaque effects remain conservative.
- Ambiguous effects can use the existing typed System One assessment path.
  Semantic evidence may resolve only bounded uncertainty; it cannot bypass the
  active workflow's capability boundary or override a proven risky effect.
- Native MCP calls now carry typed tool intent through the same enforcement
  boundary instead of depending on executable-name matching alone.
- Native editor aliases now share one provenance-aware intent resolver across
  enforcement and risk assessment. Supported case and adapter variants receive
  the same bounded local-write decision, while same-named upstream MCP tools
  remain remote and conservative.
- Workflow and state metadata may select a bounded classifier tolerance with
  `classifier_policy.risk_tolerance`. The setting can narrow local authority or
  admit the calibrated System One fallback, but cannot authorize known
  destructive, external, irreversible, account, or high-risk effects.
- Denials now report a redacted resolution basis, required authority, semantic
  status and probabilities, and equivalent-retry guidance so agents can
  reformulate on the failed axis without receiving raw command or payload
  contents.
- The MCP gateway binds OAuth access tokens to the exact protected resource.
  Authorization-code issuance uses PKCE S256, one-time codes, scoped expiring
  access tokens, refresh rotation, replay rejection, and revocation.
- Codex browser onboarding can provision a credential without asking the user
  to copy an API key. The current device flow still stores the returned bearer
  locally in `~/.statewright/api_key`; this is a migration away from manual key
  handling, not yet a credential-free internal transport.
- The managed App Server can adopt a user-selected, same-root historical
  Desktop thread through a short-lived, auditable ownership transfer. Native
  success is required before the transfer commits, and foreign-root or stale
  transfers fail closed.
- Managed Codex now consumes successive route receipts even though the
  controller atomically replaces the stable receipt filename. Queued
  non-blocking human questions and the historical-thread picker remain
  available through the shared Desktop/TUI shim.

## Safety boundary

The AST result can downgrade only a structurally proven low-risk local read.
Explicit command restrictions, blocked environment checks, write limits,
workflow capabilities, and approval requirements remain authoritative. Parse
errors, analysis limits, executable heredocs, unknown programs, and uncertain
effects stay on the conservative fallback path.

OAuth discovery and browser consent do not broaden token authority. The
gateway revalidates the bearer and its exact MCP resource on each request.
Production was not changed during development or staging validation.

Historical-thread adoption is limited to the same canonical checkout and one
managed client. It does not authorize cross-project attachment, replacing an
active writer, or bulk ownership changes.

Directory creation is classified as a deterministic bounded local write.
Delegated Taskfile targets remain unresolved unless their effect is known; a
target name alone is not evidence that the underlying recipe is local or safe.

## Release review status

The source review found no remaining critical, high, or medium product defect.
It repaired two release-hygiene defects: a stale generated Claude
managed-client bundle (`8a9ae59`) and private staging infrastructure embedded
in public plugin source (`0169131`). Staging Desktop setup now requires an
explicit `--gateway-url`; production behavior is unchanged.

The integration branches intentionally retain standalone formatter commits:

- Statewright `6ce64ba` — `style: format Rust workspace`;
- Auldwyrm `acdbb8b` — `style: format release workspace`.

Fresh local validation of the integrated source includes the Statewright Rust
workspace, focused OAuth hook and account-cleanup tests, the OAuth UI unit
test, formatter checks, plugin bundle synchronization, and the complete
`task test:plugin-release` gate. Details and the separate Auldwyrm baseline
limitation are recorded in the companion pre-release review receipt.

The prior staging OAuth lifecycle, mobile and desktop Playwright runs, and the
10-case shell-AST authority canary are inherited evidence from the exact
deployed source receipts. They were not independently rerun against this local
integration head.

## Remaining cut gates

Before tagging or publishing 0.3.4:

1. Complete native Desktop acceptance by resuming a same-root conversation
   that was not started with Statewright plus Codex.app, then send a subsequent
   turn successfully.
2. Confirm the release branch is clean and update the plugin version,
   capability table, and root release banner from 0.3.3 to the final 0.3.4
   build identity.
3. Run the exact-commit hosted CI and plugin canaries required by the release
   workflow.

No tag, push, publication, production deployment, or active-session restart is
authorized by this draft.
