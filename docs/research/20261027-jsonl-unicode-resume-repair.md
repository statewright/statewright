# Codex resume: Unicode JSONL framing repair

## Contract and evidence

Scope: shared Codex history integrity reader, its focused tests, synchronized
Codex/Claude package copies and one versioned local staging managed-runtime install.
Base: `adc42b7` on `staging/full-tree-source`. No workflow activation (user-directed
Statewright skip), classifier/security changes, history rewrite, production action,
or unrelated Claude hook edits. Bounded single repair/review/install cycle; no
model changes. Independent reviewer: `/root/fork_history_review`, static only.

Pane `death-rebirth:3.1` failed resuming
`01a0a281-f183-7ce1-ab50-dcaf77684f6e` before native startup. Installed
`0.3.5+codex.20261026213425` incorrectly reported malformed JSON and a gap.
Node 26.5.1's readline includes U+2028/U+2029 in its line-ending expression.
Actual LF record 44 contains two U+2028 characters inside valid JSON strings.
Readline manufactured two extra records; the repair candidate hit the same reader.
This is a reader defect, not evidence of a corrupted session.

Actual history read-only check with the corrected source: healthy, 4,907 records,
last ordinal 4,906, no anomalies. Original SHA256 remains
`6f117b94e6b5653a2ec9e9507dc120757e59fa434bcaed7044331a550be62072`.
No original history, projection, lock or backup was changed by this task.

## Repair

Use a shared LF-only streaming generator for inspection and duplicate-settings
rewrite. Node's UTF-8 stream decoder preserves multibyte characters across chunks.
Retain normalized hash checks for CRLF and missing final newline, ordinal checks,
identity, inherited byte-prefix limits, locks and compare-and-swap protection.
Tests exercise both Unicode separators at 64KiB offsets -2/-1/0, long/multibyte
records, real malformed framing, duplicate-content preservation and fork ancestry.

## Fresh validation

- Red: `node --test plugins/executor/tests/codex-history-integrity.test.mjs`:
  32 passed, 5 failed with the old reader and new Unicode fixtures.
- Green: same command after repair: 37 passed, 0 failed (46.7 seconds).
- `node --test plugins/executor/tests/managed-client-launcher.test.mjs plugins/executor/tests/managed-client-supervisor.test.mjs plugins/codex/tests/desktop-runtime-bundle.test.mjs`:
  59 passed, 0 failed.
- `node --test plugins/codex/tests/plugin-runtime-contract.test.mjs`: 5 passed.
- Codex `sync-desktop-runtime.mjs --check` and Claude
  `sync-managed-client.mjs --check`: passed. `git diff --check`: passed.
- Bounded independent static review: no findings; no user history access or test
  duplication by reviewer.
- Executor and both generated history modules SHA256:
  `a7a05d5578cb569cef11212f2dad3da217ba04bd674942fce4bb48d04a313158`.

No whole-repository suite or production validation claimed.

## Local delivery

Candidate build `0.3.5+codex.20261028002110`. Use existing
`installManagedClientShim`, staging installer-home only, preserving the previous
versioned runtime. The full Codex package also includes already-committed native
connector guidance from adc42b7. Unrelated dirty Claude hook/test changes are not
part of this Codex package or commit. Normal user entrypoint remains `scodex`.
No shell alias/config/trust changes or live shared-session termination.

Repair commit: `e28d133`. One scoped install completed successfully. Installed
history module SHA256 equals the source/generated hash above; the staging shim
selects the new version. An independent installed-module inspection returns the
same healthy 4,907-record result and unchanged original history SHA256.

From the verified idle pane `%4` / shell PID6437 in `/Users/ben/dev/polyhedron`,
retried only `scodex resume 01a0a281-f183-7ce1-ab50-dcaf77684f6e`. Launcher PID57856
uses the new durable package. Native Codex started without the history error.
Dismissed its optional CLI-update offer without installing/updating Codex.
It then displayed **Hooks need review; 1 hook is new or changed**. No hook trust,
skip, disable or approval input was sent. Original-session resume acceptance is
pending that real human gate, not claimed complete. Native guard did not prompt
for history repair. No inference/task instruction was submitted.

Unrelated Claude modifications remain unstaged and unchanged by this task.
Rollback uses the same scoped installer with the retained previous version;
it restores the false alarm too. No production or gateway deployment occurred.

## Follow-up: complete resume path (2026-10-28 UTC)

The first delivery was incomplete. After human hook review, native bootstrap
failed in `readCodexResumePermissions` at line 44 with
`STATEWRIGHT_SAVED_PERMISSIONS_INVALID`. That separate reader still used readline.
Fresh installed inspection passed while installed permission extraction failed;
the original SHA256 remained unchanged. Do not treat the earlier gate arrival as
successful resume acceptance.

The existing LF generator is now exported as `readCodexRolloutLines` and reused by
permission extraction through its existing integrity-module dependency. Permission
selection/identity/unsupported-profile rejection are unchanged. Production executor
readline audit finds only the interactive credential confirmation prompt remaining;
that is not a JSONL reader. Other inspected metadata readers already use LF.

Validation now includes the combined integrity + permission path with both Unicode
separators across stream boundaries, later restrictive settings, and the actual
permission reader inside the WebSocket proxy resume test rather than a stub.
Malformed JSON and foreign identity still fail closed. Combined regression failed
before the change, then packaged source successfully inspected all 4,907 original
records and recovered permission fields without rewriting the history.

Source and generated module SHA256 values:

- integrity: `42eeb386f5c5fa1448b693306c811e1a6a788c4b67b312bb3b98eee8519e3e4d`
- metadata: `f8d4a19495428e4a94957b542c4440e1a78d46e6613db5ced3031f57162dd8c3`

History + native transport + original read-only-profile suite: 145 passed, no
failures. Final read-only-profile + launcher + supervisor + bundle + runtime
contract gates: 75 passed, no failures (10 profile cases overlap the prior run;
210 distinct tests passed). Both generator checks and diff check pass. Independent
bounded static follow-up review: no findings. No unrelated Claude edits included.

Coordinated follow-up package: `0.3.5+codex.20261028002755`; same supported scoped
staging install and `scodex` resume path. No policy/permission override, manual
history cleanup, shell config edit or protected UI action is part of the repair.
