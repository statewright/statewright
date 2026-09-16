# Provider-safe context handoff: repair options

Date: 2026-09-15. Depth: focused. This is a read-only diagnosis/design follow-up, not a deployed fix.

> Superseded for the intended combined stack by [005-companion-context-handoff.md](005-companion-context-handoff.md). This investigation tested Statewright's standalone proxy against direct model fixtures, omitting codex-local-models' existing compatibility adapter. Its blanket native-patch recommendation was premature. The observations below remain evidence about that bypass path, not proof that the companion stack fails.

## Research summary

The current resume-based OpenAI/Qwen handoff exposes a compaction request using the source model at the destination provider. The observed consequence is failed continuation; the existing evidence does not demonstrate overwritten files, corrupted transcripts, or cross-session attachment. Fixing the outgoing model label alone is insufficient: context encoding, context limits, routing authority and rollback also need a provider-aware boundary.

Recommendation: contain the unsupported transition in Statewright, then pursue a native provider-aware handoff for unchanged native thread identity. If a native change is undesirable, use a separate destination worker with an explicit portable task packet, or an explicitly approved new destination thread; neither is equivalent to a transparent same-thread switch.

## Key findings

1. **Wire-level failure is reproduced in both directions.** The [recorded native probes](probes/hard-interrupt-preface-results.json) show Sol at the Qwen endpoint and Qwen at the OpenAI endpoint during compaction. The former also received `model_not_found` from the actual Qwen service in a minimal synthetic contract check. Reverse-direction provider rejection was simulated; no real OpenAI credentials or private history were used.
2. **Statewright currently confirms too early.** In [switchProvider](../../plugins/executor/lib/codex-app-server-route-proxy.mjs), returned thread ID, model and provider are checked after resume, then `verifiedSwitch` is set. That proves attachment metadata, not that compaction or the destination continuation succeeds. Its catch/rollback only covers failures during the switch procedure; subsequent native turn failure is outside that catch.
3. **Provider state is not automatically portable.** OpenAI documents encrypted opaque compaction items and instructs applications to retain the returned compacted window as a unit. The documentation does not establish Qwen compatibility with that representation. Designing a portable plaintext checkpoint is a separate operation from passing through or editing an OpenAI compaction item. [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction), accessed 2026-09-15.
4. **Manual compaction is asynchronous, not a handoff acknowledgement.** `thread/compact/start` returns immediately; completion arrives through native lifecycle events. Our prior source-provider compaction experiment still produced the mismatch afterward. Its synthetic checkpoint also does not prove semantic context preservation. [Codex App Server](https://learn.chatgpt.com/docs/app-server), accessed 2026-09-15.
5. **A normal fork is not a clean-context workaround.** The documented fork operation copies stored history into a new thread. It should not be assumed to remove retained provider-specific state. A new thread seeded with a portable packet is a distinct operation and changes native identity. [Codex App Server](https://learn.chatgpt.com/docs/app-server).

## Detailed analysis

### Severity and containment

Treat transparent same-thread OpenAI/Qwen transitions as unsupported until the full path passes. Keep the existing working Sol/Astra hard boundary available. A proposed Statewright guard should reject an unsupported cross-provider transition before detaching the source, preserve the pending request, and explain that no destination work ran. This guard is recommended, not implemented by this research turn.

The recorded failures establish availability and context-transfer problems, not a completed data-integrity audit. Some context reaches a destination endpoint before a model-not-found rejection; authorization to send that context must be checked before making the request. Do not describe this as proven cross-session leakage: the synthetic tests used explicitly selected providers and isolated threads.

The durable transcript and already-written workspace files should be retained throughout repair. Test transcript integrity, goals, pending inputs and resumability explicitly before promising complete preservation. Provider-resume metadata alone does not prove those properties.

### Preferred same-native-thread repair

The native handoff needs one coordinated boundary; the shim remains its supervisor:

1. At a safe tool/turn boundary, acquire the exact thread/turn/route-generation authority, freeze new model steps and settle or reject outstanding tool work. Preserve operator cancellation and queued inputs.
2. Preflight the destination's real model identity, context budget, tools, authentication and authorized data scope. Retain the source runtime and routing configuration while preparing the destination.
3. Prepare destination-compatible context. Replay portable visible history losslessly when it fits. Otherwise generate an explicit plaintext checkpoint while the source provider can still interpret its own state. Include the user's objective and constraints, Statewright phase/evidence, completed side effects, exact file/artifact references, unresolved work, and recent relevant messages. Keep original history available for retrieval; a summary is lossy and must not silently become the only record.
4. Initialize the destination with a coherent provider/model/compaction-client tuple and fresh destination tool/instruction settings. Never combine a source model with the destination client. Do not forward opaque compaction state or provider-specific response IDs unless compatibility has been established. Preserve the same durable native thread only through a supported native operation, not ad hoc JSONL edits.
5. Distinguish prepared attachment from committed execution. Verify the actual destination request/response under the target route before reporting the handoff active or enabling model-driven side effects. On failure, release destination resources, restore and verify the source, retain the pending route and preserve a typed failure record. Avoid two active writers during this process.

This is an architectural contract, not a claim that a particular Rust patch is already identified. The failing wire behavior is verified; exact native source symbols and the minimum patch remain to be localized in a complete pinned checkout. A provider-pair eligibility check in compaction is likely necessary, but it is not sufficient evidence of a complete migration repair.

Native implementation costs include maintaining a pinned build and testing upstream changes. A future documented atomic migration API could replace that patch; no such guarantee was established from the documentation inspected here.

### No-native-fork alternatives

- **Stable main thread plus Qwen worker:** Statewright sends a bounded portable task packet to a fresh Qwen worker and returns its result to the existing main thread. This avoids cross-provider migration of the main thread, but requires worker supervision, access controls, result verification and an explicit user-facing distinction from a main-model switch. It is a proposed workaround, not a newly validated workflow.
- **Explicit new destination thread:** Preserve the source thread read-only, start the target with a portable checkpoint, and link both to the same Statewright run. This changes the native thread ID; root-session registration, queued drafts, resume/picker behavior and leases need explicit handling and user agreement. Do not transparently rewrite IDs across the app-server protocol as a small workaround.

### Rejected shortcuts

- Aliasing Sol to Qwen hides model attribution and may still pass incompatible state.
- Rewriting only the request's model field does not repair instructions, context encoding or retained compaction state.
- Raising the Qwen context window beyond its real capacity is not a fix.
- Disabling compaction can defer failure to context overflow and does not solve existing opaque history.
- Calling manual compaction and assuming its acknowledgement means migration is ready is contradicted by both the API lifecycle and the existing diagnostic.
- Editing persisted history or silently replacing the root thread is outside a safe shim-only patch.

### Acceptance gates

Exercise both directions with strict destination model allowlists and observe all requests, including prewarm, compaction and retry traffic. Cover short history, near-full target context, existing encrypted compaction, tool call/result pairs, attachments, live queued input, cancellation at every boundary, provider/auth failure, goals, reconnect and restart. Assert no wrong-provider request, no duplicate writer or side effect, intact original history, truthful effective model attribution, and successful source recovery after failed preparation. Use synthetic private-data sentinels to verify routing boundaries before testing any real sensitive data.

## Sources and evidence

- Current [Statewright route proxy](../../plugins/executor/lib/codex-app-server-route-proxy.mjs), inspected 2026-09-15: detach/resume validation and catch scope.
- [Native probe evidence](probes/hard-interrupt-preface-results.json) and [prior findings](003-hard-interrupt-preface.md): completed Sol/Astra round trip, provider-compaction mismatch, real Qwen contract rejection, and test limitations.
- [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction), accessed 2026-09-15: opaque encrypted context and output handling.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server), accessed 2026-09-15: start/resume/fork identities, asynchronous compaction and lifecycle events.

## Research gaps and limitations

No production code, live session or provider configuration was changed in this follow-up. No new inference was run. Exact native implementation localization, a transactional handoff API, plaintext checkpoint semantic fidelity and full live-provider acceptance remain open. No claim is made that existing files or history were corrupted, nor that complete data-integrity preservation was already audited.

## Search methodology

Focused research: reviewed current shim and recorded native probes, searched official documentation for Codex compaction/provider switching, and inspected compaction encoding plus app-server resume/fork/compact semantics. Two official documentation sources plus two local evidence categories support this design. The disposable pinned source cache was incomplete for the required native implementation, so it was not used to invent a source-level patch claim.
