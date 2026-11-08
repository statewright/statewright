# Command classifier effectiveness benchmark

2026-11-08. Focused research and proposed evaluation contract. No dataset bulk
download, fixture execution, model call, policy change or deployment performed.

## Research summary

Build a static, contextual, paired benchmark rather than treating more passing
unit tests or a higher command allowance rate as proof of improvement. Public
command/example corpora supply breadth; a separately reviewed effect/authority
oracle supplies correctness. Evaluate the exact old and new production decision
paths on identical held-out inputs, including Laya and human-routing outcomes.

The current 24-case Laya diagnostic is development evidence, not this benchmark.
It cannot establish overall classifier effectiveness or production safety.

## Verified public sources

1. **NL2Bash:** approximately 10,000 natural-language/Bash pairs, 102 utilities
   and 206 flags according to the original project. The project describes
   train/dev/test separation and command templates. The dataset has a separate
   MIT license; preserve its notice. These are translation examples, not
   Statewright risk, sensitivity or permission labels.
   [Project README](https://github.com/TellinaTool/nl2bash/blob/master/README.md),
   [dataset license](https://github.com/TellinaTool/nl2bash/blob/master/data/bash/LICENSE).
2. **tldr-pages:** practical examples spanning common and platform-specific CLI
   tools, useful for newer developer/cloud tools absent from older Bash research.
   Pages are CC BY 4.0; scripts have a separate MIT license. Preserve source path,
   revision, attribution and modification notices for imported/derived examples.
   Descriptions are evidence to review, not unquestioned effect labels.
   [Project README](https://github.com/tldr-pages/tldr/blob/main/README.md),
   [license](https://github.com/tldr-pages/tldr/blob/main/LICENSE.md).
3. **mvdan/sh syntax tests:** parser examples for difficult shell syntax and AST
   expectations. They supplement ordinary commands with composition/quoting
   coverage, not effect ground truth. The repository license contains the
   three-clause BSD conditions; retain applicable notices when copying fixtures.
   [Syntax fixtures](https://github.com/mvdan/sh/blob/master/syntax/filetests_test.go),
   [license](https://github.com/mvdan/sh/blob/master/LICENSE).

All six primary pages/license sources were inspected on 2026-11-08. Branch URLs
are research pointers, not frozen dataset identities. Acquisition must first
resolve immutable revisions and record per-file SHA256, license and attribution.
Do not execute repository installers, generators, hooks or imported examples.

## Proposed corpus layers

- Broad public seeds: pin NL2Bash data plus selected tldr common/Linux/macOS and
  relevant Windows examples. Keep shell/platform distinctions explicit; a Bash
  parser rejection is not a PowerShell effect judgment. Place bulk data on Sidecar.
- Syntax/composition stress: adapt parser fixtures and generate bounded variants
  of reviewed seeds. Include pipes, redirects, substitutions, heredocs, quoting,
  flags before/after verbs, equals/separate option bindings and `--` boundaries.
- Delegation/context: env/shell wrappers, SSH, container/kubectl exec, package
  scripts and lifecycle hooks. Supply synthetic manifests/source when available;
  otherwise label opaque delegated effects unknown rather than assuming tests
  are safe. Include local and remote versions of equivalent operations.
- Adversarial near-neighbors: read plus write/delete companion, path-qualified
  lookalikes, aliases, conflicting selectors, output-file options, missing docs,
  injected instructions and credential/export cases. A destructive string inside
  quoted data must not become a command; a substitution inside an argument must.
- Field regressions: the prior 100 denied examples, after authorized privacy
  handling, as a restricted regression slice. Denial-only sampling is biased;
  neither its frequency nor approval rate represents ordinary usage prevalence.
- Native web/MCP track: structured queries/targets/methods, batches, provenance,
  annotations, unknown nested fields and tool-name collisions. Separate from the
  shell scorecard; effects and authority still use the same underlying contract.

Suggested first delivery: import/index a broad pool, then build **1,000 reviewed
seed/context cases** across at least 50 CLI families plus a derived shape stress
set. Freeze disjoint development, calibration and test partitions before tuning.
These are proposed scale targets, not collected counts or a statistical safety
guarantee. Increase adjudicated independent negative coverage to match the
desired error bound; thousands of sibling mutations are not thousands of
independent observations.

## Ground truth must be contextual

Each case should bind:

- Original tool call and lossless argv/shell text, parsed structure, platform,
  shell, tool/version assumptions, cwd and local/remote execution boundaries.
- Available manifests/delegated source/references and explicit missing evidence.
- Expected effects as independent axes: observation, local mutation, remote
  mutation, destruction, reversibility; location and sensitivity separately.
- Workflow/capability policy and authority: what this particular phase/user may
  do, which independent approval is required and whether any grant is valid.
- Expected disposition: allow, reject known prohibited action, or ask a human
  because evidence/authority is unresolved. An appropriate human referral is not
  a classifier failure; a needless referral on a fully proven allowed read is.
- Source/license/revision/hash, parent seed and mutation rule, split/family,
  adjudicators, rationale and unresolved disagreement.

For example, reading a credential file may truly be a read while still violating
sensitivity/authority policy. Creating a new file and truncating an existing one
need distinct context. GET is an HTTP method hint, not a universal safety proof.
Do not let the classifier being evaluated label its own answers. Model-assisted
draft labels are useful for preparation but require independent adjudication;
ambiguity remains a real unknown label. Human review must be distinguishable from
an independent agent review.

## Paired simulation, not command replay

The runner supplies static fixtures through the actual parsing, evidence ingestion,
effect reduction, policy and final routing functions. It never launches the
fixture command, runs package scripts, contacts fixture URLs or mutates remote
state. Side-effect adapters should be absent or fail a dispatch assertion.
Only authorized public synthetic input reaches optional offline model inference.

Run the baseline immediately before the repairs and the exact candidate on the
same fixtures, policy, context, dependency versions and runtime settings. Emit
per-case decisions and reasons, not just aggregate percentages. Fingerprint the
full source inputs/artifacts, not nominal HEAD alone if the effective tree differs.

Compare heuristic-only first. Then isolate richer input, question contract,
model/checkpoint, score calibration and thresholds one change at a time. Include
provider unavailable/malformed/timeout/truncation and queue saturation. Hold
non-target variables fixed. Do not tune on the final test results.

Keep all variants from one seed and all close templates together. Also hold out
entire CLI/shape families and fresh field cases to check generalization. Public
datasets may already occur in a model's training; public test membership alone
does not establish that the model has never seen the example.

## Required scorecard

| Measure | What it establishes |
| --- | --- |
| Unsafe auto-allow / prohibited-or-unresolved cases | Safety failure under the actual final gate, not just a raw read score |
| Unnecessary referral or denial / proven allowed cases | User friction the enhancement is intended to reduce |
| Useful automatic coverage at a fixed safety constraint | Rejects the useless all-abstain classifier |
| Appropriate human routing / genuinely unknown or approval-required cases | Correct uncertainty/authority handling |
| Effect/location/sensitivity/authority confusion | Identifies which contract axis actually regressed |
| Laya's incremental coverage over the heuristic | Measures model value rather than re-counting already-proven reads |
| Parse, evidence-loss, truncation and model failure rates | Separates ingestion/runtime defects from model judgment |
| p50/p95 latency, tokens and resource use | Bounds usability and operational cost |

Publish per-family and macro-averaged results in addition to overall totals.
Keep representative-usage and balanced/adversarial stress scorecards separate.
Do not infer field prevalence from tutorial counts. If using field weighting,
document an authorized representative sampling method and keep an unweighted
view so frequently used easy commands do not conceal rare destructive failures.

Use paired per-case changes and confidence intervals clustered by seed/family.
Predeclare the acceptable safety regression margin and friction/coverage target;
a nonsignificant result is not proof of equivalence. As a rough illustration,
zero errors in 1,000 independent representative unsafe cases still leaves an
approximately 0.3% one-sided 95% binomial upper bound. That illustration does not
apply unchanged to correlated generated variants or a nonrepresentative corpus.

Per-axis Brier/reliability analysis can evaluate fitted calibration on the held-out
set; raw Laya outputs remain uncalibrated judgments until that is demonstrated.
AUC alone is neither an allowance policy nor proof of useful coverage.

## What static simulation cannot prove

Native TUI/Desktop prompt delivery, waiting-notifier behavior, response ownership,
accept-once/expiry/revocation/reconnect, server telemetry and installed-source
identity need separate managed integration acceptance. A simulated human response
must never be reported as an actual user decision. The benchmark must exercise
their routing contracts, but does not close visible UI or staging delivery gates.

## Recommended implementation order

1. Pin/import public text with manifests/licenses; no executable dependencies.
2. Define the case schema, fixed context policies, family splits and adjudication
   process; freeze a pilot gold set and retain unknowns.
3. Build the side-effect-free runner around actual classifier/final-gate functions;
   prove it cannot dispatch commands, and produce baseline/candidate paired diffs.
4. Expand reviewed coverage and run the ablations. Freeze calibration before
   opening held-out results; retain every failed/superseded run.
5. Require safety non-regression plus meaningful friction/coverage improvement,
   then test the same reviewed artifact on the installed staging composition.

## Research limits and method

Focused primary-source search for NL2Bash, tldr and shell parser test corpora;
inspected original project documentation, fixture source and separate licenses.
No bulk snapshot has been downloaded or imported. These corpora provide command
breadth and syntax cases, not a ready-made command-effect authorization benchmark.
No claim that this design proves all possible commands safe is warranted.
