# Claude Code mod and OAuth refit: discovery handoff

Date: 2026-10-11. Status: discovery only; no Claude mod or OAuth change has
been implemented, installed, or deployed by this document. Codex 0.3.4 is a
separate release candidate. Use a development gateway for the first live Claude
journey; do not change staging or production as part of discovery.

## Outcome to design for

A Claude Code user should be able to install Statewright, select an environment,
connect through browser approval without entering a gateway key into chat, and
use one correctly scoped Statewright MCP session. The integration must preserve
workflow tool enforcement, explicit human approval, model-route continuity, and
an actionable recovery path when authentication or the local credential store
fails. An OAuth success page alone is not an accepted Claude journey.

## Current source boundary (this checkout)

| Surface | Current behavior or question |
| --- | --- |
| `plugins/claude-code/.mcp.json` | Bundles one stdio MCP proxy. Adding a separate remote Statewright server risks a second client/session. |
| `plugins/claude-code/mcp-proxy.sh` | Standalone path reads `STATEWRIGHT_API_KEY` or the legacy `~/.statewright/api_key`, opens the signup/key page on missing credentials, and forwards to the selected gateway. Managed/executor paths use loopback bridges. It has no Claude device-approval tool. |
| `plugins/claude-code/hook.sh` | Reads the same legacy key, can capture a key pasted into a prompt, and enforces workflow state through shell hooks. The key-in-chat path must not be advertised as OAuth. |
| `plugins/claude-code/setup.sh` | Registers the hook owner and MCP permissions, retires a legacy duplicate MCP entry, and bootstraps managed routing. It does not perform account authorization. |
| `plugins/executor/lib/credential-store.mjs` | Shared OS-store helper already scopes credentials by canonical gateway URL, with a production-only legacy-file migration and an interactive macOS terminal unlock path. Reuse only after proving Claude's standalone proxy, hook, and managed launcher resolve the same selected environment. |
| `plugins/executor/lib/mcp-recovery.mjs` | Defines a local `statewright_connect` recovery tool for the executor/Codex path; Claude's standalone proxy currently exposes only `statewright_search_docs` locally. |
| `plugins/claude-code/hooks/hooks.json` | Registers settings-command hooks, not a Claude mod hooks module. Preserve their denial semantics while evaluating a mod. |

The local Claude Code binary reported `2.1.284` on this date. Anthropic's mod
documentation requires CLI `2.1.287` or later. Upgrade and confirm the actual
test binary before any mod canary; an older CLI is not evidence that a proposed
mod failed. Do not install or activate a mod merely to complete this handoff.

## 2026-10-11 native-capability probe

Homebrew upgraded `claude-code@latest` to `2.1.296`, and the installed binary's
Anthropic Developer ID signature passed `codesign --verify --strict`. This is
an installed-version receipt, **not** an executable canary: `claude --version`
and `claude plugin validate` could not complete. macOS `syspolicyd` logged
`Prompt could not be shown` and `Terminating process due to Gatekeeper
rejection` for the new binary in the headless session. Do not remove its
quarantine flag to make a test pass; obtain the ordinary macOS approval and
then repeat the native version, plugin-validation, and isolated mod checks.

The first visible `claude` retry instead stopped earlier in a Statewright shim:
`~/.statewright/bin/claude` pointed at a deleted Codex plugin-cache version.
The shim has been reinstalled to an existing durable runtime. A source fix now
makes future Claude shim installs copy either a Codex-hosted or Claude-hosted
managed launcher to a durable versioned runtime. The pending user-visible TUI
canary is to run `claude` again on aerith and distinguish a normal launch, a
Gatekeeper prompt, or a different error. Until that observation arrives, native
Claude launch and mod validation remain unverified; this does not block source
and package-level checks.

