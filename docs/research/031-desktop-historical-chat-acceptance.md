# Desktop historical-chat acceptance — 2026-10-10

## Contract and decision

Statewright 0.3.4 must work in an existing pre-Statewright Desktop chat. A fresh
chat is not a substitute. Preserve signed ChatGPT computer-use identity, a
separate Desktop App Server process, gateway-keyed credentials, and thread-owner
guards. Do not expose the staging gateway or deploy backend changes for this
local repair. Dev1/2/3 remain deferred.

Source worktree: `staging/full-tree-source`, base `10db3e5`. The pre-existing
three-file launcher/home correction belongs to this task. Canonical dirty source
is excluded. Native workflow control is unavailable; the user explicitly
authorized proceeding without Statewright. This is not a workflow-controlled run.

Bounded slice: generated Desktop launcher, its tests/docs, and plugin version.
One local package installation and profile reprovision follow validation/review.
Budget (provisional, observed-only): 30 minutes, 45 tool calls, 120 KB diagnostic
output, one focused test run and reuse of the already-completed full gate for
unchanged runtime code. Reserve the last third for review/install/handoff; contract
scope instead of speculative broker rewrites. No provider-token counter available.

## Evidence and corrected diagnosis

- Desktop log `codex-desktop-[redacted-id]-69341-t0-i1-152813-0.log`
  on the test workstation, 2026-10-10: thread `[redacted-id]`
  successfully resumed on `hostId=durable` at 16:07:37Z; `turn/start` succeeded
  at 16:07:46Z. Local denials concerned `thread/attachment/list`, not that resume.
- The same log repeatedly reports local Work executor registration failure due to
  missing ChatGPT/API-key authentication. The isolated profile Codex home lacks
  the user's authentication/plugins. This is a separate confirmed regression.
- Cloud `codex_apps.statewright_staging.statewright_get_status` failed with
  `-32603 Internal error` during the preceding audit; `list_workflows` reproduced
  that error in this repair turn. No workflow mutation was attempted. Underlying
  connector cause is still unproven; local-home repair does not establish its fix.
- Connector reachability must be verified independently. The local-home repair
  does not diagnose or authorize changes to server ingress.

## Launcher correction

Keep Electron user-data isolated by profile, but use the explicitly configured
`CODEX_HOME` or the OS user's `.codex` as the authentication/plugin source. The
broker already creates a private App Server home with its own configuration and
shared auth/plugins/history. This avoids a second empty auth universe without
moving secrets, changing gateway identity, replacing signed ChatGPT, or weakening
thread authorization. An explicitly configured custom home remains authoritative;
an inherited obsolete temporary home remains a documented residual risk.

Alternative rejected: relaxing thread ownership in response to attachment-list
errors. It does not address the demonstrated cloud integration failure.

## Validation and review

Inherited evidence: focused setup suite 34/34 and full `task test:plugin-release`
passed for the pending runtime correction during the previous turn; full process
exit 0 was observed in the audit. These are local/package results, not Desktop
acceptance. Prior independent `desktop_codex_home_review` found no direct blocker,
flagged inherited ephemeral homes, and explicitly did not certify historical chats.

Current-turn focused test and installation results are recorded in the release
controller receipt. Additional test covers an explicitly selected custom home.
Applicable controls: PC-01 historical-chat acceptance remains a gap; PC-04/10
native identity, gateway credentials and ownership must be preserved; PC-07/08
scoped commit, tests and installed-source parity; PC-15 bounded review/handoff.
No schema migration or server deployment is applicable.

## Acceptance and rollback

After normal staging launcher restart: verify local Work executor registration,
resume the same historical chat, invoke the local Statewright integration, then
exercise the human prompt. Record loaded plugin/runtime and actual tool namespace.
Neither a green doctor nor a successful GUI launch satisfies this acceptance.
No pending product-scope decision; the user already requires historical chats.

Rollback is the prior plugin version `0.3.4+codex.20261010152222` and its profile
reprovisioning, which restores the known empty-home defect. Do not erase either
profile user-data or the user's existing Codex home. Do not terminate active chats
to obtain a test result.

## Cross-project resume triage and next repair

User restart reply resolved the previous question: executor connected to rendezvous
at 16:25:09Z, but a historical thread `[redacted-id]` was rejected
at 16:28:38Z by the local same-root guard. Both immutable cwd values are available:
the registered original thread and later historical thread have
different generated task folders. Installed bundle/source parity was checked.
This is a proven directory restriction, not evidence of another active writer.
The earlier remote chat's eventual success path remains unverified.

