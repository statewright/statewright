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

- Desktop log `codex-desktop-a1c62371-1721-417a-bfc6-fe68f1b348ec-69341-t0-i1-152813-0.log`
  on aerith, 2026-10-10: thread `01a121d2-efaf-7037-be00-25ff2f9610fa`
  successfully resumed on `hostId=durable` at 16:07:37Z; `turn/start` succeeded
  at 16:07:46Z. Local denials concerned `thread/attachment/list`, not that resume.
- The same log repeatedly reports local Work executor registration failure due to
  missing ChatGPT/API-key authentication. The isolated profile Codex home lacks
  the user's authentication/plugins. This is a separate confirmed regression.
- Cloud `codex_apps.statewright_staging.statewright_get_status` failed with
  `-32603 Internal error` during the preceding audit; `list_workflows` reproduced
  that error in this repair turn. No workflow mutation was attempted. Underlying
  connector cause is still unproven; local-home repair does not establish its fix.
- Live staging has both an internal MCP ingress and a public plugin ingress
  routing `/mcp` to the gateway. Do not assume private-only reachability explains
  the connector error, and do not modify ingress based on that assumption.

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
