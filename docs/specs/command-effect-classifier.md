# Command effect classifier

Status: accepted source implementation plan, 2026-11-08.
Owner: current classifier source writer. Base: `0f69254`.
Related evidence: research reports038,040–043; ADRs014,017–019 and
`decisions/execution-structure-and-remote-reads.md`.

## Objective and acceptance

Reduce unnecessary holds below10% of known-permitted invocations without
increasing automatic admission of forbidden or unresolved operations. Read,
Write and Destroy are the effects visible to workflow authors. Code composes
evidence and applies the allowed set; a semantic provider supplies facts about
an operation, never permission to execute it.

The frozen extension cohort has269 Read+Write-permitted cases,24 forbidden
cases and71 unresolved cases. The deterministic source projection holds194/269
(72.12%); the target permits at most26 holds. At least168 of the194 current
holds must be correctly resolved. The original labels, denominators and failed
receipts remain immutable. New label concerns receive an erratum and a separate
version; they do not retroactively improve this result.

Fresh analysis of the recorded v5 replays found194 syntactically valid held
commands and zero complete effect proofs among them. All194 have at least one
`leaf_effect_evidence_missing` component;25 also have unsupported AST nodes.
The labels assign133 Read,17 no persistent resource effect,18 Write and26
Read+Write. These are development labels, not independently adjudicated truth.
The194 cases contain289 unresolved command components. Component/family counts
overlap and cannot be added to predict the benefit of a proposed repair.

Current decision bases are176 `semantic_authorization_disabled`,9
`external_effect_unresolved`, and9 `effective_known_risk`. The baseline replay
explicitly disables semantic authority; the prior separate model experiments
did not qualify a useful fallback. This number is a deterministic source
capability projection, not a measured installed or production rejection rate.

Final acceptance requires both the frozen development comparison and a separate
family/composition holdout to have under10% holds on known-permitted cases.
Every forbidden admission and unresolved admission is reported separately.
Approvals and remembered approvals do not count as correct automatic decisions.
The current24 forbidden cases cannot establish a1% escape-rate guarantee.

## Resource effects

One versioned Rust contract owns these definitions and bit values:

| Effect | Bit | Meaning |
| --- | --- | --- |
| Read |1| Observe existing resource content, metadata or externally visible state. |
| Write |2| Create or update resources, including ordinary content replacement, rename, permission and configuration changes. |
| Destroy |4| Remove resources or explicitly discard/reset managed state, including resource termination and explicit erasure. |

Pure literal/stdin transformations and ordinary stdout have no persistent
resource effect. Descriptor duplication and literal null sinks add no resource
write. Command-scoped cwd/environment changes are execution context and can
affect later components; they do not automatically imply persistent Write.
Persistent settings, long-lived managed sessions and external process changes
retain their actual effects. Resource/time exhaustion remains a separate limit.

Ordinary overwrite is Write. Explicit wiping/truncation/reset/destruction is
Destroy. Reversibility is consequence metadata rather than a prerequisite for
every Write. Reading an external target remains Read. Location, target identity,
sensitivity, privilege, execution authority and explicit policy denials are
independent gates. An effect match never grants those authorities.

The v2 six-score provider contract remains legacy until its replacement has
completed validation. Its definition of overwrite as destruction and its
reversible-write admission branch are incompatible with this specification.
Do not silently reinterpret old scores as probabilities under the new contract.

## Evidence and decision rules

For each executable AST component and resource redirect, preserve:

- Stable component identity, source byte span, parent/context and execution location.
- Executable/subcommands and argv with original quoting/expansion provenance,
  empty arguments, option/value bindings and the end-of-options marker.
- Effect lower and upper bounds, evidence status/reason, missing facts and
  provenance of every contributing source. Syntax and semantic completeness
  are distinct; a valid AST is not proof of known behavior.
- Referenced script/manifest/configuration identity and bytes digest where
  relevant, with collection time, effective cwd, limits and freshness checks.

Compose sequential, conditional, pipeline, substitution and delegated effects
conservatively across all potentially executed children. Unknown children remain
visible. A safe companion never erases a known write/destroy or unknown child.
Known command output becomes an operand only when its argument role is bound;
unquoted glob/parameter output must not be treated as literal option-free argv.

Given effect bounds `lower ⊆ actual ⊆ upper` and phase permissions `allowed`:

1. `lower` containing a forbidden effect is incompatible.
2. `upper ⊆ allowed` establishes effect compatibility. Ambiguity between Read
   and Write therefore does not require a model when both are allowed.
3. Otherwise effects remain unresolved and require more evidence or the
   existing human approval path.
4. Compatibility is followed by provenance, authority, scope, sensitivity,
   identity, explicit-denial and runtime-limit checks. Even Read|Write|Destroy
   cannot authorize an unavailable script or unknown target by itself.

Malformed masks/bounds are invalid evidence. An unavailable or failed provider
cannot manufacture empty effects. Do not multiply independent score estimates
or demand a high probability for one exclusive class when several classes are
permitted. Probability reconciliation requires an explicitly calibrated contract.

## Deterministic semantics and context

Replace the read-only-only leaf adapter with complete effect-envelope adapters.
The generic core owns AST composition, evidence bounds and permission matching.
Utility knowledge lives in reusable operation/argument contracts, not a growing
core executable allowlist or substring exceptions.

Track cwd/environment effects in execution order. Preserve branches where the
effective context cannot be uniquely established. Resolve available package
scripts and their pre/post hooks through the existing native evidence collector.
An unavailable body remains unavailable; a test/build name is not a safety proof.
Native collection and validation reuse existing authenticated adapter bindings.

