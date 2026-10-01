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

The earlier mobile and desktop Playwright runs remain inherited evidence from
their exact deployed source receipts. This review independently reran the
staging OAuth device-grant and classifier path against gateway `v67`: all 12
shell-AST/System One cases and 10 native write aliases passed, including
bounded local directory creation and data-only heredoc writes. The temporary
credential was revoked and the temporary user deleted. Production was not
changed.

## Included follow-ups

- `034-README-PRICING` — The README Pro offer now shows the struck-through
  $19 list price, the active $9/mo Early Bird price, and that the $9 price stays
  locked while the subscription remains active. This is a next-release
  documentation change; it does not change the live pricing site.
- `034-NONINTERACTIVE-AUTH` — The generic Codex MCP proxy no longer opens a
  browser after an `invalid_api_key` response. Keep the explicit
  `statewright_connect` device-approval path and fail-closed key handling. The
  focused auth regression covers the noninteractive failure path. The explicit
  OAuth command remains the only browser-opening path.
- `034-LOCAL-OWNERSHIP-RECONCILIATION` — Cloud connector calls cannot claim
  local hook ownership. Authoritative local inactivity clears only the affected
  local binding, while transport failures remain fail closed and stale Stop
  cache data cannot continue a workflow.
- `034-BOUNDED-NODE-PATTERN` — A literal `node --test
  --test-name-pattern=<nonempty literal> <bounded *.test.mjs paths>` invocation
  receives bounded-local-execution authority. Absolute and parent paths,
  unsupported Node flags, watch/loaders/eval, redirection, substitution,
  chaining, and network effects remain denied.

## Remaining cut gates

Before tagging or publishing 0.3.4:

1. Complete native Desktop acceptance by resuming a same-root conversation
   that was not started with Statewright plus Codex.app, then send a subsequent
   turn successfully.
2. Complete ChatGPT plugin acceptance independently of the Codex App Server
   launcher: register the staging HTTPS `/mcp` endpoint in ChatGPT, complete
   OAuth, open an ordinary ChatGPT conversation that originated on mobile, and
   prove that a direct Statewright tool call succeeds. Merely opening the cloud
   conversation in ChatGPT + Statewright is not evidence that the local Codex
   plugin was attached.
3. Confirm the full-tree staging candidate is clean and that its plugin
   version, capability table, root release banner, and packaged build identity
   all agree on 0.3.4.
4. Run the exact-commit hosted CI and plugin canaries required by the release
   workflow.

No tag, publication, or production deployment is authorized by this draft.
