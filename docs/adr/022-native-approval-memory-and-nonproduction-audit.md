# Native approval memory and nonproduction audit

Status: source implementation; installed/native and staging acceptance pending.

## Decision

Offer once, 2h, 4h, 8h and always in the existing native classifier approval
dialog when complete supported dependency provenance permits reuse. A workflow
may restrict durations through `meta.approval_memory.allowed_durations`. Missing
provenance offers once, never a broader fallback. This does not decide native
platform permissions or workflow-transition reviews.

Keep grants in a private local versioned HMAC-authenticated store, bound to the
service/project/client credential namespace, full workflow policy, invocation and
dependency digests. Persist no raw command in the grant. Each reuse requires fresh
gateway context and owner validation and a final expiry/revocation check, then
returns a one-use receipt for the current invocation. Unique lock tickets recover
dead owners without removing a singleton lock that a successor might own.
Authenticated owner-bound list/revoke operations use the existing loopback helper.
Create/reuse/revoke events use the existing server lifecycle telemetry path;
server delivery and retention still require installed acceptance.

`meta.classifier_audit.mode: audit` records uncertain classifier holds before
letting the invocation reach existing host permissions. The server, not workflow
JSON, chooses the environment and durable private capture directory. Only
staging/dev/dev1/dev2/dev3 accept audit configuration. Production and unknown
environments reject it. Explicit restrictions, known risk and workflow reviews
are not bypassed. Audit write failure or stale context denies the invocation.
Generation, transition count and complete policy checks prevent revocation/ABA
or replaced-session races across asynchronous assessment and persistence.

Captures contain bounded structural facts and evidence references, not raw argv.
Simulation ingestion deduplicates evidence while preserving artifact observations.
Cases remain unlabelled, incomplete for command replay, and excluded from accuracy
metrics until separately reviewed. A would-block observation is not a safe label.

## Consequences and rejected alternatives

Always means until revoked or bound evidence changes, not global permission.
Opaque scripts and incomplete dependency contracts still require once. A mere
aggregate source tag or script hash cannot justify reusable authorization.
Local files assume the existing same-user trust boundary; HMAC is not protection
against an adversary able to read/replace both the key and grants.

Do not infer production audit authority from metadata, use expiring process-only
memory, silently approve on telemetry/storage failure, or broaden generic command
allowlists to manufacture recovery. Runtime flags and deployment are unchanged.
Rollback reverts these owned source changes; incompatible or changed policy
digests cannot reuse old grants. Grants can be explicitly revoked before rollback.
