# R8-403A / R8-403B: branch-pane runtime-usage 403 — implemented and tested

Date: 2026-06-29
Supersedes the "open, no owner" disposition of R8-403A in
`docs/research/014-p0-canary-cross-host-reverification.md` §5.

## Defect
After the P0 branch-ownership cutover, forked slice panes authenticate
`/api/runtime-usage` with a `br_exec_*` branch key. The gateway's
`auth_context` only minted an `Api` owner for keys matching the literal
`api_` prefix, so branch panes received 403 "missing owner context" and
their native usage reports were silently dropped (journal evidence
`runtime_usage=403` in the old-host canary log). The fix required by the
P0 audit (receipt 011 §4: "branch keys get a usable owner context") was
implemented.

## Fix
`crates/mcp-gateway/src/auth.rs::auth_context` now accepts a second
`prefixes` argument. The runtime-usage route passes `["api_", "br_exec_"]`:
`br_exec_` keys resolve to an `Owner` auth context (kind "owner", id
"branch-usage"), mirroring the `api_` behavior. The branch key still
carries full identity for the journal (`client_id` = the branch session
id), so branch usage is attributable per pane. All other routes keep the
strict `api_` prefix (sessions, runs, approvals, health/key) — the
narrow widening is scoped to the usage sink and covered by a regression
test (`runtime usage route accepts api_ and br_exec_ keys but not other
prefixes`, asserting 200/200/401/401 for api_/br_exec_/owner_/plain).

## Verification
- `cargo test -p statewright-gateway` — 134/134 (new regression included;
  the pre-existing 403 failure became green).
- The P0 E2E canary (`scripts/canary-gateway-pb-p0.sh`) re-asserts
  `native_usage_seq=[1-9]` in the session log, and the workflow
  `opt-slice-branching-v1` forks branch panes a/b whose usage reports flow
  through the fixed route.
