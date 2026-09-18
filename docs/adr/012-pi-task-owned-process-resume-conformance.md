# ADR 012: task-owned Pi process resume conformance

Date: 2026-09-17. Status: experimental source conformance, not runtime activation.

Object-only reopen fixtures cannot establish an SDK process restart. Add an IPC
test driver running the installed public owning SDK factory in distinct Node
children, with the actual durable owner/journal/native UUID file, private bridge
and readiness lifetime. Synthetic authority and inert loopback SSE replace real
decisions/providers; no headed modes, resolver, workflow or user sessions.

The lost-begin case withholds the adapter result AFTER real HTTP/durable parent
park, before handing any reference to the gate. It models frontend acknowledgement
loss, not a server socket-drop/crash. Graceful child close must settle old input;
parent readiness close cancels the durable request even when its frontend lacks
the reference. The approval checkpoint must remain unchanged. Explicit owner and
controller reopen bind the same native descriptor, fresh process/readiness and
epoch; they cannot adopt an old reference or infer until synthetic approval.

Both children must exit normally and consumption/continuation must occur once.
Emergency cleanup signals only the exact test-owned child and never count as a
successful exit. Private fixture IPC is not a new product/approval interface.
SDK children receive a PATH-only environment, confirmed through their actual
ready receipt; no ambient provider credentials/session routing are inherited.
Darwin also supplies __CF_USER_TEXT_ENCODING, reproduced in a bare PATH-only Node
child without SDK imports. The strict ready-key check permits only that platform
metadata alongside PATH, not arbitrary additional environment keys.
Capture the successful real controller consumption body without changing its
algorithm, then replay that actual nonce/reference over HTTP after consumption.
A fabricated invalid nonce is not evidence of consumed-release replay denial.

Rejected substitutes: same-process SessionManager recreation, automatic UUID/
latest-reference adoption, private SDK imports, copied SDK algorithms, headed UI
initialization or weakening no-inference/history/once-only assertions. No durable
schema or production runtime changes are intended. Roll back the scoped fixtures/
ADR/receipt commit without deleting native files, journals or ownership records.

Original cases: SDK child-process restart is real; parent owner/controller reopen
remains same-process. Added full-parent cases run actual store/mirror/runtime and
observeHost in separate parent processes, each supervising the same public SDK
driver. The external synthetic authority and provider survive both lifetimes.
One task-owned proxy destroys the begin response socket only after the real
private bridge completed/fsynced parking; this is actual HTTP acknowledgement
loss, not adapter-result withholding. Normal SDK/parent exit precedes explicit
same-owner reopen and strict descriptor/journal/readiness/epoch reconciliation.
The shared IPC helper extraction preserves the earlier child test semantics.
Emergency reap is bounded separately: exact owned handle gets SIGTERM, then
SIGKILL if its actual exit is not observed before the grace deadline. A second
deadline fails as unreaped, never as successful termination. An inert POSIX
child ignoring close/SIGTERM proves this fixture behavior, not SDK resistance or
permanent product teardown recovery. Normal SDK/parent acceptance still requires
exit0/no signal; emergency-reaped processes cannot satisfy those assertions.

Failure cases additionally force the SDK's actual owned handle to exit and await
the real observer/readiness teardown, then SIGKILL root's actual parent handle
while its owner lock remains held. The SDK is reaped before parent crash to avoid
leaving an orphan native writer. Request cancellation precedes parent crash;
approval checkpoint/native bytes remain unchanged. A new actual parent explicitly
resuming that ID must fail and exit1, preserving raw owner/lock bytes and file
inventory. No PID/age-based lock reclamation, replacement or recovery is added.

A separate proxy destroys the consume response only after the real bridge has
completed durable consumption and journal clear. Lost delivery must settle with
no inference/history/final response, retain the consumed approval tombstone, and
deny exact consumed-body/status/cancel replay. The test-only SDK driver permits
fresh explicit input only after its actual previous SDK prompt promise settles.
That new input may use authoritative cleared state, but not the old nonce; its
one response/history belongs to the fresh text. Whole-parent graceful reopen
then preserves the consumed tombstone/history and cannot redeliver automatically.

An additional service-clear barrier reads the physical consumed owner and original
journal checkpoint before invoking real journal.clear. It reports the actual
controller consume body, not a fabricated nonce/owner mutation. Holding that
service also holds the mirror serialization queue and observer; the crash-only
fixture command therefore acknowledges actual SDK exit and native readiness
closure WITHOUT claiming observer completion. Parent SIGKILL afterward preserves
both consumed tombstone and still-present checkpoint. Exact-ID new parent refuses
the dead lock unchanged; no recovery/automatic journal repair is authorized.

Normal fixture close is tested at the same barrier: first require actual SDK exit
(normal exit0 in this case), only then release the held service and drain the real
observer/bridge/owner. The release receipt must report SDK exited; journal clear
can complete after cancellation without admitting the stopped SDK. Tombstone and
unchanged native bytes survive a whole-parent graceful reopen with no inference.
This is fixture cleanup conformance, not evidence of permanent failure teardown.

Limits: forced parent crash after native writer reaping is NOT arbitrary crash
recovery or safe stale-lock reclamation. Consume wire loss AFTER journal clear is
distinct from the named consumed-write/pre-clear crash above; neither establishes
exactly-once crash delivery or native-writer-verified recovery.
Legacy recovery, permanent failure-drain, authenticated reviewer/UI, installed
launcher/hosts and all original P0/P1 obligations remain open. No production
source/schema or native activation. Revisit when verified native-writer recovery,
complete crash-delivery conformance and genuine native acceptance become available;
no release certification is implied.
