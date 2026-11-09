# Resource-effect contract and legacy policy ceiling

2026-11-09. Implements M1 of
[the classifier specification](../specs/command-effect-classifier.md).
Base:`0f69254`. Source-only; no model, command, workflow or deployed setting was
executed/changed by these controls. The classifier's under10% target is unpassed.

## Discriminating result

Supplying optimistic six-score answers to the existing Rust resolver leaves
**175/269 permitted cases held (65.06%)**, versus194/269 with semantic assessment
disabled. The counterfactual resolves only19 additional permitted cases.
Remaining holds comprise157 `incomplete_structural_evidence`,9
`external_effect_unresolved` and9 `effective_known_risk`.

| Cohort | Known permitted | Baseline held | Optimistic-vector held |
| --- | ---: | ---: | ---: |
| Public |115|96|96|
| Private sanitized local |154|98|79|
| Total |269|194|175|

These vectors use draft effect labels and explicitly optimistic reversibility
and external-mutation assumptions in the scores. Actual structural evidence,
deterministic exposure and risk floors are retained. This is an in-memory test
of the production resolver, not measured model performance or authorization.
Unknown labels supply no vector;0/24 forbidden and0/71 unresolved cases enter
the Read+Write candidate set in these controls.

The shared subset contract supplied exact known labels admits all269 permitted
effect sets and rejects24 forbidden/71 unknown labels. That result is a control
with supplied truth and fixture scope assumptions; it is not an improvement in
classifier accuracy and must never appear as such in a release metric.

The structural guard demands either an enabled AST request with certain fields
or a legacy operation label on every segment. In the string-authoritative public
projection, none of the93 semantic-fallthrough holds satisfies that guard. The
score cannot repair missing input/structure. Improving the model before this
input contract would leave the majority of holds intact.

## Source boundary

`resource_effects.rs` owns validated effect masks, lower/upper bounds, resource
definitions, union and subset comparison. The existing AST evidence delegates
its effect compatibility calculation to that shared implementation. Invalid
bits and inconsistent bounds cannot become an admission. Effect compatibility
does not grant provenance, scope or execution authority.

`effect_oracle_diagnostic.rs` is compiled only with `cfg(test)`. It reuses the
existing native deterministic assessment and production resolver without provider
calls or command execution. Inputs are byte-hash bound; receipts contain IDs and
decisions rather than command strings. Private receipts retain their handling
labels, mode0600 on Unix, and the private input directory. Existing outputs are
never overwritten. The production request schema has no oracle/label field.

## Fresh validation

- Shared-contract focused checks:4 passed.
- Affected gateway library:496 passed,0 failed,8 ignored.
- Public and private explicit ceiling diagnostics:one test passed per cohort.
- Independent read-only review:no must-fix finding in the bounded slice; no
  reviewer models, suites or corpora rerun.
- `git diff --check` passed. Native/runtime and deployed validation are unrun.

The added ignored test requires explicit local corpus, expected SHA256 and new
output paths. Its ignored status in the normal suite is intentional; both cohort
invocations ran explicitly and are recorded separately.

## Receipts and next action

Existing Sidecar evaluation roots retain `effect-policy-ceiling-public-20261109-v1.json`
and private `effect-policy-ceiling-20261109-v1.json`, each with input and compiled
source hashes. Their SHA256 values are respectively
`5cc1da681497b91a0efa1f96a05ebcb8fa7d61e13ec637da65bc93b4102f6cd4`
and `f0f1156166b5d3ee65fdc9e5fcc60dc22c7a086a474c2a3d03cb1bfbaed44666`.
The affected-suite log is `statewright-effect-contract-tests-20261109-v1.log`
in the existing build evidence directory. Previous failed and baseline receipts
are unchanged.

Proceed to M2:separate available syntax/argv/source evidence from unresolved
behavior, carry complete local evidence to the semantic task, and use the common
effect-set contract through reducers. Missing script/target authority continues
to require evidence independently. Do not broadly remove the structural guard
or enable the legacy score path to make this counterfactual pass.
