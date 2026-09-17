# ADR 008: native approval release belongs to the parent request ledger

Date: 2026-09-17. Status: accepted prerequisite; production activation and full
P0/P1 acceptance remain incomplete. Base: `5862532`.

## Decision and authority

The executor owns an additive `statewright/executor-request/v1` record inside
its lifetime-locked session record. It mints a UUID and increments a durable
epoch for each explicit native input, retaining only its SHA256 digest, exact
native identity, phase, approval checkpoint, release nonce and consumed-ID
tombstones. Serialized, atomic fsynced writes precede admission responses.
Old v1 session records remain valid only with no request ledger and epoch zero.
Unclassifiable/partial/foreign records fail closed without repair or adoption.

The private Pi-only loopback protocol accepts begin/status/consume/cancel, not
decisions, checkpoints or caller-chosen authoritative epochs. Begin requires
the exact owned native session and a strictly increasing per-parent input
sequence. Its synchronous invalidation prevents old asynchronous results from
becoming authority for replacement input. The model's tool arguments cannot
substitute for the private outer request reference. Owned MCP/pre-tool/post-tool
effects check current request identity and fresh run/session identity around
awaiting work. No approval-resolution endpoint is exposed.

An approval journal remains durable while pending or rejected. Read-only private
receipt plus a fresh applied owned edge can issue a nonce for the current
request. Consume rechecks that authority, durably records its once-only
tombstone, verifies that consumption before journal clearance, then rechecks
current identity and the applied edge. A known failure after consumption
invalidates delivery and requires fresh explicit input. A restarted controller
never adopts an old native request reference; an existing tombstone can repair
the journal but cannot reissue the consumed continuation. Crash owner locks are
still recovery-required, never stolen by PID/age heuristics.

## Native SDK boundary and activation constraint

Project model/thinking/tools/metadata and runtime provider registration APIs
checkpoint their private caller before invoking native mutation. Fixed SDK
bind-time configuration uses a private lease revoked when binding completes;
project callbacks mask that lease and can only use the designated read-only
bootstrap observation path. Native configuration writes and metadata appends
check the original private request before mutation; public configuration views
are read-only snapshot facades, including frozen model records. Unadmitted
native UI/RPC configuration gestures still need their own owning input adapter;
they do not gain authority from the latest request or bootstrap permission.
Property descriptors return the same guarded views, not raw nested records or
the native tools setter. Configuration fields cannot be reflectively redefined
or deleted; ordinary SDK assignments remain guarded. The required public SDK
configuration methods are checked before installation mutates the session.
Only a privately marked native-configuration denial from an actually superseded
or privately native-cancelled prompt is handled as obsolete input; current denial
and unrelated errors surface.

The owning RPC mode holds a separate configuration-input capability, absent
from project APIs and SDK session mutators. Its inlet routes only strict
set/cycle model, set/cycle thinking and session-name records, immediately
capturing a cloned private explicit input before model-registry lookup can
await. Inherited/project scopes cannot mint input through this capability;
normal raw SDK setters still cannot borrow the latest reference. Mutation is
checkpointed and the correlated RPC response is emitted only after completion,
with the native SDK response shape and no inference. Invalid authority-bearing
or malformed configuration fields fail before admission, not through an SDK
fallback. No RPC decision/resolution operation is added.

SDK0.73.0 public runRpcMode accepts only runtimeHost and uses process.stdin;
thinking/name methods are synchronous in its command switch. An async session
proxy would serialize a promise or report success before the parked write.
The task-owned mode instead temporarily substitutes its filtered stdin and
captures stdout's raw writer before SDK takeover. Every other JSONL record
continues through the original SDK dispatcher; bind/readiness, UI dialogs,
events and shutdown remain SDK-owned. LF-only UTF8/CRLF and final non-LF framing
match the installed jsonl.js source. Input consumption starts only when the SDK
attaches its reader after native bind; EOF/error/close synchronously invalidate
owned continuation and suppress late replies. Restore the process descriptor
and detach the inlet on return/failure. This is confined to the newly owned RPC
process, not existing sessions, a vendor patch or a universal process interceptor.

