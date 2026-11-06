# Classifier evidence and human-review delivery

Status: source preparation, not installed or enabled. No live System One
configuration was changed or reverified. This note does not authorize deployment
or a policy change.

## Observed source gaps

The staging source omitted three existing classifier fixes: `484eeda`, `558e807`,
and `2d1b6f6`. This preparation reconciles those changes with the staging tree,
preserving its native approval implementation. The changes cover repository
execution as an explicit capability, effect composition, bounded Rust validation,
and command lookup. They do not declare arbitrary test code read-only.

An offline audit of the private denial ledger classified 18 original strings as
data. Every string retained at least one opaque or passthrough component. This
is not evidence that every denial was a false positive: the audit intentionally
has no fresh repository manifests, binary identity, workflow capability, or
target authority. No denied command ran and no ledger entry was cleared.

### General repair contract

1. Preserve shell composition and every possible executable leaf. Assignment,
   wrapper, pipe, redirect and substitution evidence must not disappear during
   normalization. Unsupported syntax stays explicit; do not reparse a shortened
   command as though it were the original.
2. Separate known effects from missing evidence. Repository test/build execution
   requires its execution capability, not a fictional read-only label. A script
   called `test` can mutate data. Remote observation is not remote mutation.
3. Bind local evidence to the original invocation, working directory, current
   manifest/entrypoint bytes and collection time. Hashing an entrypoint identifies
   it; it does not prove its transitive behavior or sandbox execution.
4. Preserve independent explicit denials, destructive effects and approvals.
   Eligible uncertainty must reach an exact owner-bound human approval path.
   Unknown alone is neither proof of destruction nor permission to execute.

Ledger-derived evaluation families, without private paths:

| Family | Expected treatment | Discriminants still needed |
| --- | --- | --- |
| Process, disk and byte-comparison inspection | Observation when invocation semantics establish it | Binary/flags, output sensitivity, composition |
| Syntax checking | Parsing is distinct from running the program | Parser flags, startup hooks, output effects |
| Repository unit tests and scripts | Explicit repository execution, not Read | Fresh manifest/entrypoint, runtime injection, capability |
| Package runner and task expansion | Resolve installed runner and all declared leaves | Missing runner, network installation, workspace/config effects |
| Package installation | Local mutation plus possible network and lifecycle effects | Lock/config/install policy; disabling scripts is not Read |
| Symlink creation | Filesystem mutation | Exact link/target and Write capability |
| Inline interpreter or opaque binary | Unknown until supported evidence or separate approval | No permission from a benign-looking command name |

Negative cases must include appended destructive commands, output redirects,
runtime-injection variables, swapped symlinks/manifests, dynamic substitutions,
foreign/stale approvals, malformed evidence and absent capabilities. Additions
to executable recognition alone are not the general solution.

## Human-review delivery changes

The workflow approval controller previously remembered a presentation before
the native send succeeded. Send errors could therefore suppress retries; errors
while dismissing an old request could strand cleanup. The proxy also swallowed
the send promise, hiding asynchronous failures from the controller.

The repaired path observes send completion, retries failed delivery following
an authoritative read, and keeps authority polling independent of native send
progress. Website approval/rejection can settle a wait even while native
delivery is stalled. Late acknowledgments dismiss the old request; stale replies
cannot resolve a removed ticket. Dismissal/transport loss is never approval.
Unauthorized reviewers receive a retryable waiting notice, not a decision form.

Pending-approval extraction accepts the two observed MCP item capitalizations,
but rejects failed/error results and malformed content. Hints still require
authoritative identity/state checks; assistant prose and foreign servers are not
approval evidence.

The executor hook previously formatted `approval_required` without dispatching
the request. It now submits each eligible denial, including both reworks, to the
existing authenticated native approval controller. The Codex adapter bridge no
longer owns a second retry counter. The gateway supplies run/session/state/epoch
from the decision snapshot; the native hook supplies its thread identity, which
the controller checks against the connected owner and authoritative state.
Only a response matching the entire request can release that held invocation.
The hook never emits `permissionDecision=allow`: platform permissions remain.

This exposed an ordering defect: the gateway's uncertainty return preceded its
independent workflow checks. An approval eligibility preflight now enforces
current tool policy and independent interceptors without performing implicit
transitions. Unresolved effects cannot establish compatibility with a capability
allowlist, explicit restrictions, exploratory-read-only intent or a missing
explicit execution capability. Those remain non-approvable. State and inherited
`low_local`/`moderate_local` policies also require deterministic evidence, not
classifier approval. This intentionally conservative eligibility contract does
not change thresholds, ordinary allowed execution or workflow definitions.

