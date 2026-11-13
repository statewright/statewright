# Claude Desktop sign-in candidate — November 12, 2026

## Source and scope

- Branch: `fix/claude-desktop-credential-reload`.
- Worktree: `/Volumes/sidecar/.agent-worktrees/statewright-claude-desktop-credential-reload`.
- Public base: `921dc4881c1b861b6d00c45e769d30890f928f8b`, confirmed against
  `origin/main` when this worktree was created. This is not the unrelated local
  internal `main` source line.
- Plugin version remains **0.3.8** in this unpublished source candidate. A new
  published version is needed for installed caches to receive the change.
- No installed plugin, user settings, credential store, Desktop app, gateway,
  workflow or deployment was changed by this task.

## Changes

1. `.mcp.json` now contains the literal production MCP URL. Both plugin manifests
   remove the unused `gateway_url` preference. The README describes preparing a
   custom distribution with a literal endpoint; custom-gateway users must use
   that package before upgrading to avoid switching to the marketplace endpoint.
2. Desktop Connect opens the native `/mcp` dialog. Host surface detection also
   covers tool-triggered Connect before the sidebar renders. Desktop never
   launches Expect or the external CLI login helper. A dialog refusal has no
   fallback login, and missing auth is not reported as completed sign-in.
3. Terminal startup/sidebar checks attempt one scoped reconnect on `auth` to
   detect an external login. Tool hooks waiting on a result do not run slash
   commands: the native test runner rejects that operation. Policy/disabled
   results never trigger reconnect or OAuth.
4. A refused reload or unchanged auth after a completed helper retains a finite
   diagnosis and stops repeat OAuth in that view. Late results are fenced by
   conversation and attempt. Saved-connection checks can recover on actual
   authenticated responses; workflow access is never inferred from login alone.
5. Claude and Codex each have Desktop and CLI lanes in the compatibility ledger.
   Tests for the ledger/checker run through the existing plugin-release task.
   Exact-host acceptance remains a separate fail-closed local check; no release
   watcher or new live promotion gate was enabled.

## Verification

Local tools: Node `v26.5.1`; `/opt/homebrew/bin/claude` **2.1.296**. This is not the
reported Desktop engine **2.1.321** or external CLI **2.1.323**.

| Command | Result |
| --- | --- |
| `node --test --test-reporter=tap plugins/claude-code/tests/*.test.mjs scripts/host-compatibility.test.mjs` | 265 passed: 261 Claude + 4 compatibility checks; none skipped. |
| `claude plugin validate plugins/claude-code` | Passed; recognizes `session.surfaces` and the native command calls. |
| `claude plugin test plugins/claude-code` | 54 passed; none failed. |
| `node --test --test-reporter=tap plugins/claude-code/tests/native-connection.test.mjs scripts/host-compatibility.test.mjs` | Final targeted rerun: 165 passed after refining signed-out diagnostics and workflow-tool guidance. |
| `node scripts/host-compatibility.mjs docs/releases/host-compatibility.json` | Valid ledger with five records; no live acceptance asserted. |
| `task --dry test:plugin-release` | Task parses and includes compatibility tests; the full multi-plugin release task was not executed. |
| `git diff --check` | Passed. |

The new reload fixtures initially failed against the old implementation.
The native runner later caught the waiting-tool-hook slash-command restriction;
that path was corrected and the native suite passed on rerun.

Local test logs are `/Volumes/sidecar/claude-desktop-reload-{full,focused}.tap`
and `/Volumes/sidecar/claude-desktop-reload-native-{tests,validate}.txt`.

## Remaining acceptance and release work

The user confirmed that changing the URL to a literal in the installed cache
and marketplace checkout, followed by a full Desktop restart, restored sign-in.
That evidence is recorded as **reported recovery**, separately from source
tests. The combined candidate still needs a live Desktop test: open native
Connect, complete sign-in, restart/resume, verify catalog and scoped workflow
access, then exercise denial/cancellation and the other host-boundary cases.

Capture the Desktop app version/build and actual embedded engine identity.
Neither the last working release nor the first broken release is established.
The exact `command.run` result in the original incident is also not captured;
fixtures cover both returned refusal text and a thrown exception. The host's
URL interpolation and mid-session reconnect restrictions remain upstream issues.

Before publication, merge the scoped source, select/bump the release version,
build the artifact, bind its digest to the exact source, and complete the
authorized release gates. Do not substitute the user's local manifest recovery
or the CLI 2.1.296 fixture passes for Desktop 2.1.321 acceptance.