Ownership inspection: runtime environment, MCP bridge client ID, route directory,
and classifier controller are all single-thread scoped. Removing only the cwd
comparison is unsafe. Decision: preserve the existing per-thread controls behind
a Desktop protocol dispatcher; discovery reads never adopt or consume a workflow.
Each selected historical thread receives its own managed identity/runtime/bridge,
native-confirmed claim, and shared Codex writer lease. Legacy registered thread
keeps its identity. New threads receive a provisional identity persisted after
native confirmation. Bridge allocation stays in the pre-sandbox launcher, bound
to its selected gateway; no credential or public ingress changes.

Scope: new dispatcher and authenticated bridge-pool modules/tests; launcher
integration; generated Codex bundle and release metadata. Exclude TUI routing,
shared same-root transfer semantics, server/site/gateway deployments and GUI
automation. Independent bounded architecture review supplied source constraints;
independent diff review is still required before install. Validate two different
projects, failed resumes, exact native response identity, writer contention,
cross-lane request IDs/approvals, restart mapping, and cleanup. Runtime cap rejects
new admission explicitly rather than evicting active work.

Budget: provisional observed-only 45 minutes/60 tool calls, one full package gate,
one independent review plus focused repairs; reserve final third for validation,
installation and honest handoff. If the protocol boundary cannot be validated,
leave the last installed repair unchanged and record the failing evidence. No
live workflow control is available; explicit user fallback remains in force.

## Per-chat repair evidence (2026-10-10)

Implemented a gateway-bound loopback bridge allocator and Desktop stdio dispatcher,
with isolated runtime, route directory, classifier controller and managed writer
lease per chat. Discovery does not claim a writer. Historical identities are
deterministic; provisional new-chat bindings persist before root ownership is
committed. The previously registered legacy chat retains its identity.

Independent test authors exercised two project roots, failed native resume,
foreign writer contention, restart binding, approval ID collisions, concurrent
lane initialization and shutdown. The first dispatcher run exposed a late-success
shutdown race; the repair checks closure after binding persistence. Independent
review also identified provisional-binding commit order and silent discovery-only
global settings writes; both were corrected before installation. These are source
and protocol checks, not live Desktop acceptance.

The actual bundled signed-app Codex executable passed the opt-in native canary:
two disposable historical rollouts in different project directories resumed,
then the first resumed again. No model turn, credentials, user's history or
active chats were used. Reproduce with `STATEWRIGHT_DESKTOP_CODEX_BIN` pointing to
the vendor executable and `node plugins/executor/tests/desktop-historical-vendor-canary.mjs`.
It proves native transport/resume compatibility, not Statewright tool visibility,
workflow routing, human prompting or computer-use identity in the live GUI.

Bounded limitations: at most 16 resident lanes including discovery; the bridge
pool retains distinct allocated identities until Desktop exits, so save work and
restart to reclaim capacity. Thread forks and profile-wide `config/value/write`
or `config/batchWrite` reject explicitly until supported; per-chat settings remain
routed to their owner. Native/global configuration synchronization is a remaining
release limitation, not an accepted silent no-op. Direct legacy broker launches
without a pool retain the original single-thread contract.

Current candidate: `0.3.4+codex.20261010164648`. Final package gate, installation
parity and live acceptance status are recorded in the release controller receipt.
One additional full package rerun was authorized within the same 45-minute
observed budget because review corrections postdated the first successful run.
Rollback: reinstall `0.3.4+codex.20261010162105` and reprovision existing profiles;
preserve the new binding receipts and all user data. That version retains the
known cross-project resume restriction. No gateway/site/server deployment applies.

## Handshake regression triage (2026-10-10)

User's next normal-launch test reported `Desktop initialization has not completed`.
Signed Desktop PID [redacted] logged successful native initialization at 16:56:05.334Z
in `codex-desktop-[redacted-id]-41707-t0-i1-165604-0.log`.
The installed app's `AppServerConnection.completeInitialization` proceeds on that
response without sending the separate `initialized` notification. The dispatcher
instead unlocked only on that notification. Prior canary explicitly sent it,
so its success did not cover this actual client sequence. Native init failure or
an OAuth failure is not supported by this successful handshake log.