Missing context, unsupported native ownership and transport failures produce
specific unavailable outcomes rather than promising a dialog. Asynchronous
native send failures now settle safely; a late transport acknowledgment after
abort dismisses only the old request. No other owner's proxy is substituted.

Protocol tests are not proof of a visible native TUI/Desktop dialog or OS notice.
Those remain separate acceptance gates, as does any web reviewer notification.

## Local judgment research and preparation

Primary sources inspected November 5, 2026:

- [Laya model card](https://huggingface.co/convaiinnovations/laya)
- [Laya implementation](https://github.com/NandhaKishorM/laya)
- [Laya serving implementation](https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py)
- [Qwen3.5 4B](https://huggingface.co/Qwen/Qwen3.5-4B)
- [Qwen3.5 9B](https://huggingface.co/Qwen/Qwen3.5-9B)

Laya is a small typed-judgment candidate; Qwen3.5 4B/9B are larger reasoning
comparators. None is established as best for this workload. Published latency
on another machine is not local performance. Laya's documented negation and
high-confidence errors require adversarial evaluation; its entropy confidence
must not inherit Jev thresholds. Default service binding/authentication and
strict-wire truncation reporting need deliberate deployment review.

The Rust `laya_local` adapter is explicit, loopback-literal-only, refuses URL
credentials/query/fragment, disables redirects/proxies and preserves timeouts.
It cannot inherit the hosted fallthrough opt-in: local evaluation remains
shadow-only; its scores cannot grant execution or raise the enforced risk floor.
It does not download, start, enable or certify a model.

Typed and generative providers now use one versioned effect-question contract.
Remote mutation means CHANGE of remote/account state, not ordinary transport.
Input explicitly identifies missing operands/option values. This makes the
limitation visible; it does not reconstruct the omitted evidence.

Before local enforcement is considered, capture pinned runtime/checkpoint/
tokenizer/quantization digests, redacted input and prompt hashes, model response
hashes, actual selected model, truncation and abstention metadata. Current wire
decoding does not yet establish all of that provenance; therefore it must not be
presented as a completed local-model integration.

Two distinct held-out evaluations are required:

- Command effects: heterogeneous CLI/shell fixtures, with independently reviewed
  effect/location/sensitivity/authority labels; false-allow, false-block,
  abstention, parse failure, p50/p95 latency and memory.
- Transition evidence: after Rust checks legal edges, guards, ownership and
  freshness, judge whether supplied evidence supports, contradicts, or is
  insufficient for the requested edge. A model never invents a legal edge or
  substitutes for human approval.

Compare current redacted shape, richer privacy-bounded evidence and model choice
separately. No commands in the corpus need execution. No private argv is sent
to a model. Help-text enrichment remains deferred.

## Validation receipt

Previous checkpoint `6d1b46e`, executed in the Sidecar preparation checkout,
not the installed runtime:

- `cargo test --target-dir /Volumes/sidecar/statewright-target -p statewright-mcp-gateway --lib`:
  **414 passed, 3 ignored, 0 failed** on final source. Ignored native interop
  gates are not counted as passed. Existing compiler warnings remain.
- `node --test plugins/executor/tests/human-approval.test.mjs plugins/executor/tests/codex-approval-gate.test.mjs plugins/executor/tests/codex-classifier-approval-proxy.test.mjs plugins/executor/tests/classifier-approval-controller.test.mjs plugins/executor/tests/codex-native-approval-proxy.test.mjs`:
  **121 passed, 0 failed/cancelled/skipped**. These are local controller/protocol
  tests, including mocked native transport, not visible TUI acceptance.
- `node plugins/codex/scripts/sync-desktop-runtime.mjs --check`: passed after
  generating source copies through the existing sync command. No install.
- `git diff --check HEAD`: passed before checkpoint commits.
- Bundle/runtime-contract invocation: **3 passed, 3 failed**. Bundle consistency
  passed. Release-note lookup for `docs/releases/codex-0.3.9.md` failed ENOENT;
  managed diagnostic and connection reporter expectations failed `0.3.5 !=
  0.3.9`. All implicated test/manifest/reporter/managed-client inputs are unchanged
  from base `6b9adc6`; the release-note path is absent in that base tree. These
  are outstanding release gates, not a clean full-suite result.

The notifier regression baseline failed three newly added tests before repair.
An early Rust compile failed while a cherry-pick conflict remained; after a
manual scoped reconciliation, the test passed. Those failures are retained, not
reclassified as successful runs. A mechanical cherry-pick continuation also
failed because uncommitted application was preserved; quitting its sequencer and
applying only the remaining commits preserved all preparation bytes.

### Executor handoff checkpoint

Fresh checks after the handoff and policy-ordering repair:

- `cargo test --target-dir /Volumes/sidecar/statewright-target -p statewright-mcp-gateway --lib -- --quiet`:
  **415 passed, 3 ignored, 0 failed**. Existing warnings remain.
- `node --test plugins/executor/tests/classifier-approval-controller.test.mjs plugins/executor/tests/codex-classifier-approval-proxy.test.mjs plugins/executor/tests/human-approval.test.mjs plugins/executor/tests/codex-approval-gate.test.mjs plugins/executor/tests/codex-native-approval-proxy.test.mjs plugins/executor/tests/adapter-bridge.test.mjs plugins/codex/tests/executor-bridge.test.mjs`:
  **145 passed, 0 failed/cancelled/skipped**.
- Generated runtime synchronization and `git diff --check`: passed.

New loopback coverage runs the real hook, adapter bridge, approval HTTP helper
and proxy/controller against a mock native WebSocket peer: two reworks, then
accept/decline/cancel. Negative cases include missing thread/context/runtime,
mismatched response, explicit policy, foreign/stale owner, changed state,
duplicate owner, disconnect, asynchronous send failure and late acknowledgment.
No visible TUI/Desktop dialog was exercised. Native execution without a matching
resident remains unsupported and denied, not silently redirected.

Intermediate failed checks are retained: an async-send test incorrectly used
the forbidden zero-rework configuration (22 passed, 1 failed); a gateway test's
next-state tool name did not match its requested native alias (414 passed,
1 failed, 3 ignored); a later Rust compile rejected an ambiguous `.into()` in
the new denial message. Correcting these fixture/source errors preceded the
fresh green runs. Independent review additionally identified and verified the
effective risk-tolerance guard; final narrow source review had no must-fix item.

Outstanding package/version gates above were not rerun or declared fixed.
All private denial-ledger entries remain unresolved. Local-model measurement,
complete package preparation and installed native acceptance remain separate
work; this checkpoint does not establish release readiness.

Independent read-only review found and drove fixes for local-client timeout/proxy
loss, stalled notification blocking authority polling, and shadow-score isolation
being lost during native-evidence rebuilding. Final review reported no further
finding in those bounded deltas. It did not certify a model, installation,
native UI, complete classifier coverage or deployment.

### Compositional evidence and package preparation checkpoint

Fresh local evidence now covers simple literal command lists. The collector
returns every original leaf; the gateway independently parses the original Bash
AST and requires exact ordered coverage, invocation/cwd binding and freshness.
It unions known effects and capabilities instead of treating a read prefix as
permission for the remainder. Commands are inspected as data, never executed.

Independent review found an in-list invalidation hazard: an earlier write or
repository script can change a later manifest/binary after collection. The
gateway therefore stops using subsequent file evidence after any leaf not
proven Low/Local. Concurrent pipelines remain outside this evidence path;
ordinary AST classification still applies. Unsupported control flow,
substitutions, redirects, missing leaves and stale evidence cannot gain admission.
Both producer and consumer bound the envelope to 128 KiB. Omitted execution cwd
no longer borrows the bridge process cwd; explicit absolute cwd is required for
local file evidence. Unknown provenance remains unresolved, not permission.

Package manifests were already `0.3.9`; stale `0.3.5` diagnostic constants are
now synchronized to that version, including generated runtime copies. Added
candidate release notes. This is source preparation, not a new install.

Fresh executed checks on this delta:

- Gateway library: **416 passed, 3 ignored, 0 failed**; existing compiler warnings.
- Collector plus package/runtime bundle contracts: **22 passed, 0 failed**.
- Stronger total-byte-budget collector fixture subsequently rerun: **16 passed,
  0 failed**. The fixture proves an individually valid repeated expansion exceeds
  and is rejected by the total budget, rather than merely checking a small proof.
- Focused Rust composition test passed before and after invalidation hardening.

The earlier package failures remain in this record; the fresh six package checks
now pass. Source tests are not installed/native acceptance. No denial-ledger
entry was removed and no denied command was executed. Pipeline rejection and
explicit cwd requirements deliberately retain unsupported cases for an honest
approval/diagnostic path. Current staging bindings still name an older source
candidate; no deployment was performed using those stale bindings.
