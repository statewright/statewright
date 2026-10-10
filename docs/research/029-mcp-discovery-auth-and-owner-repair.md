# MCP discovery, authentication recovery and server ownership repair

## Contract

User requested one repair covering endpoint/error handling, OAuth recovery and multiple server/proxy isolation. Source-only preparation in the existing clean `staging/full-tree-source` checkout, base `655edeb`. Canonical dirty checkout, installed packages, active processes, credentials, native trust, classifier and workflow policy are excluded. No new launcher, workflow or worktree.

Native Statewright tools are unavailable in the current host. The explicit repair is not orchestrated by Statewright and must not be represented as a workflow run. Existing policy denials are not retried. Current model retained. No concurrent writers/reviewers spawned. Independent review and installed-host acceptance remain separate gates.

Observed baseline: current daemon inherited a dead loopback MCP bridge. Its native status reports startup failed with `-2 Gateway unreachable`. Same configured credential returns 200/12 tools at `/mcp`, 404 at `/mcp/`. Canonical URL resolution and shell suffix concatenation conflict. HTTP errors are collapsed by curl `-f`. Cross-server workflow/credential misrouting has NOT been observed.

## Decision and invariants

- Use the canonical gateway endpoint unchanged. Classify authentication, permission, HTTP/service, transport and protocol failures distinctly; never echo upstream credential-bearing bodies.
- Discovery and explicit local connection/docs remain possible after faults. OAuth is explicit, bound to the configured gateway/auth service, never an automatic browser loop. Never retry a protected call or write after login. Rejected explicit environment credentials must not silently yield precedence to another profile's stored credential.
- A managed bridge is an owner, not merely a network optimization. A failed/mismatched managed binding must not replay workflow calls through an independently derived remote session. Safe local discovery/connect can remain available, but recovery must report that the managed owner requires normal lifecycle repair.
- Explicit native remote/server-control invocations must preserve their selected destination and must not export the invoking managed session's bridge, routing or thread identity into another server. Owned local interactive routing retains its existing root-thread checks. No claim of cross-host support where the destination lacks Statewright.
- Two simultaneous bridges must isolate tokens, client identities and gateway/session forwarding; shutting down one must not alter the other.

## Validation and delivery boundary

Focused tests: actual shell proxy plus loopback HTTP gateway; HTTP 200/401/403/404/5xx/transport failures; missing/rejected credentials; explicit connect only; no write replay; dead/foreign bridge; native launcher argv/environment preservation; concurrent bridge isolation. Then affected executor/Codex suites and generated-runtime consistency. Do not replay formerly denied focused commands.

Observed-only budget: 90 minutes preparation/validation, 60 bounded calls before contraction, retain final quarter for validation and handoff. No live gateway writes, real OAuth flow, installation, restart, promotion or production calls. Fixtures are not live host acceptance. One reviewed coherent install/refresh is the later delivery boundary.

## Implemented surface

- `plugins/codex/mcp-proxy.sh`: exact canonical endpoint, HTTP status preservation, safe recovery discovery in direct/managed/adapter modes, explicit local OAuth, no managed-owner fallback/replay.
- `plugins/executor/lib/mcp-recovery.mjs`: shared typed transport/auth/permission/protocol errors. HTTP 401 or the bridge's explicit typed authentication error supplies login recovery; arbitrary error strings or server-reserved error codes do not. No upstream HTTP error body is echoed.
- `managed-mcp-bridge.mjs`: canonical endpoint, token plus asserted-client agreement, upstream-versus-bridge error distinction; existing session-header forwarding and successful SSE handling preserved.
- `managed-client-supervisor.mjs` and `statewright-managed-client.mjs`: preserve explicit native destination/control argv, avoid provisioning another resident, strip inherited owner capabilities before launch. No changes to permission flags or policy.
- Codex generated runtime and Claude shared-runtime manifests/copies synchronized; README describes recovery and isolation limits.
- New recovery/native-destination regressions; existing bridge/onboarding/parity tests updated to the deliberate transport contract. The parity fixture now uses disposable HOME and strips inherited Statewright/Codex context.

## Test ledger (executed here, not inherited release evidence)

All commands ran in `<statewright-checkout>`.