Interactive settings/selectors/hotkeys still require separate trusted gesture
wiring that captures at invocation rather than after selection awaits. CLI
startup configuration is already fixed before guarded runtime construction;
neither that bootstrap nor the native RPC inlet authorizes remaining settings,
provider internals, filesystem/process/branch or publication effects. Revisit
this small adapter when the public SDK offers input/command interception or
awaits these mutators; remove the inlet substitution then, preserving its native
RPC race/framing/authority tests. No production or complete-gesture activation.

### Owning native cancellation (Slice17)

Native modes receive a separate runtime/session/Agent view, never installed on
the real SDK session or exposed to project extension contexts. Its Session.abort
and Agent.abort invoke a private frontend cancellation capability; inherited
project scopes cannot use that capability to become human input. SDK0.73.0 RPC
abort otherwise stops only Agent/retry, leaving parked private input alive.
Interactive Escape otherwise sees isStreaming=false while input is parked; the
mode view adds private pending-input visibility so the original SDK key handler
and queue restoration method use the same native cancellation path. The actual
SDK prompt/configuration methods remain bound to the real session; do not feed
the synthetic streaming flag back into its steering/queue decisions.

Cancellation synchronously replaces the private input marker before any wait,
invalidates final response/queues, cancels the captured gate, and aborts only the
captured owned Agent whose native signal/reference still match. Signal/queue
callbacks can start newer input: recheck the private marker and captured handle
before SDK abort, never re-read latest work after awaiting cancellation. Old
input completion cannot clear newer pending visibility. Keep readiness enabled
for a new explicit input; do not resolve approval or clear its durable journal.
RPC acknowledgement awaits this cancellation boundary, not a detached mutation.
Interactive void abort callers observe rejection without fallback or new work.
The private native-cancel marker retains its exact reference for late SDK/project
callback handling. An explicitly cancelled continuation is obsolete, not a
current request whose ordinary parked/cancelled phase can hide genuine errors.
The marked SDK mutation denial is handled without inference; inherited callback
failures from that obsolete reference cannot revoke newer/native readiness.
No phase-only failure suppression or project-supplied cancellation marker.
SDK interactive shortcuts synthesize ctx.abort from the mode session and execute
outside prompt ALS. Wrap/seal registerShortcut like other project registrations;
unbound project callbacks enter a private project-unbound scope with no reference,
never absence-of-scope native input authority. SDK synthesized abort cannot mint
or cancel input from that callback or its inherited async work. No implicit latest
reference is assigned. This closes the newly introduced mode-capability exposure,
not complete owning admission/effect coverage for arbitrary project hotkeys.

Public SDK modes lack a native-control interceptor. A mode-only view preserves
their original dispatcher/key handlers without a vendor patch, copied dispatcher,
or treating every raw session abort as human authority. Revisit/remove it when
the public SDK supports owning cancellation injection; retain native RPC/Escape
and late-reply/new-input tests. Before a lost begin response the native input is
invalidated but durable parent reference cancellation is not proved; complete
crash/restart reconciliation remains required. Raw project abort, compaction/
retry/branch controls, full TUI gesture/rendering and remaining native effects
are not collectively proved by this cut. Rollback is a scoped source revert,
preserving journal/owner/native records; no durable schema or live runtime change.

Installed SDK0.73.0 cycleModel awaits its public registry before writing model,
history and settings. Its task-owned registry wrapper checkpoints the one
available-model handoff in that private cycle scope, retaining synchronous
public registry reads elsewhere and the SDK's original selection/event logic.
Scoped cycles use their original no-registry-await path. Native stale-write
guards recheck ownership at actual mutation after the async handoff. Revisit
this narrow integration if the SDK changes that public call sequence; not a
claim that all SDK or SettingsManager/ModelRegistry mutation paths are guarded.

