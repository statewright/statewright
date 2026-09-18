# ADR 010: owning SDK default summary inference

Date:2026-09-17. Status: experimental intermediate boundary, not P1 activation.
Basebd00adf. Installed paired coding-agent/pi-ai0.73.0 public source is evidence.

Review finding motivating Slice21: final comparisons are not an immutable handoff. A queued
microtask can mutate the original branch entries AFTER validation and BEFORE SDK
consumption, activating raw summary fallback. Independent inert challenge and
root actual SDK/real operations/loopback regression reproduced it. This adapter
remains experimental; require fresh exact-source tests/review before accepting
the repair. Freeze ONLY SDK's freshly collected branch entries ARRAY before
hooks, not its SessionManager entry records. Emit a detached plain preparation
view with copied entry/message values and Sets/Maps to hooks. Late hook-view
mutation cannot change the SDK-retained immutable array; comparisons continue
diagnosing immediate/awaited mutations of either view, not claiming a lease over
future microtasks. Supported result overrides remain structurally unchanged.

Manual/automatic compaction and branch summary invoke public compact/
generateBranchSummary -> completeSimple outside ordinary Agent onPayload hooks.
Existing before-compaction checkpoint is not a lease over later provider awaits
or final native persistence. Root actual SDK tests reproduced all four pending
handoff gaps; changing native event.type could also return no supplied compaction
and let SDK silently fall back to its raw default provider path.

Bind ONLY the owned session's public ExtensionRunner.emit aggregate boundary.
Require exact SDK VERSION0.73.0/public method shape, original private caller and
combined epoch/native signal. Snapshot native kind/signal/model/thinking/preparation/
instructions before await, preserve supported aggregate cancel/custom results by
value and preserve tree instruction/label overrides. Changed kind/signal fails
closed, never delegates an unexpected result to a raw SDK default fallback.
Copy readonly model facades without Proxy structuredClone failure; preserve native
file-operation Sets/Maps in preparation, not JSON-coerce them into empty objects.
Capture the original native preparation AND retained branch entries identities.
Reject replacing either reference even with a clean equal-valued copy; SDK keeps
the original entries array, so checking only the latest event view is insufficient.
Reject raw preparation mutation after aggregate hooks and again after all owned
waits, including the empty/no-summary return. The SDK otherwise retains its live
entries array and can activate raw fallback despite an empty captured array.
Snapshot public navigateTree options before the first await, under ONLY its
original private caller, so later caller mutation cannot turn summarize on.
Supported result overrides remain the API; rejecting raw preparation mutation is
an intentional experimental compatibility restriction, not stock SDK parity.
Custom results receive a fresh checkpoint too.

Supply SDK DEFAULT algorithms via their public exports with an ephemeral private
API alias registered using public pi-ai primitives. Delegate the captured original
provider with immutable original Model; do not change session.model's API, replace
builtin/provider registrations, import private SDK modules, copy algorithm/UI or
patch vendor/installed files. Root paired pi-ai peer/lock metadata declares this
public dependency; existing resolved/integrity entries are unchanged, no install.
Native SDK records these adapter-supplied defaults as fromExtension=true; this
is disclosed provenance, not a claim they used its raw stock default path.

Alias discovery/captured functions are NOT native input authority: exact original
caller comparison before execution, no captured-reference adoption on unbound/
foreign scope, lease expires when algorithm finishes and exact source unregister.
Fresh private checkpoint before stream construction, after provider payload await
with copied payload/owned consumption proxy, and after HTTP/algorithm completion
before native persist/branch/publication. Forward genuine SDK stream/errors, abort
owned awaits and deny old results. Iterator return is best-effort observed cleanup,
not proof of a permanently broken provider's in-flight drain.

Public compact creates split-turn summaries in parallel. Serialize alias dispatches
under the SAME original private caller so one parked checkpoint cannot reject its
queued sibling merely due to held phase; no new/latest epoch is admitted. Each
sibling still reconciles fresh. Set maxRetries0 where public providers honor it;
no automatic fallback/reroute. Native core retry continues through existing Agent
guard but its pre-retry shared-state/controller/event races remain OPEN. Codex
response transport has its own fixed retry loop; other backend retries/WS/auth
internals are not collectively proved by the option or one inert HTTP transport.
Do not advertise all-provider no-inference conformance from this intermediate cut.

Add before-tree admission and synchronous owner guards for native branch/reset/
branchWithSummary writes. Unbound native tree navigation lacks capture and is held,
not implicitly adopted; future owning tree gestures/complete lineage require their
own cut. Custom cancel/summary paths retain SDK semantics. Native headed UI, full
restart/lost-begin/legacy recovery, every raw settings/registry/FS/spawn/provider FX,
immutable policy/artifact/reviewer binding and authenticated decision journeys
remain open. No human authority or same-OS isolation is inferred from routing/API
keys. Synthetic owner/journal and loopback SSE are not live reviewer acceptance.

Rejected: checkpoint-only at before event, proxy-only normal Agent hook, global
builtin interposition, changing persisted model API, copying native algorithms,
fallback after incompatible event, unbound callback adoption, client retry as a
grant, mocked compaction-only proof, and weakening pending/stale/error assertions.
Removal: replace adapter with an equivalent public per-session default-summary
transport hook; SDK/provider upgrades require actual-source tests and independent
compatibility review. Rollback: coherent scoped revert preserving journals/native
owner records; no workflow, decisions, real inference, install/deploy/push here.