1. Initial focused run: 16 passed / 1 failed. Existing bridge test expected upstream HTTP 500 passthrough; changed contract returns a JSON-RPC error over a successful bridge HTTP transport, retaining upstream status and forbidding replay. Assertion updated to that explicit contract.
2. Expanded focused run: 82 passed / 1 failed. Existing fake curl omitted the newly consumed HTTP status writeout, producing transport-unavailable. Fixture now emits body plus status. Subsequent focused run: 87/87 passed.
3. First Codex/Claude run: 192 passed / 1 failed. Actual copied-runtime import failed because Claude's runtime publication manifest omitted the new dependency. Fixed both explicit copy manifests; rerun 193/193 passed.
4. First full executor run: 726 passed / 1 failed. Existing parity assertion required Codex to replay discovery through a remote session after losing its managed owner. Updated to require recovery-only discovery; Claude's legacy fallback remains outside this Codex repair. Added reconnect capability-rotation and proxy-through-bridge authentication tests. Recovery/bridge/parity run: 31/31 passed. Full executor rerun: 729/729 passed.
5. Shell handshake test passed. Shell syntax, generated-runtime checks, and `git diff --check` passed. A final combined suite follows the final auth-code/type tightening; its result is recorded below after completion.

Final exact-source command:

```sh
node --test plugins/executor/tests/*.test.mjs plugins/codex/tests/*.test.mjs plugins/claude-code/tests/*.test.mjs
```

**922 passed, 0 failed, 0 skipped/cancelled; exit 0; 57.292 seconds.** This includes the final typed-auth discriminator and isolated parity fixture. Generated Codex and Claude bundle checks and shell syntax passed again afterward. This is the affected-suite gate, not the entire multi-platform release gate.

Canonical Statewright's tracked binary diff independently remains SHA256 `1e78270c160a69f1be21c54181441e5e798313ff6594249ce719b9e5e1dc8dc9`; cached diff remains empty (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`), matching the earlier installation receipt. Unrelated files and other checkouts were not edited.

## Test isolation incident and containment

The pre-existing `proxy-feature-parity.test.mjs` inherited real HOME. Its direct-proxy fixture invoked ordinary startup bootstrap during the first executor run, refreshing real shim/config/Desktop pointer files at approximately `2026-10-06T07:01:30Z`. This was not a coordinated candidate installation, but it was an unintended local write; the earlier source-only intent is not proof of zero side effects.

- Codex shim independently still matches the previous installed receipt: SHA256 `ca720172d672cc7da652606609536bf0b3e71e36f0d79bff1587928efb4279ca`, pointing at durable `0.3.4+codex.20261006020803`.
- Claude and the three Desktop wrappers pointed at the preparation checkout. Using the already-installed package's supported `installManagedClientShim` / `provisionDesktop` functions, these pointers were returned to installed `0.3.4+codex.20261006020803`. Exact precondition checks preceded that cleanup. Desktop JSON equality proved **only wrapper changed** during cleanup; Claude shim equality proved **only the launcher prefix changed**. Profile/gateway/client, native executable and node selections were preserved. No restart or native trust action occurred.
- Real config/shim metadata was touched by the old fixture; a complete pre-test byte snapshot was not retained, so this receipt does not claim byte-identical rollback of every pre-existing file. Credentials were not read or printed. The fixture now uses isolated HOME, no browser/Desktop provisioning, disabled telemetry and scrubbed inherited context; reruns must leave those real pointers unchanged.

## Remaining delivery/acceptance boundary

No new package version, cache installation, daemon reload, workflow activation or cluster deployment was performed. Package metadata remains the old installed identity and must not be reused to publish changed bytes. Native MCP discovery in the current daemon is still unverified for this candidate. A reviewed, uniquely versioned coherent package and supported owner-aware normal refresh are needed before live acceptance.

Two simultaneous bridge fixtures and fake-native launcher tests are not a live multi-daemon acceptance claim. Already-running daemons are not automatically rebound. Explicit remote destinations need their own integration/credentials. Claude's pre-existing shell fallback is not represented as fixed by the Codex isolation change. Real OAuth/keyring acceptance and native TUI/Desktop multi-server discovery remain unexecuted. Independent review was not spawned, per the user's ownership constraints.