Secondary project HTTP (docs, classifier, custom provider and telemetry/run-log
helpers) captures the private calling request before dispatch. Initial fetch,
body decoders and default-reader reads checkpoint that same reference, combine
epoch/caller cancellation and drop old results even when the transport ignores
abort. Provider callbacks restore project scope at invocation without capturing
the registration epoch. Managed fetch disallows automatic redirects and raw
body pipe/tee/BYOB consumption; these are not used by project consumers. Normal
standalone HTTP remains unchanged. This is not an interception boundary for
arbitrary code, all SDK/provider transports or provider stream publication;
native configuration and remaining filesystem/process/branch effects are open.

The Pi gate awaits private status outside inference and returns the SDK input
event's `continue` only for an active current parent request. It is disabled
until explicitly enabled after hook registration. Managed errors, invalid
native identity, malformed status, cancellation, rejection, timeout and obsolete
responses return `handled` or block the tool callback; exceptions do not escape
to the SDK's fail-open hook handling. Transport waits have cancellation and
timeout bounds even if an injected transport ignores its signal. An obsolete
callback must not invoke the SDK context's lazy abort against a newer agent.
Input explicitly waits for `ctx.isIdle()` after abort and before admission,
including awaited real-agent end listeners. Checkpoints require a captured
private request reference, not the current reference fetched by a late callback.
Missing or foreign references cannot authorize either continuation or abort.

Primary source: installed Pi SDK 0.73.0 `dist/core/agent-session.js` and
`dist/core/extensions/runner.js`. `ExtensionContext.abort()` discards the
underlying idle promise; it does not prove the old operation has stopped.
The original public AgentSession/ExtensionRunner + loopback bridge + durable
owner/journal fixtures retain terminal fake-agent evidence. The additive
`request-agent-native.spec.ts` uses public createAgentSession, actual Agent,
factory-installed onPayload, primary openai-completions adapter, real SDK tool
hooks, automatic AgentSession retry and manual compaction. HTTP is task-owned
loopback with inert SSE/tool-call responses; authority remains synthetic and
no model inference, real provider, workflow, user config or native session file
is used. Replacement steer/follow-up input cannot enter real SDK queues while
an awaited old agent_end listener keeps the old Agent non-idle.

`installPiRequestGuards` requires a private operation correlator; it has no
current-cache fallback. The SDK catches before_provider_request exceptions and
has no cancellation result. Guards therefore return a payload proxy that
allows the inert `then` promise-assimilation probe but rejects denied payload
use outside that catch. An admitted payload rechecks current reference, native
identity and captured Agent signal synchronously when consumed. Actual primary
adapter HTTP fixtures prove the tested holds and identity/cancellation failures
dispatch zero additional requests, including foreign-session denial without
aborting that session. Compaction uses its distinct captured event signal.
Guard registration must be last and managed extension loading exclusive; a
later handler could replace a payload. These are adapter-specific prerequisites,
not a supported universal provider cancellation API or a lease across later
SDK auth/header/routing/transport awaits or internal HTTP retries.

This commit does NOT wire the controller into executor main or the gate into
the shipped Pi extension. Existing ADR 007 hold behavior remains in force.
The earlier text-digest fixture binder is superseded by
`createPiRequestOperations`, installed on a task-owned public SDK session before
input. Private AsyncLocalStorage scopes carry an immutable reference, bound
once by gate onAdmit inside the original explicit interactive/RPC call.
Template expansion cannot change it; overlapping same-text calls cannot adopt
the newest input's reference. Guarded Agent prompt/continue entry rechecks it
after pre-start awaits and before actual Agent start. SDK event processing,
AgentSession retry and automatic threshold compaction retain that originating
scope in the installed 0.73.0 fixtures.
An opaque claim is assigned synchronously at every external explicit entry.
SDK input hooks reject stale claims before admission, because slash/template
lookup awaits before those hooks. An inherited private call cannot claim human
origin by setting source=interactive/RPC; user frontend entries must be outside
that scope. The known exact-owned active Agent signal/reference is captured at
actual start and interrupted at explicit entry, including command-only calls
that never emit SDK input. This is not heuristic active-session discovery.

