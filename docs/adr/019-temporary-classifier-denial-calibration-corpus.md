# ADR 019: Temporary field corpus for classifier-denied shell commands

## Status

Accepted for staging calibration only. Production capture remains disabled.

## Context

Classifier tuning needs evidence from real commands that the deployed gateway
blocked. A local history sample cannot represent commands seen by other clients
or prove which deployed classifier decision blocked them. Ordinary gateway
telemetry deliberately excludes commands, paths, payloads, and credentials, so
adding raw commands to that stream would silently weaken an established privacy
boundary.

## Decision

1. Capture only denied `statewright_adapter_pre_tool` calls for recognized
   native shell-command tools and only when the final denial basis identifies a
   classifier or workflow-capability decision.
2. Enable capture with the explicit
   `STATEWRIGHT_CLASSIFIER_DENIAL_CAPTURE=true` deployment flag. The initial
   flag is staging-only; absence or any other value keeps capture off.
3. Send a bounded projection directly from the remote gateway to an
   authenticated PocketBase endpoint. It contains the command, session/state
   attribution, classifier fingerprints, the final denial basis, and a
   whitelist of risk fields. It never contains the full tool input, prompt,
   decision reason, response, or arbitrary classifier fields.
4. Store samples in a dedicated `classifier_denial_samples` collection with no
   public list, view, create, update, or delete rules. The endpoint derives the
   owner from the scoped API key and marks every sample `restricted`.
5. Derive `observed_at` and `expires_at` on the server. Expiry is 24 hours after
   receipt, and an hourly retention job deletes expired rows.
6. Deduplicate retries by owner, session, state, invocation fingerprint, and
   final denial basis.
7. Treat capture as diagnostic only. Persistence failure emits a bounded
   warning without command text and never changes or upgrades the authorization
   decision.

## Alternatives considered

- **Mine local Codex history.** Rejected because it is not field evidence and
  cannot be joined reliably to deployed denial receipts.
- **Add commands to normal telemetry or Sentry.** Rejected because those have
  broader access and retention semantics.
- **Enable production capture immediately.** Rejected pending explicit review
  of retention, access, and customer disclosure requirements.
- **Store every pre-tool command.** Rejected because calibration needs false
  positives at the denial boundary, not a general command-history product.

## Consequences

Staging can produce a short-lived, attributable corpus for measuring classifier
false positives without changing authorization behavior or ordinary telemetry.
The corpus can contain secrets already present in a shell command, so access is
restricted and retention is intentionally short. It must not be treated as a
durable audit log.

## Rollout and rollback

Deploy the PocketBase migration and hook before enabling the gateway flag.
Validate authentication, server-derived expiry, field projection,
deduplication, cleanup, and fail-open authorization behavior. Rollback removes
the staging environment flag; existing rows then age out within 24 hours. The
collection and endpoint may be removed after calibration is complete.
