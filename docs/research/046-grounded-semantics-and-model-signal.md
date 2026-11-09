# Grounded semantics and model-signal diagnosis

2026-11-09 UTC. Base `c0d49d3`. Source work only; native get_state returned no
active workflow. Execution remains shelved by user instruction. No install,
deployment, workflow action, model enablement or threshold change occurred.
No corpus invocation executed; model inference used only synthetic public data.

## Why performance had not changed

The preceding slice added evidence capture, privacy/completeness handling and
diagnostics while retaining the strict read-only leaf adapter and old resolver.
That did not change the decision path. Richer offline Laya inputs also failed to
provide useful admission scores. Neither was a measured classifier improvement.

User-requested independent Astra/max review identified the bigger missing layer:
an AST describes syntax, not program behavior. The system needs grounded effect
contracts and referenced code, rather than asking a small model to reconstruct
Unix/script semantics from redacted metadata or argv. The live local-provider
projection still omits the literal argument values available in offline fixtures.
Local-only transport migration is unfinished; hosted requests must remain redacted.

The previously captured controls expose separate limits:

- Optimistic legacy score vectors still leave175/269 held;157 structural gates
  reject before useful scores can change the result.
- In the previous public component projection,17/115 permitted parents retain
  non-leaf structural gaps. Even perfect leaf predictions alone cannot bring
  that projection below14.8% holds without resolving those nodes.
- Destroy≈.47 plus Unresolved≈.55 makes conservative union-bound compatibility
  nearly zero. Those uncalibrated outputs establish unusable authorization
  scores, not an87.8% measured semantic misunderstanding rate.
- The original72.1% source capability projection includes authority/location
  disagreement with effect-only fixture assumptions. It is not production
  prompt frequency or a pure effect-classification error rate. Preserve it and
  add separate effect/native-authorization measurements rather than rewriting it.

## Changed deterministic decision path

Added separate reusable GNU/POSIX utility effect-ceiling contracts: observer,
stream-transform and resource-update profiles. These are upper bounds, not exact
effect labels or command-string allowlists. A Read|Write phase can admit a known
RW ceiling without guessing which one wins. A Read-only phase cannot borrow Write.

The AST composes every child. Simple parameter/pathname expansion retains a Read
ceiling without inventing literal argv. Complex evaluation, shell assignments,
unknown programs, executable substitutions and unsafe/delegating utilities keep
their unresolved effects. Known destructive/external risk floors remain intact.
The new recovery uses the possible Write upper bound, not only a mandatory Write
lower bound. Existing explicit execution and local-Git authorities are unchanged.

Bare utility spelling retains the existing trust assumption; it does not prove
the resolved binary/version. The corpus expressly assumes trusted standard
utilities with no aliases/startup injection. Native provenance binding is still
required by the complete architecture and is not manufactured from that fixture.

Independent review found a Read-denial bypass when a complete RW composition was
reduced to legacy LocalWrite. Fixed by carrying validated typed upper bounds
into capability enforcement: explicit Read/Write/Destroy denials survive the
reduction, and mixed recovery cannot inherit Read from a Write-only allowlist.
Regression covers `touch "$FILE"; cat "$INPUT"`, Write-only rejection and
Read+Write admission. Review confirmed the repair; it did not rerun the suite.

## Frozen-corpus result

| Cohort | Permitted | Old holds | New holds | New hold rate |
|---|---:|---:|---:|---:|
| Public |115|96|75|65.2%|
| Sanitized private |154|98|97|63.0%|
| Combined |269|194|172|**63.9%**|

**22 additional permitted cases resolved;8.18 percentage-point reduction.**
Zero forbidden admissions across24 cases and zero unknown admissions across71.
These small negative cohorts are not a1% escape guarantee. Target under10% is
not met: at least146 more of the172 remaining permitted holds must be recovered.

This is the same effective Rust resolver/capability projection as the baseline,
not a new denominator or actual native execution. Full gateway identity, scope,
approval and capability checks are not replayed by this helper. The public list
now changes for expanded reader compositions, checksums/observers, ownership/
permission updates and touch. Some RW ceilings intentionally remain conservative
(e.g. uniq without output can resolve LocalWrite); that is not an exact effect
label. The private cohort gains only one case, demonstrating the limitation of
utility coverage for project programs. Do not continue adding isolated command
exceptions and describe that as the full solution.

