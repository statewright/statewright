# Cross-host blocking and in-situ approvals

Status: research baseline; production promotion held. Inspected 2026-09-16.

This is the capability investigation for Statewright and The Praetorian Gate,
not an announcement that enterprise governance works across every client.
The machine-readable inventory is [006-control-plane-host-matrix.json](006-control-plane-host-matrix.json).
Existing [plugin smoke coverage](../specs/plugin-release-production-smoke.md)
remains useful, but measures a different boundary.

## Decisions for this audit

- Keep Statewright deactivated in the supervising session. Turn reconciliation
  is under investigation; do not depend on its routing loop to audit itself.
- Hold staging-to-production promotion. Do not interrupt existing sessions or
  resolve real approvals as part of research.
- Separate companion-assisted Codex from standalone Statewright, and separate
  vendor-owned desktop sessions from Statewright-owned app-server sessions.
- Prefer a native host dialog or embedded app. The Statewright website can
  remain an alternative review surface, not a mandatory decision surface.
- Deliver the inventory, acceptance cases and next implementation cut. This
  audit does not implement all adapters or certify live desktop/Windows journeys.

Inspected base identities (all working checkouts were dirty):

| Checkout | HEAD |
| --- | --- |
| Statewright | `76d156c6feac264394292fc1b2f8728193d599a1` |
| Auldwyrm | `65025b50952e27b38b215b18905ba1c4770fbdb4` |
| codex-local-models | `7e05b071cc34d879c04f4e8591e1e07c3f8afa30` |

Source paths refer to inspected worktree content, not a claim that every change
is in HEAD.

## Three capabilities, not one

1. **Gate authority:** prevent a particular workflow transition or declared
   consequential effect until policy is satisfied.
2. **Human interaction:** show evidence, required reviewers and available
   decisions through the host's real input protocol, outside model inference.
3. **Safe release:** accept an authorized, fresh decision and release the same
   run/action once, without stale completion overriding newer user input.

An MCP server can refuse its own operation. Connecting it does not make it an
interceptor for unrelated shell commands, hosted tools or another connector.
A native permission dialog also does not by itself enforce reviewer identity,
artifact binding or a workflow approval policy.

## Observed implementation matrix

"Code" below means inspected implementation, not fresh live acceptance.
Every exact-current approval journey remains unverified in this audit.

| Surface | Policy boundary | Local approval today | Routing / principal gap |
| --- | --- | --- | --- |
| Codex TUI, standalone Statewright | Supported hooks/adapter; legacy cache has exemptions | Experimental managed native form, private resolver and journal now wired | Source lifecycle fixtures pass; vendor protocol verified; live staging journey pending |
| Codex TUI, companion | Managed proxy plus Statewright policy | Experimental native form + private resolver + journal | Current exact-runtime soak needed; not standalone evidence |
| Codex desktop | Supported hook/MCP scope must be probed | No integrated workflow gate proven | Stock app-server ownership/attach not established |
| Claude Code TUI | PreToolUse/adapter denial code | Browser evidence review, not a native decision loop | Managed routing exists; native elicitation transport/controller missing |
| Claude Desktop, local Code tab | Shared hooks documented; integration untested | Native route feasible, not implemented here | Does not inherit CLI shim routing automatically |
| Claude Desktop, Chat | Connector's declared operations only unless independently proven | Embedded MCP App feasible | No general tool interception claim |
| Claude Desktop, Cowork | Own connector/runtime boundary; not Chat acceptance | Embedded MCP App feasible | Independent blocking, routing and resume proof required |
| Claude Agent SDK custom host | PreToolUse plus host-owned tools | Custom awaited UI feasible | Integrate Statewright privately; canUseTool alone is insufficient |
| Native Windows Codex / Claude TUIs | Bootstrap and MCP proven in CI | Interactive gate not tested | Native hooks, vendor turns and resume still need acceptance |
| WSL Codex / Claude TUIs | Guest-specific configuration unverified | Interactive gate not tested | Native Windows receipts do not cover WSL |
| Windows desktop / Code-tab WSL | Separate vendor GUI/guest boundaries | No live gate tested | Neither CLI nor macOS acceptance covers these rows |
| OpenCode | Adapter pre-tool code | Pending-review toast | Toast suppresses auto-continuation, but no authenticated decision loop |
| Pi | tool_call block plus strict adapter error handling | No native decision controller found | Standalone cache behavior and resume require separate proof |
| Cursor | Hook permission deny; strict adapter failure denies | No private decision loop found | Non-strict network failure currently allows |
| OMX | Hook/adapter code | No private decision loop found | Fork instructions are not approval-isolation evidence |

