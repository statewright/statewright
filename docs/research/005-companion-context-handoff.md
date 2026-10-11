# Combined companion context handoff

Date: 2026-09-15. Historical engineering summary, sanitized 2026-10-10.
This is not a fresh validation or a current support certification.

## Outcome and corrected scope

The intended integration separates Statewright workflow routing and presentation
from an optional provider-compatibility adapter. Earlier direct-endpoint probes
omitted that adapter; their blanket native-patch recommendation was premature.
A standalone failure does not establish that a companion-assisted path fails.

Private companion implementation details and reproduction instructions are
omitted here. They are not requirements to install or test core Statewright.

## Public Statewright contract

- Do not silently fall back to an unconfigured raw provider endpoint.
- Validate the destination configuration before detaching the source session.
- Keep routing and presentation separate from provider-specific compatibility.
- Preserve genuine native terminal events; do not disguise a real interruption.
- Preserve available context within explicit limits. Lossy context transfer is
  not decryption or proof of semantic equivalence.
- Surface a bounded warning on the matching thread when context recovery is
  incomplete; do not inject terminal control sequences.
- Do not automatically retry later inference failures across providers, which
  could duplicate effects.

The relevant public implementation is in
`plugins/executor/lib/codex-app-server-route-proxy.mjs` and its handoff tests.

## Historical evidence and limits

The original investigation recorded 105 targeted Statewright tests passing,
covering existing handoff presentation/interruption behavior and the
no-silent-bypass guard. Companion-specific checks were recorded separately;
they are not independently reproducible from this public repository and their
implementation details are excluded from this summary.

The investigation did not certify a fully live cross-provider workflow,
model-generated tool use after transfer, arbitrary attachments, or preservation
of all historical facts. Original rollouts remained the source for omitted
detail. No running pane, global installation, user authentication, or persisted
session history was modified by that investigation.
