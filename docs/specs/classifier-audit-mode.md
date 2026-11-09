# Workflow classifier audit mode

Workflows opt in through machine metadata:

```json
{"meta":{"classifier_audit":{"mode":"audit"}}}
```

Omission or `{"mode":"enforce"}` preserves ordinary enforcement. The object
accepts only `mode`, and malformed values are configuration errors. The gateway
must validate metadata when loading/resuming a workflow and on invocation; a
configuration error rejects the request rather than silently enabling audit.

The environment comes from the gateway's trusted deployment `STATEWRIGHT_ENV`,
never workflow JSON, command assignments, client arguments or inference. Audit
accepts exactly `staging`, `dev`, `dev1`, `dev2`, and `dev3`. Production, missing,
unknown and differently cased environments reject audit configuration. Additional
development lanes need an explicit reviewed allowlist change.

Audit can advance only a classifier decision of `DenyUncertain`. Known risk,
explicit deny, workflow tool policy, interceptor, capability, scope, required
human review and native platform approval retain independent enforcement. Gateway
guards must freshly clear for the same invocation. Native permissions are recorded
as `deferred_to_host`, not as approved: the existing host gate still decides them.
An unavailable gateway guard cannot be treated as clear. The helper's `RecordBeforeProceeding` result is
a pending persistence action, not an execution authorization.

Before proceeding, the trusted native adapter must durably append a redacted
would-block receipt and a sanitized unlabelled simulation case. Persistence
failure keeps the invocation blocked. Recheck workflow/policy/session/state epoch
and all independent guards after persistence if asynchronous work permits them to
change. Audit must never issue a remembered human approval or silently label a
case permitted. Simulation ingestion deduplicates by keyed invocation digest,
workflow/policy digest and classifier evidence; repeated sightings may increment
an observation count but do not become independent safety labels.

The source helper accepts SHA256 evidence references only. References identify
complete native records for workflow, policy, invocation, classifier decision,
independent guard decisions and native context. Native context binds owner,
principal, project, environment, run/session/state and epoch. Receipts contain no
raw tool arguments, command text, filesystem paths, arbitrary reason messages or
model output. Invocation identifiers use keyed digests where commands may contain
secrets. Raw evidence stays in the trusted local boundary under its existing
retention/access policy, never in generic telemetry or simulation exports.

The native sanitation adapter must parse commands and remove credentials, URL
userinfo/query secrets, environment assignment values, sensitive paths, payloads
and embedded source. If safe sanitation cannot be established, store structural
facts and keyed references only; do not copy raw text as a fallback. Simulation
records carry `unlabelled_pending_review`, provenance references and sanitized
shape. Reviewed labels remain a separate human-controlled operation.

Integration: export `classifier_audit` from the gateway library; parse
`machine.meta.extra` with `AuditConfig::from_workflow_extra` and the trusted
environment; map existing classifier outcomes into the typed enum without
promoting generic authorization failures into uncertainty; pass fresh independent
guard results and native evidence references to `evaluate`; persist both records
before applying `RecordBeforeProceeding`. A test adapter must prove storage failure,
production opt-in, explicit denial and stale-context failures remain blocked.

Focused helper tests: `cargo test -p statewright-mcp-gateway classifier_audit::tests`.
These tests validate the pure policy helper. Gateway/native storage and simulation
ingestion need separate integration evidence before claiming runtime completion.

## Durable native intake store

## In-flight nonproduction control

The MCP tool `statewright_set_classifier_audit` is advertised only when the
server identity is staging/dev/dev1/dev2/dev3. Read `statewright_get_state`, then
send `mode: audit|enforce`, its exact `run_id`, `session_generation`, and
`expected_revision` from `classifier_audit.revision`. Production/unknown reject
direct calls as well as omitting the tool. No active run, terminal runs, foreign
identity, stale revisions, malformed arguments and unavailable audit storage fail.

This is a run-local checkpointed override, not a workflow edit or transition.
New runs start from their pinned metadata. Mode revisions invalidate in-flight
assessments and remembered approval policy bindings, including audit/enforce ABA.
Database-backed reconnect restores the override through the existing owner-bound
checkpoint. The tool explicitly reports `persistent: false` and
`durability: process_memory_only` on non-durable local gateways; checkpoint
serialization tests alone are not database recovery proof. Durable save failure
conditionally rolls back only its own audit fields, preserving newer review,
state and owner changes; callers must re-read state after an error. Explicit workflow limits,
pending human reviews and native platform permissions still apply.

Staging deployment mounts a separate private persistent audit intake; it does
not share application/Postgres data or enable audit by default. The metadata
default remains enforced unless selected by workflow or a bound toggle.

`classifier_audit_store::persist(root, receipt, case)` commits a single versioned
JSON envelope containing both the audit receipt and the simulation intake case.
The trusted server provisions an existing private directory (0700 on Unix) and
supplies its path. Workflow metadata cannot select this root. The store rejects
symlink roots and roots with group/other access, creates a new 0600 pending file,
syncs its contents, publishes a unique UUID `.json` file using a non-overwriting
hard link, and syncs directory changes. Ingestion ignores `.pending` files. A
failed call cannot release the blocked command, even if a synced final record
survives a later cleanup/directory-sync error. Root ancestry must be trusted.

Intake accepts only this bounded structural schema (at most 32 shape leaves,
16KiB input):

```json
{"tool_name":"Bash","command_shape":[{"executable":"other","effect":"unknown","delegates_unknown_effect":true}]}
```

All fields are required and extra keys are rejected. `tool_name` accepts exactly
`Bash`, `bash`, `shell`, `exec_command`, `functions.exec_command`, `mcp`, `other`.
`executable` accepts `git`, `cargo`, `npm`, `node`, `python`, `sed`, `awk`, `rg`,
`grep`, `find`, `cat`, `head`, `tail`, `sort`, `uniq`, `cut`, `tr`, `wc`, `curl`,
`wget`, `ssh`, `shell`, `other`. `effect` accepts `unknown`, `external_unknown`,
`destructive`, `restricted_external`, `other_known_effect`, `read`, `write`,
`execute`, `output`. The native adapter maps all other names to `other` and must
derive these values structurally, never paste arbitrary text into an enum field.

The envelope sets `label:null`, `status:unlabelled_pending_review` and
`replay_ready:false`. Captured structural cases support observation and review;
they are not complete argv replay cases. Full command simulation requires review
of trusted local source evidence and separately approved labelling/sanitization.
Their capture alone establishes neither classifier accuracy nor permittedness.

Focused store tests: `cargo test -p statewright-mcp-gateway classifier_audit_store::tests`.
