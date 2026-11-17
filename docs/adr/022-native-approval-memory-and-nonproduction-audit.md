# Native approval memory and nonproduction audit

Status: source implementation; installed/native and staging acceptance pending.

## Decision

The workflow selects the duration with `meta.approval_memory.approve_for`:
`once`, `2h`, `4h`, `8h`, or `always`. The default is `once`. If
`allowed_durations` is present, the selected duration must be included. The
existing native Allow/Deny/Cancel dialog states the effective duration, and a
plain Allow records it without requiring a custom dialog field. Incomplete
dependency provenance or an unavailable approval store limits the prompt to once
and explains why. This does not decide native platform permissions or
workflow-transition reviews.

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

## Amendment (draft, 2026-11-16): production audit behind an explicit kill switch

Status: Proposed — not accepted. This amendment prepares a default-off source
gate; it does not approve production audit or change the production deployment.
The nonproduction decision above remains in force unless this amendment is
accepted and the separate go-live gates are completed.

Production may admit pinned `meta.classifier_audit.mode: audit` only when the
trusted gateway deployment sets exactly `STATEWRIGHT_ENV=production` and
`STATEWRIGHT_CLASSIFIER_AUDIT_ENABLED=true`, and provisions a valid private
`STATEWRIGHT_CLASSIFIER_AUDIT_DIR`. The environment and switch come from the
gateway process, never workflow JSON. Environment alone does not enable audit.
An unset switch or any value other than exact lowercase `true` rejects audit
configuration and keeps enforcement; `prod`, `Production`, and `PRODUCTION`
remain invalid environment names. Turning the deployment switch off and
restarting or replacing gateway processes restores enforcement. The gateway
reads deployment variables at process construction, so editing an already
running process's ambient environment is not a live toggle.

The MCP `statewright_set_classifier_audit` tool remains hidden and rejects
direct calls in production even when the switch is on. Production opt-in must
come from pinned workflow metadata plus the deployment switch, never a mid-run
override. Staging and dev/dev1/dev2/dev3 retain their existing behavior without
requiring the switch, so this amendment does not break staging audit.

Audit still cannot bypass known risk, explicit denials, workflow policy or
scope, required human review, or host permissions. A missing or invalid private
intake directory or persistence failure keeps the command blocked. Intake has
no raw argv; cases remain unlabelled and excluded from accuracy metrics until
separate human review.

Before an owner can approve go-live, prepare and review the production overlay
(private PVC, initContainer and environment), pin the gateway image to a build
accepted in staging, define intake-file retention and rotation, approve privacy
copy and volume access control, and obtain the owner's explicit OK. None of
those deployment or operational steps is completed by this amendment.