Narrow repair contract from clean `f1d4e40`: dispatcher readiness follows its
correlated successful native initialize response, with exactly one downstream
initialized notification; redundant client notification is consumed. Failed,
pending and malformed native responses must stay unready. Preserve ownership,
auth, permissions and gateway boundaries. Update tests and vendor canary for both
client sequences, regenerate package, independent review, one final full plugin
gate and local install. No server/site/gateway deployment or GUI automation.

Continue the user-authorized no-Statewright fallback: native local get-state is
still unadvertised; the cloud connector is not a substitute for that binding.
Budget is provisional/observed-only: normal 20, hard 30 minutes; 40 remaining tool
calls; one scoped review and one full gate, reserving the final third for install
and handoff. Contraction stops optional exploration; hard stop records evidence
and leaves installation unchanged. PC-01 live acceptance remains a gap; PC-04/10
identity controls unchanged; PC-07/08/15 require exact package/review evidence.

Characterized baseline: the four new dispatcher cases failed on the prior source
(18 prior tests passed), and the real bundled vendor canary without the client
notification exited 1 with the user's exact error. After the scoped repair,
dispatcher plus runtime tests passed 28/28; the real vendor canary passed both
without and with the explicit client notification. Neither run used model turns
or user history. This supersedes the earlier canary's incomplete handshake
coverage, not its narrowly successful historical-resume result.

Official protocol reference, retrieved 2026-10-10:
https://learn.chatgpt.com/docs/app-server#initialization describes the two-message
sequence. The broker now owns that downstream sequence while accepting the
observed signed Desktop behavior upstream. Readiness still requires the actual
native response; no timer, retry or client assertion substitutes for it.
Candidate `0.3.4+codex.20261010165943`; install, final package gate and live
acceptance outcome belong in the controller receipt. The prior restart question
is resolved as a failed Desktop acceptance, not left pending or counted as pass.

Independent non-editing `desktop_handshake_review` found no blocker in this diff.
Its additional read-only probes covered notification-send failure, discovery
disconnect and late initialization after disconnect. Exact final full-gate and
installation results remain in the release controller receipt; the user's next
normal-launch test still determines live acceptance.

## MCP discovery PATH failure (2026-10-10)

The next user test resolved the pending question: historical-chat resume succeeded. Desktop
PID [redacted] logged successful `thread/resume` at 17:05:24.456Z, but `turn/start`
failed at 17:06:29Z because Statewright MCP discovery never became ready. The
decisive read-only Codex SQLite log rows (17:05:25Z and 17:05:54Z, target
`codex_rmcp_client::stdio_server_launcher`) contain
`./mcp-proxy.sh: line 12: node: command not found`. The shell proxy initialized
successfully, then produced no `tools/list` response when normalization could
not find Node in Desktop's restricted PATH. Independent live staging bridge
discovery returned HTTP 200 in 255 ms with 12 tools including get-state.
Neither auth failure nor gateway unavailability explains this observed timeout.

Bounded repair on clean base `322d3c3`: propagate the existing launcher's pinned
`STATEWRIGHT_NODE_BIN` through the plugin MCP environment allowlist; use that
executable consistently for proxy helpers. Unpinned terminal PATH and existing
bundled Desktop fallback remain supported. An unavailable explicit runtime must
return a correlated MCP error, not silently select another executable or emit
an empty reply. Signed ChatGPT, native dispatcher, thread ownership and readiness
deadline remain unchanged. Do not change other failing third-party integrations.

Red baseline: restricted-PATH proxy tests failed 3/4; the working terminal PATH
case passed. After correction the four cases plus manifest contract passed 6/6.
The real bundled native canary now resumes both fixture chats and verifies native
MCP tool discovery through the actual shell proxy and manifest env allowlist,
under restricted PATH. It passed with a disposable fixture gateway and no model
turns/credentials/user-history writes. Live gateway readiness is separate read-only
evidence; neither replaces live Desktop Statewright/human-prompt acceptance.

Scope: shell proxy, MCP manifest, regression tests/canary, version and receipt;
no backend deployment. Apply agentic-SDLC review/install controls under the same
explicit no-Statewright fallback (only cloud get-state advertised, not local).
Provisional observed-only remaining budget: 20 minutes/30 calls; one independent
review, one full gate, reserve half for validation/install/handoff. Stop breadth
at reserve and report gaps rather than skipping native evidence. Candidate
`0.3.4+codex.20261010171205`; final validation and install in controller receipt.

