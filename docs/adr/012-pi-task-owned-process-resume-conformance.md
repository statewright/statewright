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

Limits: SDK child-process restart is real; parent owner/controller reopen remains
same-process, not full executor-process crash/restart. Forced crashes, stale locks,
legacy recovery, actual socket-dropped begin responses, failure-drain, authenticated
reviewer/UI/installed hosts and all original P0/P1 obligations remain open. Revisit
when task-owned full-parent crash conformance and genuine native acceptance become
available; these fixtures cannot serve as release certification.
