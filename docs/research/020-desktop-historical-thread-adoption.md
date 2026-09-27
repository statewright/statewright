# Desktop historical-thread adoption receipt

Date: 2026-09-27. Base: `83fbf621cd1facd0bc3ad753c5568bcd0371210b`.
Scope: source-only Milestone 5a; no native UI attempt, workflow activation,
install, rollout, deployment, push, production edit, or outbound message.

## Finding and decision

The Desktop broker previously accepted only its registered thread, so a user
selection from native history was rejected before vendor RPC. Removing that
check would allow cross-session or cross-project attachment. Rebinding during
the pre-forward check was also unsafe because a failed native resume would
strand the prior valid root.

The bounded repair prepares a versioned 30-second ownership transfer only for
an original downstream `thread/resume`. Preparation requires the current
managed client plus immutable rollout metadata proving identical source and
destination `cwd`. The route proxy correlates the transfer by the original
JSON-RPC ID and commits its compare-and-swap only after native success returns
the exact requested thread. Error, mismatch, disconnect, expiry, changed root,
foreign client, missing metadata, or different root fails closed. The version-2
root record retains the transfer ID, source, destination, client, canonical
root, issue/expiry time, and adoption time. Internal replay/resume does not
prepare a transfer.

## Evidence and remaining acceptance

Focused regressions cover allowed adoption, wrong managed session, wrong root,
expired and changed-root transfers, failed native resume preserving the old
root, matching success committing once, delayed old-root turn denial,
upstream/internal resume exclusion, synchronous reservation against concurrent
picker selections, fail-closed cross-writer serialization, and temporary-file
cleanup after failed atomic replacement. The generated Desktop runtime mirror
is synchronized and checked from executor source.

Crash-left mutation-lock reclamation is intentionally not implemented in this
slice: an existing lock denies later root mutation rather than risking an ABA
unlink of a newer owner. A separately designed recovery path must prove atomic
lock identity before removing one.

Native Desktop picker attachment remains unattempted and unproven. A later
authorized acceptance must select a same-root historical thread in a disposable
fresh Desktop session, observe successful native resume and subsequent turn,
then verify foreign-root, failed-resume, restart, and disconnect behavior. That
gate must not reuse an active user session or imply rollout/production approval.