Extension sendUserMessage inherits a captured private reference and checkpoints
without minting a human-input epoch; unbound extension calls are held. Timers
and detached correctives must capture a private bind callback when armed,
not when fired. Explicit replacement invalidates before SDK commands/preflight
and clears owned steering/follow-up queues. Next-turn custom asides remain in
a bounded private reference-owned queue, appended only at an admitted actual
Agent entry for that request. They never inhabit SDK's unowned shared pending
queue. Manual compaction may capture current ownership only at a truly external
manual entry; an unbound or stale existing context cannot borrow it. Owned close
aborts the exact-owned SDK Agent, cancels parent ownership and keeps entry
guards installed for late timers. Native-session drift cannot authorize abort
of a foreign session.

This requires an owning SDK frontend. The stock shipped Pi CLI/extension does
not expose its AgentSession object for this installation; it is not activated
or silently monkey-patched through global discovery. No installed SDK sources
are edited. Future managed launch must use the public SDK frontend/runtime
contract and exclusively install these guards before readiness. Native command
effects, resource/runtime replacement and every remaining async effect/native
final-response/SDK transport boundary still need exact captured ownership before
activation. Arbitrary commands bypass SDK input; wrapper invalidation alone is
not authorization for their project effects. SDK custom/bare paths not guarded
by this owning frontend must not be advertised as supported. AgentSession retry
is tested with primary HTTP client retries explicitly zero; default/internal
provider retries and compaction's later separate summary subrequests are not
proved across authority changes. Dependency compatibility is source-bound
evidence, not a version pin. No full native acceptance is implied.
No live/native authorized approval journey, deployment or promotion is claimed.

### Experimental parent composition (Slice13)

Executor main now has an explicit --pi-request-frontend path. It creates or
validates and binds the exact native descriptor before constructing the owned
bridge/controller/readiness; the approval mirror uses deferred clearance.
The host adapter launches the existing fixed plugins/pi/request-main.mjs through
the current Node executable, with a private exact readiness challenge, native
file, agent directory and explicit provider/model route. Stock executable,
extension/session arguments, ambiguous model routes and unsupported startup
modes are denied; failure never falls back to stock Pi. Startup-task modes are
interactive/text/json; native RPC remains supported by the fixed standalone
entrypoint but has no initial-task parent launch contract in this cut.

Observer binds the child handle actually spawned before accepting readiness,
awaits the exact once-only acknowledgement and does not apply legacy termination
to an owning parked frontend. A private acknowledgement completion latch allows
a fast print child to complete correctly; it is not live readiness authority.
Child exit/error/parent stop still revokes readiness and disconnects the request.
Readiness failure revokes before stopping/reaping the child, even if durable
cancellation itself fails; parent cleanup still closes its bridge/releases the
owner on that failure. Parent stop revokes before SIGINT can become a new input.
Owned project callbacks use only the private bridge and do not recover a removed
privileged gateway key from the parent's key file. This is not OS isolation.

Acceptance is synthetic authority with real durable ownership/journals, native
JSONL, fixed project registration, actual public SDK/Agent and fixed print CLI
children launched through the actual parent composition/observer. A cold parked
owner retains the same native descriptor, creates a newer request epoch, waits
without model traffic on projection-only clearance, then consumes one private
release before one loopback SSE response/native append. Real main attachment/
workflow loading, authorized reviewer/resolver, real model inference and headed
interactive rendering are not exercised. This flag is experimental integration,
not production activation: the default remains ADR007 hold-only, and all remaining
effects/render/transport/authority/restart/cross-host requirements below remain.

### Owned native commands and message output (Slice12)

