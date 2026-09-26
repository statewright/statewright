# Codex plugin onboarding release checklist

This checklist applies to the next Codex-only plugin release after 0.3.3. It
does not certify a release and it does not document a staging installation
path.

## Fresh-install witness

1. Install the published Codex plugin into a disposable Desktop or CLI profile.
2. Confirm the unauthenticated proxy opens `https://statewright.ai/keys`, never
   `/signup`, and exposes only `statewright_search_docs`,
   `statewright_list_workflows`, and `statewright_connect`.
3. Confirm `statewright_list_workflows` reports `connected: false`, an empty
   workflow list, and no active workflow until a local credential exists.
4. Confirm documentation search remains available without a credential.
5. Confirm an ordinary tool call returns the structured not-connected response
   and does not claim workflow availability.
6. Complete account setup in the browser without putting a credential in a
   model prompt. Browser sign-in does not yet provision the MCP credential, so
   record the connection as blocked and do not claim authenticated tools are
   available. The OAuth handoff described below is required before this step
   can end in an authenticated catalog.
7. Record the installer version, plugin digest, client version, gateway host,
   UTC timestamp, and redacted result. Do not record credentials, browser
   cookies, authorization codes, or raw prompts.

## Telemetry and observation

- Preserve `unknown` attribution when a native token event cannot be correlated
  to a workflow. Do not fabricate a state, model, or tool attribution.
- Observe production telemetry, onboarding failures, and connection errors for
  24 hours after publication. This observation is **pending** until an actual
  dated receipt is recorded; prior release receipts do not satisfy it.

## OAuth handoff boundary

The current plugin has no browser-to-MCP credential exchange. The generic
SaSSY MCP provider must supply the future OAuth 2.1 authorization-code with
PKCE (or appropriate device-flow) contract: discovery metadata, resource
binding, one-time completion, short-lived and revocable tokens, local
secret-free storage, and a catalog refresh. Do not claim this checklist proves
that handoff until the service and client are both implemented and witnessed.
