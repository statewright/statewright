# ADR 020: Preserve Codex permissions across managed remote resume

Status: Accepted

## Context

Codex rejects a remote `resume` invocation when its CLI contains an explicit
approval, sandbox, permission-profile, working-root, or additional-write-root
override. A stale shell alias that injected the danger-full-access flag
therefore failed before it sent `thread/resume`, even though the destination
thread had previously run with that policy.

Omitting permission fields is not sufficient for every historical rollout.
Modern named profiles can be restored by App Server, but a legacy raw profile
without named-profile provenance can resolve against current server defaults.
`thread/read` does not return the effective approval or sandbox settings needed
to repair that ambiguity. Codex does record the effective values in its
canonical rollout as `turn_context` and `thread_settings_applied` records.

## Decision

- Before a managed App Server resume is forwarded, Statewright reads the
  canonical rollout selected by the existing history-integrity preflight.
- The latest `thread_settings_applied` or `turn_context` record is the saved
  permission authority. Working directory and runtime roots come only from the
  latest settings event owned by the requested thread, or otherwise from that
  rollout's `session_meta`; a copied parent turn context cannot relocate a fork.
- Statewright fills protocol-null/omitted `thread/resume` fields while treating
  permission profile/sandbox and working directory/runtime roots as atomic
  groups. Any explicit native value wins without being combined with stale
  values from its saved counterpart.
- A named active permission profile is resumed by ID and therefore resolves
  against that profile's current installed definition. A legacy disabled
  profile maps to danger-full-access. A bare legacy sandbox maps only when its
  complete recorded representation is exactly expressible by App Server. A
  custom, external, or enriched raw profile is rejected with an actionable
  error instead of discarding restrictions.
- A sole explicit `--yolo` / `--dangerously-bypass-approvals-and-sandbox` override
  with an exact resume thread ID uses the durable resident. A single-use
  loopback relay gives native Codex a plain `ws://host:port` address and carries
  the exact thread binding on the resident-facing connection. Native Codex
  rejects query parameters in `--remote`; they must never reach the CLI. The
  resident applies explicit intent to the requested resume (rejecting a foreign
  thread) and to new threads started in that same native TUI.
- Other explicit CLI permission or root overrides select the supported restart
  transport before a resident App Server is started. The original CLI arguments
  remain authoritative. Permission arguments after the original `resume`
  subcommand are retained across later Statewright model-route restarts.
- Ordinary config defaults are not treated as explicit CLI intent.

## Security and privacy

The reader accepts only the exact requested thread ID, validates the rollout's
embedded identity, and refuses malformed records or non-absolute saved paths.
It reads permission metadata but does not copy prompt or response content.
Statewright never weakens an unrepresentable profile into a broader sandbox.
Native history repair, writer exclusion, and thread ownership checks remain in
force.

## Consequences

- `scodex resume <GUID>` preserves the thread's recorded permission selection;
  named profiles retain identity while their installed definition may evolve.
- Losslessly representable legacy rollouts preserve their prior effective
  settings; richer raw profiles fail closed and require an explicit override.
- A deliberate CLI override still takes precedence. A sole explicit YOLO resume
  stays resident-owned; other overrides use native embedded resume semantics.
- The per-launch relay rejects browser origins and additional connections,
  preserves frame ordering and type, bounds buffering/handshake time, and closes
  with the TUI. It does not restart the resident or terminate its detached work.
- Cross-platform behavior uses Codex's App Server protocol and Node filesystem
  APIs; it does not depend on platform keychain commands or shell aliases.
- Resume can fail closed when historical permissions cannot be represented by
  the installed App Server protocol. The user must then choose an explicit
  named profile or sandbox override.

## Validation

Coverage includes latest-event precedence, fork-owned location selection,
native-null grouped merging, named and legacy projection, proxy forwarding,
explicit flag/config-alias classification, restart-transport selection, flags
after `resume`, prompt boundaries, and generated runtime parity. Native Codex
acceptance is required in the release receipt in addition to fixture tests.
The remote-address regression additionally requires a real native CLI parser
check and PTY initialization through the relay; a Node WebSocket client alone
does not exercise native CLI address validation.

## Rollback

Revert the rollout permission reader and resume-request adapter. Explicitly set
`STATEWRIGHT_CODEX_TRANSPORT=restart` to bypass managed remote resume while the
adapter is unavailable.

## Rejected alternatives

- Relying only on `thread/read`: the response lacks permission settings.
- Silently deleting explicit CLI flags: this reverses user precedence.
- Translating every raw profile to a broad sandbox mode: custom network and
  filesystem rules are not losslessly representable.
- Always using current server defaults: this can silently change the authority
  of a resumed legacy thread.