Public SDK0.73.0 extension commands run before its input hook. The owning
frontend therefore admits a registered command privately before invoking its
project handler; an inherited call retains its original reference rather than
minting human input. Native executeBash also has a private explicit-entry claim,
gate admission/checkpoint before backend execution, combined epoch/backend
cancellation and ownership checks before SDK output accumulation, chunk
delivery, recordBashResult and return. External native bash invalidates the old
request synchronously; closed/unready/stale calls cannot execute. Inherited bash
while Agent streaming is denied rather than entering the SDK's unowned pending
bash queue. Unbound direct recording is denied. Native abortBash/status track the
exact private run: an older SDK bash finally cannot clear a newer run's control.
This guards the owned API; it is not arbitrary subprocess/OS isolation.

SDK AgentSession awaits project message hooks before notifying public subscribers
and writing message history. Owned subscribe and the public SessionManager
appendMessage/appendCustomMessageEntry boundaries independently recheck the
originating private call after those awaits. Queue-update control observations
are distinct from message effect authority. External prompt completion drains
public agent_end delivery (or private cancellation/close) so synchronous text
selection cannot race queued message processing. Each actual Agent entry has a
distinct opaque output-run token as well as its request reference; first output
delivery cannot settle another nested run under the same request. Core turn
completion itself never waits for SDK publication: an awaited message hook may
start/await a nested owned turn without circularly waiting for the delivery queue
behind that hook. The bounded private output queue is settled on delivery,
startup error, private cancellation or owned close. A readonly mode view gives
stock public runPrintMode only the most recent privately owned delivered
assistant response, not the last shared Agent message. Command-only/handled
input clears that candidate synchronously; it cannot print old cached finals.
No vendor SDK sources or process-global output hooks are modified.

Evidence: actual public SDK/Agent/local SSE, task-owned native JSONL fixtures
and actual owning text/RPC CLI children. Authority remains synthetic. Existing
SDK defers the first native history flush until an assistant exists; a bash-only
first session's durable history is not claimed. Message write guards prevent
obsolete append entry, not a new fsync/crash-durable SDK history protocol.
Asynchronous interactive handleEvent/render continuations, buffered sink leases,
all other SessionManager mutations, global project state/direct filesystem/
spawn/configuration/provider/telemetry and provider internals still require
ownership before production activation. These limitations retain the full
original contract, not unsupported paths declared accepted. Parent main/
observer/host launcher wiring and full real-authority/cold-resume/cross-host
acceptance remain open. Legacy hold-only behavior stays monotonic.

Additive `createPiRequestFrontend` now owns public SDK services/session/runtime
construction for one exact parent-bound native UUID. One managed extension
factory registers trusted project hooks first and final admission guards last;
its namespace is read-only and hook API sealed afterward, including functions
captured before sealing. Final guard registration uses the privately captured
original SDK on function, not a setup-replaced property.
SDK-collected extension errors and an independent public runner error listener
deny readiness even when the SDK catches handler exceptions. Input stays held
through awaited session_start, resource discovery and readiness publication.
A versioned immutable native-identity receipt is produced only by this owned
construction path; parent private IPC acceptance/delivery wiring is still open.
Native drift/close/registration violations cannot enable or retain readiness.

SDK reload and runtime new/switch/fork/import are intercepted before underlying
replacement and require a fresh parent/native binding. The existing parent
record is exact-UUID-bound, so automatic SDK identity adoption would violate
ownership; a full authorized replacement protocol remains a later requirement,
not removed from scope. This frontend has no production CLI entrypoint or mode
activation yet. Its initial UI binding is once-only; failed constructor and
close paths dispose only their owned SDK object, leaving late guards installed.
Bare SDK effects, project commands/exec, async final output, provider internals
and full parent close/drain remain unproved. No readiness receipt is a claim
that these original production acceptance requirements have been satisfied.
Shipped executor and installed runtime remain unactivated. ADR007's legacy
hold stays monotonic; the owned project capability is described below.