Remote launchers retain target and wrapper authority while exposing their inner
argv/program as child evidence. `kubectl exec … -- cat file` has an inner Read
candidate plus a remote execution boundary. It is not automatically granted
Read merely by removing the wrapper. The same rule applies to shell interpreters,
container launchers, SSH and `xargs`/`find` delegation.

Known default behavior, option arity, effect-changing flags, redirections and
execution-bearing values must be accounted for. Missing a reviewed option is
missing semantics, not evidence that a whole command is destructive.

## Local semantic provider

Ask only for missing behavior facts about bounded components. Inputs include
the actual relevant subcommand/flags/values, argument roles, execution context,
existing effects, available source and explicit evidence-loss markers. The local
provider must not receive a draft truth label or expected permission decision.

Use available trusted version-matched help/man/schema excerpts and relevant
script/configuration bytes as reference data. Bind references to their source,
version and spans; preserve truncation, ambiguity, missing defaults, aliases,
negation and interactions. Retrieval is static/in-process where possible and
must not execute unknown binaries/plugins or mined commands to obtain `--help`.
Reference text cannot override instructions or confer authority. Private argv,
credentials and private script bytes are not sent to hosted providers.

Separate source facts from model judgments. Laya must demonstrate additional
correct coverage under the actual Rust policy. If it cannot, compare another
candidate on the same bounded fact task before adoption. Do not assume a larger
model, a different prompt or lower cutoffs will solve this. Raw provider scores
are not calibrated probabilities; preserve model/input/question/runtime identity
with any fitted calibration artifact. Drift invalidates calibration.

## Diagnostic and evaluation sequence

### M1: contract and policy ceiling

Create the shared typed resource-effect contract, bounds validation and subset
decision. Add a test-only diagnostic using the real Rust resolver. For the frozen
corpus compare:

1. Actual deterministic source projection.
2. Legacy resolver supplied an optimistic six-score vector derived from known
   effect labels, retaining actual structural evidence and risk/scope gates.
3. New effect-subset decision supplied exact known effect labels under the
   corpus's explicit fixture scope assumptions.

Arms2/3 are counterfactual diagnostic controls, not model predictions, native
authorization, or improved classifier measurements. Legacy reversibility/local
assumptions needed by arm2 must be named optimistic rather than claimed observed.
Unknown labels supply no oracle vector. No invocation executes; no provider is
called; no process-wide authority/mode setting is changed. Only test builds may
consume draft labels as facts. Production APIs must not accept oracle metadata.

Capture individual denial bases and aggregate counts, binding input/source
bytes and preserving private-local handling. Characterize policy blockers with
correct supplied facts before changing additional semantic adapters or prompts.

### M2: full component evidence and policy integration

Carry full typed envelopes from deterministic adapters and native collection
through every reducer. Apply the shared effect contract before admission and
keep the existing independent authority checks. Add regressions for allowed-set
monotonicity, mixed reads/writes, overwrite versus erasure, context, redirects,
empty argv, wrappers, unknown children and explicit denials. Retain existing
native provenance, replay/expiry and owner/session boundaries.

### M3: missing-fact evaluation and calibration

Freeze family/composition-separated tuning and held-out cohorts. Independently
adjudicate labels and ambiguity rules. Compare heuristics, heuristics plus
component facts, and heuristics plus the actual model. Use a supplied-correct-fact
control to distinguish model errors from upstream evidence or policy defects.
Fit calibration only on tuning data. No cutoff selection on the held-out result.
Measure useful incremental coverage, permitted holds, forbidden admissions,
unknown admissions/abstentions, truncation, latency and resource consumption.

Expand forbidden negatives substantially. Roughly300 independent negative
observations with zero errors would be needed for a one-sided95% binomial bound
near1%; sibling commands and repeated flags are not independent population proof.
Keep unknown delegation, forged metadata and changed execution context negatives.

### M4: coherent delivery

Only a reviewed complete candidate that meets the source gates proceeds to
coordinated packaging and staging/native acceptance. Verify the same policy
through standalone/native/managed adapters, actual human fallback, expired and
revoked approval handling, and source/package/installed/runtime identity.
Deployment/production promotion remains a separate authorized boundary.

## Approval memory

Approval memory is a follow-on usability feature with once,2h,4h,8h and revocable
permanent grants subject to workflow configuration. Bind grants to invocation,
project/target, principal, policy and relevant script/configuration identities.
Changed facts and explicit denials invalidate reuse. Log request/decision/reuse/
expiry/outcome through the existing authenticated server telemetry path with
secret redaction. Measure prompt burden separately from automatic classification.

## Working contract and rollout

Implementation uses the current clean Sidecar source worktree; unrelated
canonical/index/worktrees are preserved. Native get_state reports no active
workflow. Execution stays shelved under the user's existing instruction while
classifier source is repaired. No workflow, setup, security, feature enablement,
installation or deployment is needed for M1.

Provisional observed-only M1 budget:45min normal/75min contraction,70 normal/100
tool calls, one affected package suite after focused checks, one bounded
independent read-only review. Reserve the final20% for validation, review,
scoped commit and a durable receipt. At contraction, finish the current coherent
slice and record unpassed gates; do not broaden experiments or call M1 the final
under10% improvement. Exact provider token counters are unavailable here.

Spec/diagnostic and implementation receive scoped local commits. Review receives
only the bounded diff, spec and captured evidence; it does not repeat expensive
model runs or full suites. Rollback reverts the owned commits and retains all
baseline/failed/diagnostic receipts. Enabling the new contract requires validated
provider migration; old six-score receipts remain legacy evidence.
