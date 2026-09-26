# Codex plugin onboarding release checklist

This checklist applies to the next Codex-only plugin release after 0.3.3. It
does not certify a release and it does not document a staging installation
path.

## Fresh-install witness

1. Install the published Codex plugin into a disposable Desktop or CLI profile.
2. Confirm the unauthenticated proxy does not open a browser during discovery
   and exposes only `statewright_search_docs`,
   `statewright_list_workflows`, and `statewright_connect`.
3. Confirm `statewright_list_workflows` reports `connected: false`, an empty
   workflow list, and no active workflow until a local credential exists.
4. Confirm documentation search remains available without a credential.
5. Confirm an ordinary tool call returns the structured not-connected response
   and does not claim workflow availability.
6. Call `statewright_connect`; confirm its device code exactly matches the
   authenticated browser approval page. Approve it without putting a credential
   in a model prompt. Confirm the plugin polls, verifies the issued key, writes
   `~/.statewright/api_key` with mode `0600`, and exposes authenticated tools in
   the same MCP process. Denial, expiry, replay, issuer errors, and failed key
   verification must leave the credential file absent.
7. Record the installer version, plugin digest, client version, gateway host,
   UTC timestamp, and redacted result. Do not record credentials, browser
   cookies, authorization codes, or raw prompts.

## Telemetry and observation

- Preserve `unknown` attribution when a native token event cannot be correlated
  to a workflow. Do not fabricate a state, model, or tool attribution.
- Observe production telemetry, onboarding failures, and connection errors for
  24 hours after publication. This observation is **pending** until an actual
  dated receipt is recorded; prior release receipts do not satisfy it.

## Device handoff boundary

The source implementation uses an RFC 8628-style device grant with a fixed
public client and fixed `mcp` capability. The short-lived device code is never
shown in the browser or persisted by the server; only hashes are stored. Browser
approval is bound to the authenticated Statewright user, the token response is
single-use, and expired uncollected approvals revoke their orphaned API keys.
The plugin accepts the resulting key only after a read-only authenticated
gateway request succeeds, then stores it outside model context.

This checklist is not production evidence. Do not claim the handoff is released
until the site migration/hooks/UI and matching plugin build are deployed together
and the fresh-install witness above succeeds against that exact deployment.