The additive private readiness negotiation binds the exact parent owner and
request controller, existing native UUID/file, executor ID and fresh random
parent/child lifetime IDs. The parent must explicitly bind its owned child
handle; these IDs are launch challenges, not claimed kernel peer credentials.
They and acknowledged process readiness are ephemeral and never adopted from
the durable host_ready descriptor. One private Pi-only ready receipt can obtain
one exact acknowledgement; duplicate/concurrent/foreign/extra-field receipts
cannot. The ordinary hooks/ready plugin identity does not activate this mode.
Request delivery and declared MCP/pre/post/stop bridge effects require this
readiness; locally observed revocation is rechecked synchronously at dispatch
and after awaited callback/telemetry work. Close/child exit/error or descriptor/
owner drift revokes monotonically and cancels the parent request controller.
Bridge HTTP shutdown runs even when cancellation fails.

The trusted frontend readiness publisher validates the SDK receipt and exact
public SessionManager UUID/file around private IPC, validates every returned
acknowledgement field, claims publication once and bounds a lost acknowledgement
even if transport ignores abort. File-backed frontend/gate checks also capture
the original file; preserving the UUID cannot authorize a substituted native
file. Memory-only SDK fixtures remain supported without advertising production
readiness for them. An acknowledgement proves only this configured trusted
construction/transport boundary, not every project effect/provider/final-output
guard or reviewer/human authority. The local bearer transport and a model API
key are not a new isolation/human-strength proof. A trusted project callback
with bearer/challenge access is not a cryptographically measured SDK process.
No production SDK mode/CLI launch is activated by these fixtures. Parent
main must explicitly construct this mode and forward its own challenge; it
still does neither. Protocol-unconfigured legacy bridges retain existing
behavior; managed activation must require this mode, not silently fall back.
No controller-close/full parent inflight-drain/crash-lock promise is inferred
from this prerequisite; these remain original acceptance obligations.

An additive managed CLI now constructs this frontend and invokes public SDK
text/JSON/RPC/interactive modes, not stock main or an injected global session.
Launch requires a strict private configuration with an existing validated
UUID/file/cwd descriptor, exact configured model and owned agent directory;
conflicting session/discovery/unknown arguments fail before native mutation.
Challenge UUIDs require strings, never coercible JSON arrays or objects. Fixed
project registration requires the actual process environment, so its own
gateway settings cannot diverge from the captured private transport settings.
Only fixed 127.0.0.1 HTTP request hooks receive its captured local bearer;
redirects are rejected, response bytes and transport time bounded. The native
private transport requests Connection:close, owning a per-action connection;
delayed500ms child polling reproduced a global-fetch-pool idle-reuse stall
while server-close passed. No timeout enlargement, retry, global dispatcher
patch or authority fallback. Exact upstream pooling internals are unproven;
revisit only with a request-owned IPC dispatcher preserving delayed/close and
authority limits, not a presumed Node-wide fix.
The private input hook is installed before project input. Only the trusted
per-call ownership capability can replace a project's monotonic hold only
after the private gate consumed its exact held approval ID for that request.
Continued ownership, a new projection, missing/foreign proof or old durable
tombstones cannot do this. The gate's ephemeral per-request proof is recorded
only after checked ready->consume->active; outside/stale/closed scopes cannot
borrow it. Malformed/read-failure holds have no consumable ID and retain explicit
recovery requirements. Project admission reads recheck ownership before cache mutation;
obsolete read failures cannot invoke lazy abort or notify for newer input.
Standalone and legacy managed hold-only registrations have no such capability
and retain ADR007's monotonic denial. This integrates the owned CLI admission,
not every later project callback, command effect or final-output boundary.
The native
mode itself binds extensions once, awaiting private acknowledgement before
the gate enables. Registration loads the fixed project TypeScript module with
the upstream jiti family, explicitly declared/locked2.6.5, no transpilation
filesystem cache or caller-selected extension paths. CLI project diagnostics
go to stderr; SDK raw text/JSON/RPC output remains stdout. Optional stage
diagnostics report mechanisms, not launch payloads/credentials or prompts.

