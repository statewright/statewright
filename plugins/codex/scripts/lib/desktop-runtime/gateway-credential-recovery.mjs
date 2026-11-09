import { connectDesktopProfile } from "./desktop-device-connect.mjs";
import { canonicalGateway, resolveGatewayProfile } from "./gateway-profile.mjs";

// One browser flow per resident, shared across concurrent rejected requests.
// A new credential requires a normal resident restart; never replay an action
// or approval decision with a different credential/session identity.
export function createGatewayCredentialRecovery({ gatewayUrl, pbUrl, apiKey,
  environment = process.env, home, fetchImpl = fetch, connect = connectDesktopProfile,
  notify = message => process.stderr.write(message + "\n") }) {
  let recovery;
  return () => {
    recovery ??= (async () => {
      const gateway = canonicalGateway(gatewayUrl);
      const profile = await resolveGatewayProfile({ ...environment,
        STATEWRIGHT_GATEWAY_URL: gateway, STATEWRIGHT_PB_URL: pbUrl }, home);
      if (!profile.authUrl) throw new Error("Statewright credential recovery has no configured authorization service.");
      if (apiKey) {
        // A gateway 401 can also mean invalid origin/session metadata. Verify
        // the credential separately before initiating account provisioning.
        const response = await fetchImpl(new URL("/api/gateway/workflows", profile.authUrl), {
          method: "GET", redirect: "error", signal: AbortSignal.timeout(15000),
          headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}`,
            "X-Statewright-OAuth-Resource": gateway },
        });
        const body = response.status === 401 ? await response.json().catch(() => null) : null;
        if (response.status !== 401 || !["API key required", "invalid_api_key"].includes(body?.error)) {
          throw new Error("Statewright could not confirm an expired or rejected credential; browser provisioning was not started.");
        }
      }
      await connect({ state: { gateway_url: gateway, profile: profile.name },
        environment: { ...environment, STATEWRIGHT_GATEWAY_URL: gateway, STATEWRIGHT_PB_URL: profile.authUrl }, home,
        // This recovery belongs to the TUI. Reuse device provisioning without
        // the Desktop helper's macOS dialog or Desktop application branding.
        showDialog: async ({userCode, verificationUrl}) => {
          notify(`[statewright] Sign-in expired or was rejected. Opening browser approval. Confirm code ${userCode}: ${verificationUrl}`);
        } });
      return { restartRequired: true };
    })();
    return recovery;
  };
}