## Discriminating Laya canary

Same pinned typed-decisions checkpoint and unchanged diagnostic harness as the
prior experiment. Frozen public synthetic inputs:10 MPS cases and4 CPU controls.
No reported token truncation; input/runtime/checkpoint provenance unchanged.

| Contrast | Observed Noul output |
|---|---|
| Switch on vs off |.6535 vs .1966|
| Same switch question alone vs with another question |Identical on both cases|
| CPU vs MPS controls |Identical reported scores on all4 shared cases|
| Explicit Write=true vs one Write=false fact |**.2069 vs .3232: reversed ordering**|
| Same npm test invocation, cat vs rm body: Destroy |.2505 vs .3372|
| Missing vs supplied read body: Unresolved |**.2307 vs .2338: wrong direction**|

The model is not universally constant and does not ignore all input. Agreement
on these controls does not validate every batching/runtime path. More importantly,
it fails the proposed task contract even with explicit facts. A monotonic
temperature/calibration adjustment cannot repair inverted fact ordering. Missing
body status belongs in code, not in a model probability. Richer help alone is not
a demonstrated resolution. Keep this task/checkpoint combination ineligible.

The result does not yet distinguish checkpoint limitations, unsupported task
formulation or a narrower runtime defect. No further corpus sweep or cutoff
selection is justified until a candidate passes these necessary controls.
Astra independently inspected the outputs and agreed with these limits.

## Validation and immutable evidence

- Full gateway library:509 passed,0 failed,8 ignored. Final v3 log SHA256
  `47e31771af1df04f44d6d001c9110160123850592585a8fe6bcf486620e42eba`.
- Initial v1 full run:507 passed,1 failed,8 ignored. Old test expected touch to
  remain unknown; updated to its intentional Write result and added an unknown
  widget control. Failure receipt retained. v2 passed before capability review;
  v3 revalidated the Read-union repair.
- JavaScript evaluation tests:8 passed,0 failed, including two canary tests.
- Independent bounded reviews: utility/AST/capability review repaired and closed;
  canary provenance/interpretation review found no must-fix. No reviewer reran
  inference or the captured suites.
- `git diff --check` passed. No workspace-wide suite or native staging gate run.

Final public replay:
`/Volumes/sidecar/statewright-model-eval-20261105/effect-evidence-public-replay-20261109-v9.json`
SHA256 `6ad1bdda114577a64c6680df2b388c81ed9771b463aaf94b2e7410705a654be1`.

Final private replay (kept private, not committed):
`/Volumes/sidecar/statewright-history-corpus-20261108-v5/effect-evidence-replay-20261109-v8.json`
SHA256 `53494e1391951e43fd539c0547c3cbb11a94534c9d9b92248f10d77ed0a3d2f3`.

Canary verifier:
`/Volumes/sidecar/statewright-model-eval-20261105/semantic-signal-verification-public-20261109-v2.json`
SHA256 `8500c3c3e9ac19f13a223f1491f57d008e86aea38da9167af8d7b959d5b8dc70`.
It binds both input/result byte hashes, runtime/checkpoint identity and verifier
source. Failed/intermediate replays and v1 verification remain immutable.

## Next implementation boundary

1. Build out the grounded fact path through existing native collection: resolved
   executable/tool identity, argv/context and referenced package bodies/hooks,
   wrapper children and relevant trusted static reference material. Do not use
   a bare name, fixture assertion or model self-report as native proof.
2. Compose structure/completeness and known effects in code. Replace the legacy
   recognized-operation prerequisite only with validated complete fact receipts,
   not with unchecked old scores or wholesale structural-guard removal.
3. Qualify an improved local checkpoint/task contract or alternative on the
   counterfactual canary before calibration. Provide actual bounded relevant
   values through explicit local-only transport; never leak them to hosted
   providers or ordinary telemetry. Keep known missing evidence deterministic.
4. Calibrate the allowed-effect-set event on separate tuning data, then test
   family/composition holdouts and a substantially larger negative cohort.
   Preserve full native authority checks and measure them independently.

Rollback reverts only the owned commits; retain original/failed evidence.
Canonical sources, unrelated worktrees/index, runtime and installed packages were
not changed by this local candidate. No model is qualified or release ready.
