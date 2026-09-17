# Explicit executor session ownership

Date: 2026-09-17. Status: accepted for local implementation; live acceptance held.

## Context and evidence

The executor at `770b68c7fa992daaa1310f334bd42b10fe3b577b` minted a fresh
`br_exec_*` transport and host UUID on each invocation. The gateway's paused-run
lookup requires the same owner, session, workflow and project. A project-only
journal is insufficient to select one of multiple native/run owners.

The installed `@mariozechner/pi-coding-agent` is 0.73.0. Its public
`SessionManager` is exported by `dist/index.js`. `dist/cli/args.js` supports
`--session`, not `--session-id`. `dist/main.js` resolves partial IDs across
projects. `dist/core/session-manager.js` recreates invalid headers and skips
malformed JSONL entries. Evidence is the local dependency source, not provider
inference. Repository peer dependency remains wildcard; this is not a dependency
pinning claim. Native v3 files are the only currently accepted format.

## Decision

- Give every executor run an explicit UUID, printed for the operator. Resume
  requires `--executor-session-id <uuid>`; never discover the latest run.
- Persist a versioned private record under `.statewright/executor-sessions`,
  scoped by resolved checkout, host, workflow, project, gateway and credential
  fingerprint. Store stable authenticated client, negotiated MCP session,
  exact gateway run, native thread and private native file path.
- Own the record with a lifetime exclusive file claim. A second process, corrupt
  record, changed scope or conflicting identity denies before launching a host.
  A dead parent PID does not prove its native writer exited: no lock age takeover.
- Retain the authoritative MCP response session header. Resume must negotiate
  the saved value. State snapshots must match that value and the saved run.
- Reattach an already-active exact owned run through read-only state. Only the
  exact inactive-workflow error permits durable resume. Query `tools/list` for
  the exact `run_id` selector contract before asking an inactive gateway to
  resume. An unsupported gateway fails closed without loading a workflow.
- Extend the existing load tool with an optional exact `run_id` selector. It is
  valid only with `resume=true` and without a branch. Existing owner/session/
  workflow/project filters still apply; no match creates no run. Legacy callers
  without a selector retain existing latest-paused behavior.
- Use the installed public Pi SDK at the Pi package boundary to create a new
  private native v3 header, durably persist it, then launch with the exact path.
  Validate existing identity and JSONL before letting Pi open it. Do not invent
  provider turns or use private SDK imports. Reject host flags that retarget
  native selection. Preserve OMX's unrelated `-c` configuration option.
- Include explicit executor identity in its journal namespace. Preserve both
  previously known ambiguous executor namespaces and deny automatic adoption
  or bypass. No migration deletes a pending approval.
  Ownership, transport and owned-journal identity use the same canonical gateway
  endpoint. Owned journals carry an `exec_owned_` discriminator. Raw-URL legacy
  hashes are opaque, so a bounded local journal inventory denies same-workflow
  legacy checkpoints/claims even through URL aliases. Unknown corrupt inventory
  requires recovery. This can conservatively hold another project's same-named
  workflow; it never selects, migrates or deletes that project's checkpoint.

## Alternatives and consequences

Fresh transport IDs, newest-session discovery, project-only adoption, client-ID
tool overrides and lock-age recovery were rejected because they do not prove
ownership. Passing a Pi UUID to `--session` was rejected because cross-project
partial-ID search is not an exact native boundary. Raw `--session-id` was
rejected because the installed parser does not recognize it.

The record contains no raw API key. Changing credentials or gateway scope cannot
auto-adopt an old record. Credential rotation, partial creation, dead claims and
legacy checkpoint recovery require explicit ownership proof; no recovery UI or
automatic takeover is implemented here. Claims are local-filesystem boundaries,
not protection from a user able to rewrite private storage.

Pi 0.73's first assistant flush appends its bootstrap header even when a private
header already exists. Accept only structurally identical headers with the exact
owned identity; a different header denies. Require a terminal newline, supported
entry payloads, IDs, prior ancestry and a compaction boundary on the compaction's
own prior parent chain before launch. File-only public SDK
fixtures cover first user/assistant flush, reopening and ordinary metadata,
compaction and branch entries. No synthetic assistant entry exists in production
creation; synthetic fixture messages are not vendor-turn acceptance evidence.

Pi, Claude and Cursor support the explicit saved-session launch paths in this
slice. OpenCode and OMX resume are denied until an exact native contract exists;
new invocations retain their launch contracts. Claude/Cursor native restart
behavior is fixture-covered but has no live vendor acceptance claim.

`request_epoch` is reserved at zero; durable input epochs, once-only continuation,
Pi inference parking and replacement-input cancellation are not implemented by
this decision. Approval authority remains the private human decision service.

## Rollout, rollback and revisit

Local coherent commit only. No installed runtime synchronization, push, deploy,
live workflow or real approval operation is authorized. Repository-generated
shared client parity is a separate validation gate. Existing ambiguous storage
is left intact; an operator must prove a mapping before future migration.

Rollback reverts this slice coherently, including tool advertisement. Do not
remove ownership records or locks to make a rollback launch succeed. Revisit
after native-writer liveness/recovery, request epochs, inference parking and
authorized complete pause/decision/resume acceptance are proven. Production
promotion remains held.
