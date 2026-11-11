# Same-session workflow-origin successor recovery

## Observed incident

On 2026-10-26, `death-rebirth:2.1` resumed thread
`01a156c6-7735-7c01-89da-4b31ca57cec2` successfully but rejected its next turn
with `STATEWRIGHT_ROUTE_ORIGIN_OWNER (binding_conflict)`.
Client `swc_e11448ec8c594bb1bf136b2047f79830` retained an active origin for run
`af70396d-3d93-4ce6-b567-0b0c97146341`. A fresh, authenticated read of the
configured staging service reported run `9c34c3a7-5577-40cc-90d3-0566e2467138`,
nonfinal intake, epoch 1, in the same gateway run session. The queued route
also referenced the newer run. No credential contents were recorded.

The origin recorded manual relinquishment of model and effort. Its earlier
Astra/high origin therefore is NOT authority to force Astra/high now.

## Root cause and limits

The route selector admitted the authoritative new run, but origin capture
rejected its different run ID. The previous recovery required inactive or
old-final authority, which cannot match this active-new-run case. It also
called terminal restoration while holding the same routing lease that
restoration acquires. Automatic load handoff independently rejected a new
run against the preceding native turn's old binding.

This establishes the current dead end and latent nested-lock defect; it does
not establish the exact original missed-teardown event or that a staging
upgrade caused it. A null state alone is not deactivation proof: pause also
clears the active workflow. Existing pause handling is retained.

## Repair

- Verify a fresh successor state, phase/epoch, declared route, no pending
  approval, current activity owner, and identical thread/client/root/gateway
  session before moving durable origin ownership to the new run.
- Carry the still-owned baseline, preserving acknowledged manual choices or
  observed native divergence. Keep a bounded predecessor record; never delete
  provenance to escape a conflict or claim the predecessor completed.
- Perform the ownership handoff under the existing lease without settings RPCs
  or nested lease acquisition. Share it between ordinary turns and automatic
  successful load handoff. Foreign, stale, unavailable and concurrent ownership
  evidence remains rejected.
- Preserve explicit inherited first-turn selections only after a matching
  native success acknowledgment; rejected choices never become manual ownership.
  Explicit null effort/tier remains distinguishable from missing evidence.

## Validation

Executed from the staging source worktree:

```
node --test plugins/executor/tests/workflow-route-origin.test.mjs plugins/executor/tests/desktop-workflow-handoff.test.mjs plugins/executor/tests/codex-app-server-transport.test.mjs
```

Final result: 141 tests, 140 passed, 1 opt-in native canary skipped, zero failures.
Coverage includes successor plus terminal/deactivation restoration, automatic
load handoff, persisted origins/reconnect, partial restoration, manual changes,
accepted/rejected first-successor requests, null settings, pause, foreign/stale
bindings, unavailable authority, concurrent ownership changes and transport scope.
One intermediate new test incorrectly expected a restore RPC after all axes
were manually relinquished; corrected to require the preservation receipt,
exact native settings, and no settings update. That failed run is not a pass.

Independent bounded source review found a first-successor explicit-selection
gap; fixed and re-reviewed with no remaining blockers. These tests are unit and
loopback protocol evidence, not proof of a live TUI/desktop restoration.

Additional executed checks:

```
node --test plugins/codex/tests/desktop-runtime-bundle.test.mjs plugins/executor/tests/codex-native-approval-proxy.test.mjs plugins/executor/tests/codex-workflow-services.test.mjs plugins/executor/tests/managed-client-supervisor.test.mjs
node plugins/codex/scripts/sync-desktop-runtime.mjs --check
git diff --check
```

95 additional tests passed, zero failures. Package synchronization and whitespace
checks passed. Total across both executed test commands: 235 passed, one skipped.

## Delivery boundary

Local managed staging build identity: `0.3.5+codex.20261026213425`.
Regenerate the Codex runtime with the existing generator, check package parity,
and install through the supported managed shim installer. No marketplace cache,
global configuration, workflow definition, classifier policy or origin-file
manual edit is needed. Existing unrelated Claude changes are excluded.
The previous immutable runtime remains available; existing residents are not
hot-patched. A normal idle quit/resume is required to load the new runtime.
Installation, loaded identity, and live behavior must be reported separately.

## Observed local delivery

Repair commit: `86189cb27b615314d3fb1aba217c91154ef02564`.
The existing `installManagedClientShim` installed the exact package into
`/Users/tester/.statewright/lanes/staging/installer-home/.statewright/runtime/codex/0.3.5+codex.20261026213425`.
Source-package and installed SHA256 pairs were independently computed and equal:

- proxy: `06a118cd557cf0cab29063764dbdfc17abede89af7ae651fa0cb022f7e3f56c9`
- origin: `f43bd4f2326cd8a29d3be5351b1721a38fb10b668b3b04308b02bd0bf16d3fd0`

The initial hash command failed in Perl's locale initialization, not policy
review; the same check succeeded with `LC_ALL=C LANG=C` scoped to that command.

Pane `%2` was verified idle. Normal `/quit` returned to zsh PID 6353; old
launcher 2988 and resident 3091 exited. Only
`scodex resume 01a156c6-7735-7c01-89da-4b31ca57cec2` was submitted afterward.
New resident PID 62655 loaded this installed build, runtime revision
`4381b5f1d32a2a77`, started `2026-10-26T21:36:22.080Z`, same managed client.
An optional Codex upgrade was dismissed for this launch; no CLI upgrade occurred.

Live acceptance stopped at the native human-only prompt: **Hooks need review;
1 hook is new or changed**. No trust option was selected, no hook disabled,
and no acceptance turn was submitted. The prompt does not yet name the hook;
the user must review it. Package hook SHA256 is
`7418d51c5bb95334b284260eb9daedccd2c5c62c75ea254796d71c866bacd783`;
package hooks manifest SHA256 is
`b64b6e529bc27576f54919e4c712f6b0bda1d9d727e28cca1600f70bba4be19b`.
Those package hashes alone do not identify the unnamed native review item.
Real first-turn admission/deactivation and native restoration remain pending
that human gate. No gateway deployment or marketplace-cache update was performed.