Independent `desktop_mcp_path_review` found no blocker and reran 6/6 focused
tests. It noted missing focused coverage of bundled-Node fallback success and
did not independently verify the unchanged launcher export; parent inspection
confirmed `STATEWRIGHT_NODE_BIN: state.node_executable` in the generated launch
path. A current-turn read-only end-to-end proxy call with the real staging
credential, pinned interpreter and restricted PATH returned 15 advertised tools
in 370 ms, including get-state. No workflow tool was invoked. This proves the
corrected helper-to-gateway discovery path, not live Desktop turn execution.

Final-gate reconciliation: first full run failed the existing standalone 401
recovery test because captured normalizer output lost its terminating newline.
Restored that newline (direct output needs it; command substitutions strip it).
Independent bounded re-review found no blocker. Focused recovery/runtime/manifest
tests passed 21/21; added bundled-fallback coverage then passed 5/5 runtime tests.
Preserve `/tmp/statewright-desktop-mcp-path-final-20261010.log` as failed evidence;
the second exact-candidate gate is
`/tmp/statewright-desktop-mcp-path-final2-20261010.log`. This one bounded rerun
uses recovery reserve; no additional source scope or deployment is authorized.

## Late internal replies and scoped readiness (2026-10-10)

Repair contract, base `f013166`, clean `staging/full-tree-source`: keep internally
issued RPC IDs private for the connection lifetime, including after timeout or
completion. Preserve dispatcher rejection of foreign responses and isolate its
failure to that lane. Native schema generated from the installed Desktop Codex
confirms `ListMcpServerStatusParams.serverName` reuses the named thread's MCP
connection and `detail: toolsAndAuthOnly` is supported. Scope required readiness
to the Statewright server instead of repeatedly discovering all optional servers.
Do not extend the readiness timeout or admit a turn without the required tool.

Evidence input: the historical acceptance receipt records the successful resume/MCP
startup, subsequent lane error, and isolated delayed-response reproduction. The
live leaked ID was not recorded; causal matching is an inference, reproduction
of the leak is observed. No need to repeat live user turns during development.

Owned artifacts: route proxy, generated Codex/Claude copies, focused transport
and dispatcher-composition tests, native historical canary, plugin version and
this packet. No signed-host/shim/credential/dispatcher policy change, no third-
party MCP repair, no gateway/site deployment. PC-01/02/04/07/08/09/13/15 owned by
this repair and tied to tests/review/receipt; migration controls not applicable.
Live GUI acceptance stays a gap until the user's normal-launch retest.

Explicit user-authorized no-Statewright fallback continues: only cloud connector
control advertised, not the requested local binding. Apply engineering/SDLC and
usage controls with no claim of controller enforcement. Provisional observed-only
budget: 25 minutes/45 calls normal, 35 minutes/65 calls hard; one independent
non-editing review, one full package gate, at most one evidence-backed correction.
Reserve half for validation/install/handoff; stop extra discovery at reserve.
No model reroute or inferred token/billing accounting; provider usage unavailable.
Rollback is reinstall/reprovision `0.3.4+codex.20261010171205`, which retains this
late-reply defect. Exact validation/installation identities belong in the receipt.

Decision: connection-random namespace plus a canonical, contiguous issued sequence
range retains precise ID ownership with constant memory. Reject downstream reuse
of that private namespace. Only result/error responses for actually issued IDs
are consumed after settlement; reverse-direction requests are not responses and
foreign or unissued IDs remain visible to the unchanged dispatcher. A prefix-only
drop rule and increasing the 12-second timeout were rejected. Readiness now uses
the installed native API's server-scoped tools-only query and checks the returned
server identity plus tool. No dependency or trust/permission changes.

Current-turn red composition test failed at the exact lane-close invariant after
13 seconds. Initial combined focused run was stopped after a fixture mistake:
the existing transport file's local `once` helper returns a Buffer, not the array
from `node:events.once`; corrected the three new fixture reads. This was not a
product retry or a passed run. Corrected focused transport/composition run passed
99/99. Additional exact-ID negatives, readiness failure tests and tighter native
resume-plus-discovery timing run separately before the final package gate.
Independent non-editing `desktop_late_rpc_review` found no runtime blocker and
requested these coverage improvements. Candidate `0.3.4+codex.20261010172610`;
no live acceptance claim until the normal-launch historical-chat turn succeeds.
