# Engineering workflow and classifier escalation repair

Status: workflow stored through the advertised local Statewright API and read
back exactly; gateway/plugin changes are isolated source preparation.

## Workflow delivered

The exact stored `agentic-engineering-v2` definition was read before editing.
Its prior definition is saved alongside this receipt as
`agentic-engineering-v2-before-20261107.json`. Source was reconciled into
`<workflow-source>/workflows/agentic-engineering-v2.json`, replacing that
file's stale candidate with the current stored definition plus owned changes.

Ordinary engineering phases omit the finite tool allowlist. Design presence
gates, commit closeout and its verification/finalization retain their original
narrow tool controls. Phase instructions continue to constrain source edits.
The context now accurately states that general tool access is not a source-edit
security sandbox. Existing guards, transition edges and iteration bounds are
unchanged. Explicit denials and independent approvals remain in force.

Routine Terra and Sol routes use `gpt-6.1-terra` and `gpt-6.1-sol`; frontier
design/review keep `gpt-6-astra`. IDs and low/medium/high efforts were checked
against this owner's installed `models_cache.json`. The native traits lookup
was denied as semantic_authorization_disabled and was not replayed. Current
official guidance was fetched at https://learn.chatgpt.com/docs/models?surface=cli.

The ordinary implementation path has 10 Terra, one Sol and two Astra state
entries. Decision/reconcile/retry paths consume additional entries; existing
per-state bounds do not prove a finite global retry budget. Context budgets
remain observed-only. No price, quota conversion or hard token cap is inferred.

Strict workflow lint passed with zero errors and zero warnings. Publication
used `statewright_create_workflow(overwrite=true)` through the local connector;
a fresh `statewright_get_workflow` matched the candidate exactly. It was not
loaded or activated. Existing terminal run provenance was not edited.

Workflow source SHA256:
`be2eaf47ef89797e088634a2fd98b184fb47ce186432bbc6c4b85f3ff61ffe10`.

## Runtime source candidate

Base: `2346d45348a02f865ea84d4bbe54228bc151f950`, in the clean linked preparation
worktree `/Volumes/sidecar/.agent-worktrees/statewright-classifier-forward-20261107`.
The earlier provider-middleware worktree is separate and is not part of this patch.
No canonical Statewright runtime bytes or existing staged work were overwritten.

The older canonical main checkout did not contain the actual approval-policy
predicate. The staging integration source did: its approval preflight rejected
every `allowed_tools` list and every nonempty `disallowed_tools` list, regardless
of which tool was requested. That explains the previously observed
workflow_approval_policy / independent_workflow_policy_clearance receipt shape;
this is source correspondence, not a newly measured deployed digest.

The candidate checks admitted tool identity (with deterministic native alias and
registered metadata normalization) before semantic dispatch. It does not invoke
the semantic provider for a rejected tool. Admitted unknown calls can reach
classifier approval even under a tool allowlist. Explicit effect restrictions,
read-only intent, known missing capabilities and independent workflow approval
still stop them. With no capability allowlist, ordinary bounded local execution
follows general admission; bounded Git closeout retains its explicit grant.

The native classifier approval controller defaults to immediate human review,
with no required rewriting detour. An explicitly configured legacy rewrite
budget remains supported. Approval stays bound to the owner, thread, run,
session, state epoch and invocation fingerprint and is revalidated on acceptance.
Timeout, decline, cancellation, disconnect and ownership/state drift do not grant
execution. Runtime fingerprints include the changed bridge/evidence modules.

## Command references

The native bridge searches installed man sections and static help caches for
each supported literal invocation, including subcommand-specific documents.
It does not spawn binaries, plugins, shell formatters, or `--help` handlers.
The optional `STATEWRIGHT_COMMAND_REFERENCE_ROOTS` adds static documentation
roots. Names are literal; flag values are not treated as regular expressions.

Bounded excerpts carry document hashes, source names, line numbers and
missing/truncation markers. Unproved version matching is explicitly unverified.
Dynamic/unsupported shell shapes remain missing evidence. Script descriptions
and help text are not proof of their transitive behavior.

The gateway checks original command/tool binding, freshness, entry coverage and
size limits. Only the explicit local Laya request receives reference content;
hosted TypeSafe/OpenAI-compatible requests do not inherit it. The prompt marks
it as untrusted reference data rather than instructions or permission.

Laya remains evaluation-only. The existing measurement packet reports that its
tested configurations failed the enforcement contract. Documentation enrichment
does not establish calibration or grant model-derived execution authority.
Unresolved effects therefore retain the supported human-approval path.

## Executed validation and retained failures

- Gateway library: 458 passed, zero failed, seven ignored on the source including
  tool-admission ordering, approval compatibility and local-only reference tests.
- Bridge/controller/approval-proxy/reference tests: 32 passed, zero failed or
  skipped. These use mock native WebSocket peers and loopback HTTP, not visible
  TUI approval or real Laya inference.
- Workflow strict lint: zero errors/warnings; stored-definition read-back matched.
- App Server transport/hard-interrupt suite: 150 passed, zero failed, cancelled
  or skipped, after the resident fingerprint change. These are local fixtures,
  not installed native acceptance.
- `git diff --check`: passed.

Intermediate failures are not claimed as passes: Rust rejected a private field
access and then a borrowed/owned string mismatch; the first full suite exposed
native alias/registered metadata projection regressions and old expectation
changes; the stronger bridge fixture initially omitted its new telemetry event.
Those were corrected before the fresh passing checks above. Existing compiler
warnings remain. The complete native-payload reference test observes the real
semantic worker's loopback request and confirms it remains non-authoritative;
it is not a real checkpoint quality evaluation.

Tracked runtime diff SHA256 (Git binary diff against the base):
`ee67347367884a2fac34ce8d77b3bf5544400740f2306ae006eeb2c3f2eeb27d`.
New command-reference module SHA256:
`4d432d682e8d95ebb3fa65fb250a6d950d3abd572f35728442595d14ec980681`.
New command-reference test SHA256:
`0d27f8a38a0bb5a94f5b208f05912aba0177acc54613cd1f159cb6905f0febbb`.
Saved original stored workflow SHA256:
`2942913aebd6bebef38688239e7f0abdbd477ad08969af65201b012afff08ef5`.
The receipt itself and this saved definition are untracked evidence artifacts;
the runtime diff digest alone does not describe these or other new files.
Initial hash invocations failed because Perl could not use the inherited locale;
the successful checks above explicitly selected locale C.

## Remaining delivery and rollback

No gateway deployment, plugin install, resident reload, visible native approval,
real Laya call or re-execution of the denied sync command occurred. Generated
plugin copies still need the normal coordinated packaging step and source/hash
checks before install. The prior provider-middleware generator invocation
(`node plugins/codex/scripts/sync-executor-core.mjs`, in the separate provider
preparation worktree) was rejected with
independent_workflow_policy_clearance / separate_approval_allowed=false; it has
not been retried or replicated through another executable. No generator was
attempted for this new classifier candidate; do not report that historical
rejection as a fresh rejection of this candidate.

The workflow-only rollback is the exact saved original definition through the
same local create-workflow API. Runtime source rollback is to the named base in
the isolated worktree, preserving its patch; no destructive reset is required.
Before delivery, reconcile intended staging placement, generate and review one
matched plugin/gateway candidate, and test the installed native approve/deny/
cancel path. Nothing here changes credentials, hooks trust, global flags,
classifier thresholds, production infrastructure or the Laya authority switch.