The gateway's `/.well-known/oauth-protected-resource/mcp` metadata advertises
the site authorization server and scope `mcp` (`crates/mcp-gateway/src/remote.rs`).
The site publishes authorization-code/PKCE and device endpoints
(`site/pb/hooks/device_authorization.pb.js`). However its registered-client
table currently contains only `statewright-codex`, with the exact redirect
`https://chatgpt.com/connector_platform_oauth_redirect`
(`site/pb/hooks/utils/deviceAuthorization.js`). It has no dynamic client
registration. Claude's documented remote-HTTP MCP OAuth requires a client
registration and a localhost callback (optionally a fixed port). Therefore
the existing discovery metadata does **not** establish that Claude can log in
today. A Claude public-client registration and exact callback contract would
be required before a native-HTTP OAuth canary.

Native HTTP is not a drop-in replacement for the current plugin server:
`plugins/claude-code/.mcp.json` loads one stdio proxy; its managed/adapter
paths use local bridges, and standalone `mcp-proxy.sh` and `hook.sh` read the
legacy key path. Adding an HTTP server alongside it would duplicate the MCP
identity; replacing it would require re-proving local tools, hook credential
access, managed routing, session continuity, and environment isolation.
Claude's documented mod `tool.check` handler can override decisions reached by
permission rules and `PreToolUse` hooks. A Statewright mod must not grant an
`allow` decision over a prior denial; keep policy at the existing enforceable
boundary and use a mod for bounded UX or routing only after a native probe.

## First deep-dive decisions

1. Decide whether the mod owns only UX and in-process events while the plugin
   keeps its single stdio MCP identity, or whether Claude's native HTTP MCP
   OAuth can satisfy the same hook, ownership, and routing contracts without a
   second server. Prove this with a native session, not only an MCP fixture.
2. Map the current gateway's protected-resource metadata, authorization URL,
   callback/device flow, and token lifetime to Claude's documented remote-MCP
   OAuth client. Distinguish a Claude-account login from Statewright-gateway
   authorization. Do not assume Codex's device flow is the right Claude UX.
3. Specify which component selects a named gateway and reads/writes its OS
   credential. Confirm production, staging, and dev profiles cannot share a
   key or redirect a confirmation across environments. Missing, rejected,
   locked, revoked, and rotated credentials need distinct recovery behavior.
4. Decide whether a mod is needed for an in-app connection dialog, approval
   prompt, or model handoff. Keep deterministic policy at an enforceable
   boundary; a mod must not silently override a denial from existing hooks or
   Claude permissions. Check terminal, Desktop Code tab, noninteractive, and
   unsupported-version fallbacks separately.
5. Inventory generated bundles, marketplace/cache installs, and test fixtures
   before editing. Keep source, packaged plugin, installed runtime, and live
   gateway identities separate in every receipt.

## Acceptance matrix for a later implementation

- Fresh install, no gateway credential: explicit connect action opens the
  correct environment's authorization page, shows a matching code/context,
  waits for completion, then makes MCP tools available in that same session.
- Existing credential and resumed Claude session: one Statewright client,
  correct environment, active workflow continuity, no duplicate MCP server.
- Missing/locked OS store, expired approval, rejected or revoked credential,
  cancelled approval, and gateway outage: fail visibly without replaying the
  denied action, switching environments, or opening a browser implicitly.
- `PreToolUse` and approval gates: denied tools stay denied; a mod's event
  handler cannot widen authority. Model-route boundary preserves the saved
  conversation and verified workflow binding, with unsupported effort marked
  advisory rather than enforced.
- Tests: pure unit/contract fixtures, native Claude plugin validation, an
  isolated installed-runtime canary, then one development-gateway OAuth and
  workflow journey. Record source, package, installed, and live identities.

## Primary vendor references checked on 2026-10-11

- [Claude Code mods overview](https://code.claude.com/docs/en/plugins/mods/overview):
  in-process hooks, supported hosts, version floor, and security boundary.
- [Create a mod](https://code.claude.com/docs/en/plugins/mods/create):
  `hooks.json` module registration, `--plugin-dir`, and validation loop.
- [Claude Code MCP](https://code.claude.com/docs/en/mcp): plugin-provided
  servers, remote HTTP OAuth, server scopes, and status/recovery UI.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks): settings-hook
  `PreToolUse` decision behavior and tool provenance.

The next task is a bounded architecture and native-capability probe, not a
staging rollout. Revise this matrix after observing the supported Claude CLI
and the actual gateway OAuth handshake.
