# P0 canary: cross-host (Windows client -> macOS PB) re-verification

> Public excerpt sanitized 2026-10-10; operational details omitted or generalized.
> Historical results below were not rerun for this documentation cleanup.

Date: 2026-06-29 (reconstructed; original run on the old working machine
2026-06-26/27). The original raw logs are not present on this host; the
findings below were carried over as quoted log lines from the prior
session and re-verified on this host where the artifacts exist.

## Setup (as run)
- Companion backend on macOS over loopback (application identity omitted).
- Gateway + Codex CLI + Statewright on Windows, `SW_GATEWAY_MODE=remote`,
  `SW_PB_URL` pointing at the macOS host, API key `sw-canary-key`.
- Workflow `opt-slice-branching-v1` with a `fork` branch session.

## Findings
- F1: streamable MCP session established; gateway accepted the run
  (`run_created`, `run_start_accepted`); the branch key
  `br_exec_0070267d-...` was minted and its branch run accepted; session
  closed cleanly; no gateway panic.
- F2: native usage reports reached the journal
  (`runtime_usage native_usage_seq=1 native_input=13585 native_output=26
  cached_read=... status=completed`).
- F3: **branch-usage 403** — `runtime_usage=403` on the `br_exec_*`
  pane's usage report (old gateway binary lacked branch-key owner
  context). Fixed and tested on this host: receipt 013.
- F4: branch pane ran an App Server turn in the branch session
  (`session_start turn=branch ... model=statewright-state`), proving the
  fork pane executed a full model turn, not just a key handoff.
- F5: the Windows-side `pwsh` execution path was the weak spot; on this
  host the Windows tiers (W0/W1/W2) are re-proven via the in-repo CI
  fixtures and the canary's remote-mode assertions.

## Disposition on this host
- A machine-specific companion backend dependency was not portable. The canary
  gained a fallback to `scripts/canary/pb-reference-server.mjs`, a reference
  PocketBase-compatible server implementing the gateway contract (health,
  key/workflow lookup and approval receipts), seeded with the same
  `opt-slice-branching-v1` machine. This fixture is not live backend acceptance.
- F3 (403): closed by 013.
- The `task test:canary-gateway-pb-p0` target drives this canary; on hosts
  without a reachable PB the reference server keeps the P0 contract live.