Actual task-owned subprocess fixtures cover text/JSON/RPC with real SDK and
private parent bridge and inert HTTP. Interactive dispatch exists but headed
TUI is unverified. Project hold-only hooks retain legacy behavior without the
private ownership capability. Actual owned text/JSON/RPC fixtures now prove
pending approval waits outside inert HTTP inference and re-admits only after
its fake private receipt is consumed once; projection clearance alone retains
the journal and zero provider requests. This is synthetic authority, not a
real reviewer/gateway canary. Native SDK bare
commands, navigation, provider internals and stale final-output ownership are
not collectively guarded/proven. This CLI is uninstalled and unconnected to
production launcher/main; its launch configuration is not a new activation
fallback. Project session_shutdown disarms its owned inactivity timer and
prevents rearming/corrective delivery after shutdown, allowing tested print
children to exit naturally rather than forcing process exit or unref masking.
This does not claim all detached project effects have been drained.

### Project exec and bridge effects

Owned registration and its hook/tool/command callbacks enter a trusted project
effect context. The immutable inherited binding carries both project context
and the original private SDK call; an outside callback cannot borrow the latest
reference. Project exec and API messages require current ownership, a fresh
parent checkpoint and a final ownership check around their awaited dispatch.
Exec receives the private request cancellation signal combined with any caller
signal. Superseded results are denied rather than returned to authorize another
effect. An old SDK-collected callback error cannot close a newer owned request;
current/control registration errors still revoke readiness. This is not arbitrary
code interception, malicious-agent isolation or an inference-internals lease.

Managed pre/post-tool and interrupt routing selects the immutable ownership
mode, not a later environment value. A post-tool failure rechecks inherited
ownership before notification or lazy abort. Error suppression applies only to
an actually superseded or privately native-cancelled reference/arrival (including
preflight), not a current
request merely parked/cancelled: genuine current SDK callback errors revoke
readiness even while held. Phase denial is not evidence of supersession.

Project MCP/adapter effects carry request_reference outside params.arguments
and tool_input; model values cannot retarget that binding. State observation
alone may run during read-only startup control, never mutate/release a request.
The project bridge endpoint/token are captured at owning construction; managed
traffic rejects redirects, uses per-action Connection:close and combines its
existing transport deadline with request cancellation. Missing private bridge
denies dispatch/initialization, never falls back to standalone gateway routing.
Legacy unmanaged transport remains explicitly separate. API message methods
return an awaitable denial; void callers have a rejection observer but no retry
or alternate unowned delivery. Project timers/correctives/permission changes
check their inherited ownership; private failure cannot fabricate a final state.

Actual SDK/Agent, task-owned exec and loopback parent fixtures prove current and
stale dispatch, parked exec with durable consumed-before-clear ordering, real
project pre/post-tool reference propagation and old callback-result/error races.
These use synthetic authority only. Direct project filesystem/spawn, configuration
and provider/telemetry callbacks, bare native commands/final rendering, complete
resource drains/cold restart and production parent/main activation remain open
original acceptance requirements. Rollback is a scoped revert preserving journals
and native records; revisit broad claims only with their specific source/runtime
journeys, not a green transport test.

## Consequences and rollback

Safety wins over replay availability: at-most-once durable consumption is
proved here, not an exactly-once native acceptance promise across process or
transport failure. Lost delivery requires explicit input. Tombstone capacity
is bounded at 256 IDs; overflow denies new consumption and requires explicit
recovery rather than eviction/replay. Raw prompts and private credentials are
not stored in the request ledger.

Rollback is a scoped commit revert with existing journals/ownership records
preserved. Once a nonzero ledger exists, the prior reader must not be used to
resume it; validate/recover explicitly, never delete its evidence. No installed
runtime or live native session is changed by this prerequisite.
