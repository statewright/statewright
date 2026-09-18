# ADR 013: native-writer-verified executor recovery contract

Date: 2026-09-17. Status: accepted experimental binding contract; takeover NOT implemented.

The explicit-ID owner store intentionally refuses an existing lock, including
after parent death. Slice27 demonstrates consumed owner state alongside a retained
journal before clear; it does not establish arbitrary crash recovery. The lock
records parent PID/token, not an SDK writer lease. Native readiness keeps its
ChildProcess handle in the old parent. That closure cannot survive parent death.
The root fixture's serialized parent receipt is useful conformance evidence, not
a new root's independently authenticated native-exit authority.

## Decision

Implement a pure, closed `statewright/native-writer-recovery-binding/v1` metadata
contract now, before implementing takeover. `matchExecutorRecoveryBinding`
compares a candidate against a separately selected expected intent and returns a
frozen scalar copy. It does not read files, establish provenance, verify process
exit, register writers, consume an intent, reconcile approval or reclaim locks.
Matching JSON remains replayable and must NEVER serve as recovery authorization.
No current production runtime imports it; no store/bridge/CLI recovery entry point
is added. The experimental writer authority below uses it privately.

The binding includes executor UUID, scope digest, exact transport client/session
and run, native UUID/absolute normalized file, existing owner token, raw owner/
lock/native/checkpoint byte digests, request epoch, parent/child/broker lifetime
IDs, writer lease ID/generation and one-use intent ID. A null checkpoint digest
means observed absence only, NEVER approval clearance or permission to infer.
The owner digest covers consumed tombstones and scope credential fingerprint;
raw credentials must not appear. Run/session IDs retain the store's printable
string semantics, not invented UUID requirements. Path validation is platform-
local lexical validation, not no-follow, symlink or held-file identity proof.
Unknown versions/keys, coercions, getters, foreign/stale fields and malformed
expected intents fail. Case/alias/path normalization cannot hide a mismatch.

## Required authority before enabling takeover

1. A trusted lifecycle/writer-lease authority must outlive the failed parent and
   retain actual OS-backed handles or equivalently strong process-lifetime proof
   for EVERY native writer. Registration precedes native admission. Exit is an
   observed terminal event, not a kill request, timeout, PID probe or IPC assertion.
   Current parent-local readiness is insufficient; the production outliving
   broker does not exist. The unactivated pair prototype below is not that broker.
2. Exclusive writer admission must persist through proof and transfer. Every
   normal open/resume AND recovery contender participates in the same authority.
   Legacy/unregistered writers are unsupported; source/file-version knowledge
   does not make an unknown live writer registered. Broker/ledger/lease loss or
   restart without authenticated continuity denies, with no weaker PID fallback.
3. A private opaque, non-serializable capability must bind the exact metadata to
   that authority's currently held lease and durable one-use intent ledger. Agent-
   returned JSON, matching hashes, saved challenge, callback returning true, or
   an HMAC with a same-agent-readable key is not that capability. A stable snapshot
   is observation, not future-write exclusion. This contract does not prove
   isolation from malicious same-OS-user processes; such isolation needs a separate
   OS/service boundary and entitlement design.
4. Under continued exclusivity, revalidate raw bytes AND held native/owner/lock/
   checkpoint file identities with no-follow scope containment. Perform an exact
   exclusive compare/transfer, not blind unlink then wx: current normal open does
   not participate in a recovery mutex and could win that window. Preserve the
   old claim plus durable transfer intent until successor installation is safe.
   Pre-mutation denial preserves all bytes/inventory. A mid-transfer crash leaves
   an explicit held intent for authority reconciliation, not PID auto-healing or
   rollback that resurrects an old grant. Implement/review this protocol separately.
5. New owner means fresh private parent/child readiness and request epoch. Requery
   authoritative exact run/approval state before presenting controls. Pending
   remains pending; consumed tombstones remain consumed. A retained pre-clear
   checkpoint is not a replayable grant. Journal reconciliation cannot resolve
   human approval, revive an old nonce or automatically redeliver native work.
   Exactly-once crash delivery remains a separate open requirement.

## Acceptance before recovery API

### Experimental registered-pair exit authority (Slice29)

`createExecutorWriterAuthority` is trusted-root-only, unactivated source. It
reserves registered executor scope/native UUID/lexical file, launches its own
PATH-only Node parent/writer children and keeps their actual ChildProcess handles
private. Read-only ports forward native lifecycle events without leaking the
handle through callback `this`; no PID/handle adoption or `emit` surface exists.
An accepted signal, IPC assertion, close/spawn error, observer timeout or readiness
revocation is not writer exit. Require both spawned registered roles' actual
terminal exit events without launch errors before issuing an opaque witness.

Stable lineage is reserved before launch. Recovery intent's owner token/raw-byte
digests/request epoch/intent ID can change while children work: select and bind a
fresh exact snapshot only after quiescence. One private witness/intent per pair,
identity lookup, exact comparison and synchronous consumption deny copies/replay.
Consumption returns binding metadata, NOT a store recovery capability, and retains
reservation; no replacement generation or transfer/release API is implemented.
Authority close revokes proofs but does not claim exit or kill arbitrary processes;
owned ports remain signal/exit-observation-capable for explicit bounded cleanup.
Ledger and handles are memory-only; a new broker lifetime cannot adopt old proofs.

Actual Node actors test these boundaries. A separate installed public SDK child
uses real durable owner/controller/journal/private bridge/readiness, parks input
with no inference/history, and cannot witness exit merely from registered parent-
role actor exit or readiness closure. Actual normal SDK exit permits one witness
without changing pending checkpoint/lock or enabling resume. The parent role actor
is INERT, not the actual executor owner/controller process. This is registered-pair
prototype conformance, not full executor-parent crash recovery or durable-owner
PID/process membership validation. Current launcher/normal open/resume do not use
it; unknown/unregistered descendants/writers, lexical aliases and same-OS malicious
processes are not excluded by it. The producer still needs trusted raw-byte/file-
identity observation, all-writer registration/admission, durable intent/continuity
and exclusive transfer/reconciliation before ANY reclaim API. First generation
only; permanently holding the prototype reservation is not completed recovery.

### Required full recovery journeys

Require real task-owned processes and authority, not injected booleans: parent
death with surviving writer must hold; parent AND all registered writers observed
exited may transfer once; missing/foreign/replayed/expired witnesses, changed raw
bytes/file identity, broker loss and unsupported writers deny. Race two recoveries
and a normal resume/new writer, and crash at each transfer persistence boundary.
Cover retained pending and consumed-pre-clear journal state, authoritative approval
reconciliation, new input/epoch and no stale final/native effect. Preserve all
original P0/P1 host/auth/effect/install/canary/soak requirements; a validator's green
tests are not these journeys. POSIX proof does not establish Windows parity.

Rejected: PID/age/kill(0) recovery (reuse and unknown writers); exit JSON or old
readiness (issuer died, replay); hash-only unlink (no exclusion, TOCTOU); persisted
agent-readable signature alone (no issuer/lease continuity or malicious-user
isolation). Permanently denying dead locks is safe interim behavior, not completion.

Rollback only experimental validator/authority/tests/ADR/receipt source paths; never delete or
rewrite durable owner, lock, native or journal data. No workflow/live session,
human/provider decision, installation, production activation or deployment.
