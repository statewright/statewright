# ADR 011: owning native retry lifetime and completion handoffs

Date: 2026-09-17. Status: experimental intermediate boundary, not P1 activation.

Installed SDK0.73.0 creates a retry promise synchronously at agent_end, before
queued completion effects. Actual SDK/real owner/loopback tests exposed idle
cancellation leaving the old native prompt unsettled, and pending approval
allowing retry-start publication before the later inference checkpoint.

Retain the SDK retry algorithm/settings and use only owned-instance public
Agent.subscribe, ExtensionRunner.emit/emitMessageEnd, SettingsManager.getRetrySettings,
waitForRetry and abortRetry.
Capture the producer's original private reference and parent epoch signal, not
the latest gate cache as a grant. Track a private retry slot and its captured
native promise; cancellation claims that exact slot before synchronous abort
callbacks and cleans up only the same slot. Match the captured physical native
session tuple before aborting; stale project callers cannot abort a newer retry.
Native input cancellation/replacement remain explicit host gestures, not
inherited/project capabilities. Keep guards installed after close.

Fresh checkpoints surround assistant message_end and agent_end aggregates, before
native completion publication, assistant persistence and queued retry effects.
The SDK's later public retry-settings read rejects a cancelled/replaced completed
producer outside hook catches. Distinguish synchronous initial promise preparation
from productive queued retry consumption using the exact private producer object
in a WeakSet. Initial settings reads and passive lifecycle observers stay intact;
do not make reading event.type throw. This covers the tested final aggregate-return
microtask cancellation without adopting a latest epoch. Exact SDK method/source
shape is a compatibility boundary, not a claim about other versions. Earlier user/
tool events are not newly serialized under this assistant-completion boundary.

SDK publishes auto_retry_start before creating its abortable sleep controller.
Reentrant cancellation there settles the promise yet leaves attempt1, consuming
the next request's allowance. Deliver subscribers installed through the owned
public subscribe wrapper in a microtask after controller installation. Capture
the original producer/event by value, drop stale/closed/unsubscribed deliveries,
and recheck its private owned phase. Native cancellation then aborts the already
established controller, preserving SDK catch/reset behavior. Report observer
exceptions through public ExtensionRunner.emitError rather than corrupting native
retry state or silently hiding the observer failure. This is an intentional
retry-start observer ordering/exception-policy change, not exact stock API timing.
Pre-existing listeners registered before this wrapper and direct raw listeners/
SDK-private effects are not covered by it; native headed UI acceptance remains OPEN.

Reject disabling retries, copying private retry algorithms, patching vendor files,
global provider replacement, treating retry attempts as approval, stale-caller
latest-epoch adoption, or weakening pending/no-effect assertions. Public Agent's
earlier state reduction and all raw SDK/private/controller/backend/provider/UI/FS
effects are not collectively covered. Fixed backend retries, genuine authenticated
reviewer journeys, immutable policy/artifact binding, cold/crash/restart recovery,
complete host acceptance and rollout gates remain OPEN. Synthetic authority and
loopback SSE establish no human authority, same-OS isolation or release readiness.
