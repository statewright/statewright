# ADR 003: Bound managed Codex resume ownership to the usable client lifecycle

Status: Accepted

## Context

Statewright's restart transport launches an interactive Codex process in its
own process group so model-route restarts can terminate every descendant.
Termination forwarding was installed only for one-shot `codex exec` runs and
did not handle `SIGHUP`. When tmux disappeared, the supervisor could exit while
the detached Codex process survived with revoked terminal descriptors and kept
the native per-thread writer lock indefinitely.

The App Server transport has a related bounded-lifetime problem. Codex keeps an
unsubscribed thread loaded for up to thirty minutes. A resident App Server that
outlives its last TUI therefore retains the writer during that grace period,
even after a detached turn has completed. Starting a different resident and
selecting the same thread fails correctly with `already has an active writer`.

Codex persists each thread's `cwd`, and `thread/list` supports an exact `cwd`
filter. Native `codex resume` is directory-scoped unless `--all` is explicit,
but a TUI connected through the managed remote App Server did not supply that
local filter. The resulting global picker amplified generic continuation
previews from older restart-based sessions and made the intended project hard
to identify.

## Decision

Statewright keeps Codex's native writer exclusion intact and changes only the
managed process and transport lifecycle:

- Every restart-transport child receives scoped `SIGINT`, `SIGTERM`, and, on
  POSIX, `SIGHUP` forwarding. A terminal-loss signal is sent to the owned child
  process group, followed by the existing bounded `SIGTERM` fallback.
- The resident proxy counts attached TUIs and tracks `thread/status/changed`,
  `turn/started`, and `turn/completed`. When the last TUI disconnects from an
  idle resident, the resident retires after a short bounded grace period and
  closes its App Server, managed MCP bridge, temporary home, and manifest.
- If the TUI disconnects while a turn is active, the proxy keeps that upstream
  connection open as a monitor. The resident retires only after the turn becomes
  non-active, preserving Codex's advertised detached-work behavior.
- An unqualified managed `thread/list` request receives the invocation's
  canonical working directory. An explicit request `cwd` is preserved. When
  the user passes `--all`, Statewright supplies no default filter, leaving the
  native all-project picker and its CWD column authoritative.
- A live resident is never replaced merely because a new invocation requests a
  different runtime revision or picker scope. Statewright refuses that launch
  until the resident retires, because it may be preserving detached work.
- A native `thread/resume` active-writer refusal remains a refusal with its
  original error code and diagnostic. The managed proxy adds guidance to wait a
  minute or two for a background turn to finish and retry, followed by explicit
  recovery guidance if another client or stale resident continues to own it.
- Retirement keeps the manifest and temporary App Server home until the owned
  App Server has actually closed. Shutdown uses a bounded `SIGTERM` grace and
  escalates only that directly spawned child if it does not exit.

Statewright does not scan for or automatically terminate pre-existing active
writers. A writer observed before this fix may contain buffered work and still
requires an explicit operator recovery decision.

## Security and privacy

Signals target only the process group directly spawned by the current managed
supervisor. The resident never kills a writer owned by another client identity.
The picker filter uses the already-known local working directory and does not
inspect or rewrite prompt text, titles, rollout contents, or session metadata.

## Consequences

- A future tmux loss cannot leave a restart-transport Codex writer detached
  from its Statewright supervisor.
- An idle resident releases the writer promptly, while an active detached turn
  is allowed to finish first.
- A user who retries before detached work finishes receives an actionable wait
  message instead of an unexplained writer-ownership error.
- The default managed resume picker returns to project-local results. Users who
  intentionally choose `--all` retain Codex's native cross-project view and
  directory display.
- Existing orphaned writers and resident processes are not swept by upgrade;
  they remain visible evidence until the operator terminates or reconnects to
  them.

## Validation and review

- The original cross-project resume failures were traced to live Codex
  writer processes with no controlling terminal, rather than a false lock.
- The affected App Server transport file passed 20/20. The complete executor
  suite passed 97/97 with inherited `CODEX_HOME` and
  `CODEX_SQLITE_HOME` cleared so its temporary storage fixtures were
  authoritative.
- Generated Claude runtime parity and `git diff --check` passed.
- Three fresh read-only reviews rejected earlier cuts for lifecycle races. Each
  finding received a regression test and repair. A fourth fresh review approved
  the original lifecycle cut. A later independent review of the active-writer
  guidance found no material implementation issue; its provenance and negative-
  path coverage findings were repaired and revalidated.
- Protocol and picker behavior were checked against the official
  [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
  and [Codex App Server reference](https://learn.chatgpt.com/docs/app-server).

## Rollback

Revert the supervisor signal forwarding and App Server proxy lifecycle changes,
then synchronize the generated Claude runtime. Setting
`STATEWRIGHT_CODEX_TRANSPORT=restart` bypasses the resident path; disabling the
managed Codex client bypasses both paths. Rollback restores Codex's native
thirty-minute App Server unload grace and the prior remote picker behavior.

## Rejected alternatives

- Weakening or bypassing the native writer lock would permit concurrent rollout
  mutation and corrupt the exact safety boundary that diagnosed this failure.
- Automatically killing any process with no controlling TTY could terminate a
  valid detached turn or another supervisor's client.
- Keying resident identity only by `cwd` would merge concurrent sessions in the
  same checkout and break Statewright's per-client isolation.
- Rewriting generic continuation prompts or historical thread titles would
  mutate user history without fixing the global picker or writer lifecycle.
