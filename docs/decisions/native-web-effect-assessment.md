# Native web effect assessment

## Decision

Use the same code-owned, per-action evidence for the trusted native `web.run`
heuristic and its domain-specific semantic fallthrough. Do not classify by the
tool name alone or let the approval dialog be the only consumer of request data.
Registered MCP tools with a matching name do not inherit this native contract.

Complete recognized native searches, page observations and structured lookups
resolve deterministically as external reads, subject to independent workflow
capabilities. They do not call a model. Their semantic receipt says `NotRequired`,
not `Disabled`. Unknown fields, missing required inputs, mixed operations or
bounded-evidence loss prevent this read proof.

Unresolved native requests use `native_web_effects/v1` instructions through the
existing provider path and six effect judgments. These distinguish web operands
from instructions, HTTP method hints from effects/authority, and observation from
remote/account mutation. POST is endpoint-dependent; GET is not an authorization.
All leaves matter. Missing evidence is not supplied by a confident score.

## Data and authority boundaries

The hosted projection contains fixed operation/method labels, target kinds,
query presence, completeness and loss markers, not queries or target values.
The existing explicitly loopback-only Laya transport may receive the bounded
local request after credential-field/free-text masking and URL credential,
query-string and fragment removal. Redaction is explicitly marked; it is not
claimed to be complete PII detection. The raw local evidence is skipped by
serialization into intent fingerprints and public receipts. Untrusted operands
are data, never prompt instructions or permission.

This does not enable any provider, change thresholds, or give an experimental
local checkpoint authorization. Current Laya evaluation isolation is preserved.
Unavailable/disabled/ambiguous assessment or incomplete evidence remains eligible
for the existing exact-invocation native human approval only when the final
gateway policy explicitly offers it. Explicit capability and known-risk denials
remain independent and cannot be converted into an approval by this profile.

## Validation and delivery

Static regression first reproduced a nested `open.method: DELETE` being ignored
and classified Low. Tests now cover unknown/mixed fields, required arguments,
bounds, collisions, credential masking, local/hosted separation, actual provider
request bodies using a synthetic loopback server, deterministic no-call routing,
and uncertainty/unavailability with final separate-approval eligibility. A model
fixture is not model calibration, native approval acceptance or deployment proof.

This is source preparation, not runtime delivery. Keep the full coordinated
candidate/release boundary. Rollback is a scoped revert of this source milestone;
no live settings or data migration are introduced.
