# ADR 018: Provenance-aware tool intent and bounded workflow risk policy

## Status

Accepted for staging validation. Production remains unchanged.

## Context

The gateway previously inferred native tool intent in more than one place.
Those tables drifted: one adapter spelling could be admitted as a local write
while a case variant or another supported editor spelling became an unknown
effect. Shell commands had a similar failure mode when an already-reviewed AST
classifier was omitted from a later staging branch. System One still returned
probabilities, but incomplete structural evidence prevented those probabilities
from authorizing the operation and the denial did not say which axis failed.

This produced command-by-command repairs and encouraged equivalent retries.
It also made workflow authors unable to declare whether a state should accept
only proven reads, deterministic local writes, or assessed bounded local
effects.

## Decision

1. Define one native tool-intent resolver shared by deterministic risk
   assessment and capability enforcement. It normalizes only explicitly
   supported native adapter aliases and case variants.
2. Require trusted native-adapter provenance before that resolver grants local
   intent. A same-named upstream MCP operation remains remote/registered and
   cannot inherit native authority by string collision.
3. Preserve Bash AST authority as the structural source for compound commands.
   Known destructive, external, account, irreversible, and non-local effects
   remain monotonic and cannot be downgraded by System One.
4. Add `classifier_policy.risk_tolerance` at workflow metadata and state scope.
   State scope overrides workflow scope. Supported values are:
   - `low_local`: structurally proven local reads only;
   - `moderate_local`: proven reads and deterministic local writes;
   - `assessed_moderate_local`: the existing calibrated System One path may
     resolve uncertainty to a bounded local read or reversible local write.
5. Keep `assessed_moderate_local` as the compatibility default. No tolerance
   admits a known high/critical, destructive, external, irreversible, or
   account effect; those require their existing explicit authority path.
6. Return a redacted decision receipt containing the resolved effect,
   resolution basis, final denial basis, final required authority, semantic
   status/vector, and whether an equivalent retry is allowed. The Codex hook
   renders those bounded fields into its denial reason because the raw gateway
   object is not otherwise visible to the model. Never include command text,
   paths, payloads, heredoc contents, credentials, or source code.
   Reworkable uncertain denials set `reformulation_allowed=true` and retain
   `equivalent_retry_allowed=true` for adapter compatibility, while
   `exact_invocation_retry_allowed=false` makes clear that the same denied
   invocation must not be replayed. Known-risk and workflow-capability denials
   keep all retry/reformulation fields false.
7. Treat simple local directory creation as a deterministic local write and
   retain delegated commands such as arbitrary Taskfile targets as unresolved
   until their manifest or an equivalent typed declaration is inspected.

## Alternatives considered

- **Expand regular expressions and alias lists independently.** Rejected
  because it recreates the drift that caused the incident.
- **Let System One authorize from probabilities alone.** Rejected because a
  confident semantic guess cannot replace missing provenance or structural
  evidence.
- **Trust all tools whose names resemble editors.** Rejected because an
  upstream MCP server could collide with a native name and gain local write
  authority.
- **Allow arbitrary `task` targets as local writes.** Rejected until target
  bodies can be resolved; Taskfile targets may deploy, delete, or contact
  external systems.

## Consequences

Workflow authors can narrow or select the existing bounded local classifier
path without weakening global safety. Agents receive enough redacted evidence
to reformulate a request on the failed axis instead of retrying the same
operation through another executable. Adding a new native editor spelling now
requires one resolver change and cross-boundary tests.

The gateway still needs a typed delegated-command resolver for Taskfile and
similar manifests. Until then, unknown targets remain conservative rather than
being mislabeled safe.

### Local structural evidence extension (2026-10-02)

The native Codex hook and executor adapter can now collect
`statewright/local-command-evidence/v1` before requesting admission. Collection
reads bounded local manifest bytes without executing Task, npm, templates, or
test code. Static Taskfile dependencies and package pre/main/post scripts are
expanded; dynamic globals, includes, environment overrides, configuration,
cycles, symlink escapes, unknown schema fields, and unsupported arguments remain
unresolved. A local Vitest binary can resolve bare npx only after checking its
package/bin binding and excluding npm's earlier package-owned-bin/workspace
branches. This does not make all npx invocations safe.

Evidence travels separately from model-authored tool input. The gateway checks
schema, command, tool, cwd, timestamp, bounds and permitted normalizations before
classifying every expanded unit and combining capabilities. Registered upstream
tools cannot inherit this evidence. Raw evidence never enters System One or
visible receipts. Hashes record local observations, not independent remote
verification or cryptographic attestation. The authenticated native adapter and
local OS account are trusted; protection against malicious same-user tampering
and arbitrary effects inside repository test code is outside this boundary.
Ordinary file changes during collection are detected; execution is not an atomic
filesystem snapshot. Existing workflow ownership, risk and approval gates remain.

The inspected Nomad Taskfile has a dynamic global VERSION shell variable and
environment references, so it remains unresolved under this static contract.
Reporting that limitation is required; classifying only its Vitest body would
hide a possible `.version` write. Missing/malformed/stale evidence cannot authorize
an opaque command. Source tests, bundle synchronization and deployment evidence
are separate release gates.

## Rollout and rollback

The change must be committed and independently reviewed before staging. The
staging artifact must identify the exact reviewed source revision and pass the
native-alias, shell-AST, structured-denial, OAuth, and source-annotation
canaries. Production is excluded.

Rollback restores the preceding staging digest. Disabling AST authority returns
shell decisions to the legacy path; removing workflow `classifier_policy`
metadata returns to the compatibility default.