Evidence paths and explicit capability states are in the JSON inventory.
The inventory contract test checks coverage and evidence classification, not
the behavior of every row.

## Native protocol findings

### Codex

App-server exposes server-initiated command/file approvals, structured user
input and MCP elicitation, followed by `serverRequest/resolved`. Our managed
host can use a real form request for a workflow gate; it must not fabricate a
shell/file approval for an unrelated transition. This is protocol feasibility,
not permission to attach to a stock desktop's internal process.
[App-server documentation](https://learn.chatgpt.com/docs/app-server).

Codex documents `PreToolUse` coverage for shell/unified exec, apply_patch, MCP
and local function tools, including `spawn_agent`/`Agent`. Hosted tools and
some specialized paths are excluded; write_stdin does not re-run pre-tool
checks. Crucially, `permissionDecision: ask` is currently unsupported and
reported as a hook failure while the tool continues. Use a real input request,
not that output, to implement a gate. Subagent hooks reporting a parent session
ID also do not establish isolated branch authorization.
[Hooks documentation](https://learn.chatgpt.com/docs/hooks).

### Claude

Claude Code automatically presents MCP form elicitation dialogs and supports
URL-mode flows. That is the first path to prototype before inventing a tmux
UI. Form fields must contain no secrets or decision credentials.
[MCP documentation](https://code.claude.com/docs/en/mcp),
[elicitation specification](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation).

Claude PreToolUse can deny or ask. Non-interactive `defer` can preserve a
pending tool for a custom host to resume; interactive sessions do not honor
that value. A generic permission ask is not yet an identity-bound workflow
approval. Elicitation hooks can programmatically answer dialogs, so an
enterprise human-only policy needs an explicitly trusted decision channel,
not an assumption that every accepted form was clicked by a person.
[Hooks documentation](https://code.claude.com/docs/en/hooks).

The Agent SDK's canUseTool callback runs after earlier permission decisions;
auto-approved calls skip it. PreToolUse is required for the declared policy
coverage even with bypass permissions or broad allowedTools. Awaiting a custom
UI belongs in the host/controller, not a model-callable approve tool.
[SDK permission ordering](https://code.claude.com/docs/en/agent-sdk/permissions).

The Desktop **Code** tab shares local CLI hooks/settings, and plugins can be
installed through its UI. WSL sessions have separate documented restrictions.
This makes local Code-tab policy integration a worthwhile probe; it does not
prove shim-based model switching. **Chat** and **Cowork** support interactive
MCP Apps, which could contain an evidence/decision panel. That panel's scope
is connector operations until additional interception is proven.
[Desktop Code reference](https://code.claude.com/docs/en/desktop),
[interactive connectors](https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude).

## Transport defect to address, not hide

`ManagedMcpBridge.start()` accepts only POST `/mcp`, uses a 15-second default
request timeout, buffers `upstream.arrayBuffer()`, then ends the response.
It cannot deliver a long-lived request's elicitation to the host promptly while
awaiting that host's reply. GET event streams are rejected. This is not a
bidirectional Streamable HTTP implementation, even though completed SSE bytes
can pass through unchanged.

The upstream stdio manager also reads one line as the tool result instead of
dispatching interleaved notifications/server requests by JSON-RPC identity.
Native elicitation requires an actual duplex dispatcher and negotiated client
capabilities. Increasing a timeout or returning a pending JSON blob is not that
fix. Test all direct/proxy/managed/adapter paths that claim this capability.

For managed Codex, the companion already uses a private host resolver and
synthetic host input request without relying on gateway-side elicitation.
Port that lifecycle to canonical Statewright first; duplex MCP is a distinct
adapter milestone, not a prerequisite for extracting the proven Codex path.

## Required approval and request ownership contract

- Immutable ticket binds tenant/client, gateway session, workflow run, state
  edge, action/artifact digest, policy revision, reviewer requirement and expiry.
- Host binds its own thread, child/parent lineage, request ID and request epoch.
  Do not trust model-supplied identities to retarget the ticket.
- Pending means no declared effect and no inference continuation. Waiting for
  a reviewer is parked human work, not a costly turn polling via tools.
- Query authority before displaying controls. Unauthorized identities get
  required-reviewer information and dismissal only, never approve/deny.
- Cancel/dismiss/disconnect leaves the approval pending; a cold resume can
  reopen the same active gate after authoritative reconciliation.
- Resolve privately, recheck authorization/entitlement/artifact/policy, then
  consume the release once. Duplicate and late replies are harmless.
- New user input invalidates older continuation/final-response ownership.
  A decision may remain authoritative, but its old continuation must not finish
  or answer over a newer request. Reconcile the latest request before executing.
- Record decision source and authentication strength. An API key reachable by
  the agent is not strong evidence of a human click or malicious-agent isolation.
- Shared reviewer/evidence/retention semantics belong in the client-neutral gate
  contract; Statewright and Praetorian consume it without mandatory website UX.

Spec 114 retains the full artifact, policy, identity, evidence, expiry and
revocation requirements. This audit does not claim those proposed enterprise
requirements are already implemented.

## Smallest serial implementation milestones

### M1: standalone Codex approval controller

Extract companion controller/journal integration into the canonical shared
executor with injected gateway read/resolve and host send/record functions.
Do not import the local provider proxy, Python compatibility service or Qwen
configuration into the core approval package. The companion consumes the same
shared lifecycle rather than maintaining a divergent second implementation.

Acceptance: a clean vendor-model Statewright installation, companion disabled
and its endpoints absent, blocks a fixture effect; displays evidence/reviewers;
approve/deny/cancel/unauthorized/restart paths behave correctly. Newer-input,
stale-final, duplicate-reply and parent/child isolation tests are mandatory.
Authoritative gateway state and side-effect counters, not screenshots alone,
prove a single correct release.

### M2: Claude native in-situ gate

Prototype native MCP elicitation using an isolated direct server first; prove
the installed CLI version's dialog and cancellation semantics. Then implement
duplex transport/session correlation and a private authenticated decision path.
Keep hook enforcement independent from dialog presentation. Repeat the M1
ownership cases and prove denial under bypass permissions.

Only use a tmux popup if the declared host lacks a usable native input path.
The supervisor owns the parked ticket and private channel; tmux merely renders
choices. No stdin scraping, approval text injection or inferred consent.
POSIX tmux cannot be the Windows baseline.

### M3: desktop conformance probes

Run separate isolated fixtures in Claude Code-local, Claude Chat, Claude Cowork
and stock Codex desktop. Record app and bundled harness versions, effective
hook trust/config, endpoint selection and advertised MCP capabilities. Use
GUI-local configuration, not assumptions about zshrc inheritance. Verify
actual effect blocking, visible decision, cancel, disconnect and cold resume.
Do not relabel desktop model routing supported until host ownership or an
official per-turn integration has been demonstrated.

### M4: Windows acceptance and release soak

Extend Windows CI with credential-free real protocol/modal fixtures and all
ownership races. Keep vendor-authenticated live acceptance a separate, explicit
credential/interactive run; current Statewright canary credentials cannot
authorize provider turns. Pin vendor versions in receipts. Test native Windows
and WSL independently, including native launcher quoting, hook prerequisites,
browser launch and restart. A macOS test of a Windows-shaped path is not proof.

Before promotion, proposed release criteria are zero unauthorized/duplicate
effects or stale request termination across 100 deterministic ownership-race
iterations per supported runtime plus a 24-hour staging multi-session soak.
These thresholds are a proposal, not completed evidence or a statistical
security guarantee. Required live approval cases must pass on every surface
advertised as supported; unsupported ones remain explicit exclusions.

## Audit validation and availability

Standalone approval repair (2026-09-16): canonical controller/journal now live
in `plugins/executor/lib`, with `codex-approval-gate.mjs` wired through the
resident route proxy and `runtime-approval-service.mjs` using the existing
private host endpoint. No companion module is imported. Startup without Qwen
configuration is covered. UI disablement retains parking; newer input cancels
old automatic approval continuation. Completed tool results are forwarded
before interrupting, and release waits for the exact owning idle thread.

`task test:codex-native-approvals`: 153 deterministic tests passed. The installed
vendor binary `/opt/homebrew/bin/codex` (`codex-cli 0.153.4`) passed
`task test:codex-native-approvals:vendor`: actual native goal lookup, form-frame
presentation, reviewer label, cancellation with retained journal, zero native
turns started and zero approval decisions. This uses a local approval service
fixture, not a real staging ticket or a visual TUI certificate. Vendor process
cleanup also completed; the owned POSIX group includes npm's native child.
The native gate serializes safety work across connections, preserves the
upstream connection until pause acknowledgements arrive, and propagates wait
cancellation through asynchronous ownership checks before submitting a decision.
All 111 Codex source tests passed. The broader release gate is not green:
the pre-existing workflow edit in `agentic-engineering-default-v1.json` still
fails the public-repository private-endpoint scrub. That edit was preserved.
Live standalone pause/approve/resume and release-artifact packaging remain
pending. Production promotion stays held.

- `task test:plugin-transport-parity`: 9 passed, local mock transports/local
  tool exposure. No provider turn or approval release was executed.
- `task test:claude-routing`: 9 passed, hooks/bridge fixtures, including browser
  review request. Not a live native Claude gate.
- `task test:control-plane-audit`: 13 passed, inventory contract and standalone
  hosted handoff fixtures. No companion module/provider endpoint is invoked by
  the hosted handoff fixtures. Not native TUI/desktop visual acceptance.
- Latest Windows CI: successful run 34412959623, 2026-09-09,
  source `bab1393dc6ba2f95a86b30d444e71f1a5b25106a`.
  [Run](https://github.com/statewright/statewright/actions/runs/34412959623).
  It proves bootstrap/deterministic routing/read-only production MCP, not the
  current dirty checkout or an authenticated interactive vendor session.
- Claude app installed locally: 1.5354.0. ChatGPT app: 26.818.31338, with
  bundled `codex-cli 0.149.0-alpha.4`. No desktop session was altered or gate tested.
- The bundled Codex binary's non-experimental `app-server generate-json-schema`
  output contains `mcpServer/elicitation/request`, command/file approval requests,
  `item/tool/requestUserInput`, `serverRequest/resolved` and `mcpServer/tool/call`.
  Generated into an owned temporary directory, parsed as JSON and removed.
  This verifies the installed protocol vocabulary, not GUI rendering or access
  to the desktop-owned process. No provider authentication/inference was used.
- No Windows GUI/provider session was launched. Those acceptance results are
  unavailable, not passes. No production promotion, real approval resolution
  or live workflow activation occurred.

Audit budget: one bounded source/protocol pass, one non-editing review and
focused local tests; no provider canaries or new routing workflow. Limits are
operator-observed, not controller-enforced. A new broad implementation or
interactive acceptance run gets its own scope, credentials and evidence cut.

Independent review identified missing separation of Chat/Cowork and
native/WSL acceptance, plus insufficient guarding of future partial live claims.
The matrix now separates those targets and the contract rejects transport-only
evidence, bare receipt URLs, foreign surfaces and missing acceptance cases.
The audit is an uncommitted draft in shared dirty checkouts; cited pending
handoff/approval work must be reconciled into a coherent source cut before a
release or exact-HEAD CI claim. No unrelated changes were staged or reverted.

Packaging and a codex-local-models announcement follow M1 and soak acceptance.
Keep independent installation paths for core Statewright and optional local
providers; publish only the support claims established by these receipts.
