# Private shared Laya transport preparation

Base9290d920d54a77487ceede1a6269a6a5bac76f17. User authorizes shared GPU bring-up
and says skip Statewright execution. No workflow is loaded or activated here.

New laya_cluster is not a widening of laya_local. It requires the exact internal
HTTPS endpoint, typed-decisions checkpoint, staging/dev1/dev2/dev3 environment,
explicit64-hex-character bearer token and certificate Secret files at
/run/statewright/laya/{token,ca.crt}. Reads are size bounded. HTTP uses only that
certificate trust, no proxy or redirects, <=1500ms transport and <=1000ms service
deadline. Both assessment and fallthrough opt-ins remain required. Legacy dev,
production/unknown environments and hosted credential inheritance are rejected.
Private reference/evidence handling remains confined to configured private Laya
providers. Hosted providers still receive redacted state. Confidence thresholds,
response schema validation, native policy, heuristics and human approval are
unchanged. Queued foreground jobs whose caller has closed are discarded before
inference rather than blocking later live decisions.

Validation actually executed:

- Focused first run85passed/1failed/1ignored: regression caught legacydev being
  enabled in cluster assessment config despite constructor rejection. Fixed the
  config boundary, preserving existing loopbackdev behavior.
- Focused final run87passed/0failed/1ignored, including exact transport/secret
  constraints, environment dual-opt-in and abandoned-queue suppression.
- Full affected gateway library suite534passed/0failed/8ignored.
- git diff --check passed.
- Independent non-editing review found no concrete source blocker. Public test
  certificate verifies parsing/client construction only; private key discarded.

Not yet proven: actual rustls handshake, cross-namespace DNS/NetworkPolicy,
mounted staging credential, real six-answer schema and measured GPU response
through the deployed gateway. No gateway deployment, native8h acceptance or
classifier recovery percentage is inferred from these tests. Rollback is the
normal coordinated staging source release, not guard/threshold relaxation.
