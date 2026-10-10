# Codex native resume address repair

Date: 2026-10-09. Base: `c49ffb1602581336ab88b82838c11a255064eacc` on
`staging/full-tree-source`. Local build: `0.3.4+codex.20261009141014`.

## Failure and repair

The previous launcher appended `statewright_resume_yolo_thread` to the native
`--remote` address. Native Codex 0.160.0 rejects query-bearing remote addresses
before connecting. The earlier supervisor test stopped at history preflight,
and the proxy test connected with Node's more permissive WebSocket client;
neither exercised the vendor CLI parser.

A per-launch, single-use loopback relay now exposes a plain native remote
address and carries the exact thread binding only to the resident. Existing
resident permission projection, ownership checks, and detached-work ownership
are unchanged. Ordinary resumes still connect directly. Explicit permission
overrides other than a sole YOLO flag retain their existing restart transport.
Global remote options precede the original arguments so prompt text after `--`
cannot swallow them. Relay cleanup covers child-spawn failure and normal exit.

The Codex runtime is regenerated through `sync-desktop-runtime.mjs`; the shared
Claude supervisor is synchronized through `sync-managed-client.mjs`. Codex-only
imports remain dynamic so the Claude module graph does not acquire WebSocket
dependencies.

## Acceptance evidence

- Focused relay tests: 7/7, with `CODEX_BIN` selecting the actual installed
  native executable. The original query-bearing address fails while the new
  address passes parsing and reaches the non-TTY guard.
- Native PTY canary: the actual Codex 0.160.0 TUI connected through a plain
  relay address; the test resident received `initialize` and the exact synthetic
  thread binding. Its controlled rejection exited the client before session
  initialization. No real conversation or model turn was used.
- Existing explicit-YOLO supervisor/proxy regressions: 2/2.
- Tests cover frame order/type, queued handshake traffic, ordinary-resume and
  prompt preservation, browser-origin/path rejection, single-use ownership,
  upstream failure, rejected half-open sockets, and idempotent cleanup.
- Independent read-only review found one shutdown hang with rejected half-open
  upgrade sockets. Tracking all TCP connections fixed it. The reviewer reran
  all seven tests and the generated-runtime parity check and reported no
  remaining actionable findings.
- Packaged old/new resident runtime revisions both equal `6195b4b9175f399b`.
  The existing resident can be reused without interrupting its owned work.
- The first full `task test:plugin-release` passed. The post-review rerun
  passed executor 762/762, Codex 174/174, Claude 27/27, Cursor 6/6, and the
  initial Codex TUI suite 25/25, but stopped in the unchanged Pi package:
  `runs actual json CLI through pending approval with a bound task-owned child
  and exact private SDK readiness` observed one pending-state read while
  awaiting two within 2,500 ms. Pi reported 355 passed, one failed, one skipped.
  This second full gate is not claimed green. The exact case passed on the
  single isolated retry (one passed, 26 filtered out); no Pi code was changed.
  The first
  full run passed Pi 356/356 (one production canary skipped), OpenCode 14/14
  (one skipped), OMX 74/74 (one skipped), and all remaining shell checks.
- Supported `--install --enable --host codex --real-bin ...` installation
  switched the shim to immutable build `0.3.4+codex.20261009141014`. The prior
  immutable build remains available for rollback. Packaged and installed
  supervisor/relay bytes match, and the native PTY canary also passes when
  importing the installed relay. The original resident PID remained unchanged
  and its readiness endpoint returned HTTP 200 after installation.

Installed SHA-256 evidence:

```text
codex-resume-relay.mjs       7769f83611f3a241dd3858d91297479fde32c1444a618834e8ec120dcd7f0233
managed-client-supervisor.mjs a842176e5659b929f19cefbdbace7a9ddf7914508a9bd3366b2c5b11cfc70761
```

Reproduction commands:

```sh
CODEX_BIN=/path/to/native/codex node --test plugins/executor/tests/codex-resume-relay.test.mjs
# Requires a real terminal; intentionally rejects initialization, without a turn.
CODEX_BIN=/path/to/native/codex node plugins/executor/tests/codex-resume-relay-native-canary.mjs
LC_ALL=C CODEX_BIN=/path/to/native/codex task test:plugin-release
```

## Scope and control-plane boundary

The native workflow-list request timed out; the staging connector returned
JSON-RPC internal error `-32603`. No workflow execution or controller acceptance
is claimed. This bounded local repair used one implementation pass, focused
tests, two full plugin-gate runs, and one independent review plus finding verification.
Model-token usage is unavailable; no provider-execution evidence is inferred
from routing or local fixtures.

The source worktree was clean at the base. Unrelated changes in the canonical
Statewright checkout and other repositories were preserved. No push, tag, production
deployment, resident termination, real conversation replay, or model turn is
part of this repair. Actual resume and subsequent user interaction remain a
user-owned acceptance boundary; the native canary proves address parsing and
initialization transport, not a completed historical-session resume.
