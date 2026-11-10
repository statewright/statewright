import { connectDesktopProfile } from "./desktop-device-connect.mjs";
import { getGatewayCredential } from "./credential-store.mjs";
import { canonicalGateway, resolveGatewayProfile } from "./gateway-profile.mjs";

// One in-flight browser flow per resident, shared across concurrent requests.
// Publish a verified credential to the running resident without replaying an
// action or approval decision. The local bridge identity remains unchanged.
export function createGatewayCredentialRecovery({ gatewayUrl, pbUrl, apiKey,
  environment = process.env, home, fetchImpl = fetch, connect = connectDesktopProfile,
  notify = message => process.stderr.write(message + "\n"),
  readCredential = getGatewayCredential, onRenewed = null }) {
  let attempt;
  return async () => {
    // Only a subsequent explicit request starts a fresh code after expiry.
    // No timer silently retries enrollment, and denial remains a hard stop.
    if (!attempt || attempt.status === "expired") {
      const current = attempt = { status: "starting", presentation: null };
      let ready;
      current.ready = new Promise(resolve => { ready = resolve; });
      current.completion = (async () => {
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
            current.status = "pending";
            current.presentation = { pending: true, userCode, verificationUrl };
            notify(`[statewright] Sign-in expired or was rejected. Opening browser approval. Confirm code ${userCode}: ${verificationUrl}`);
            // Resident stderr is a log file. Return this presentation through the
            // native RPC error immediately instead of hiding it during polling.
            ready();
          } });
        if (onRenewed) {
          const renewedKey = await readCredential(gateway, { environment, home });
          if (!/^sw_live_(?:[0-9a-f]{32}|[0-9A-Za-z]{64})$/.test(renewedKey ?? "")) {
            throw new Error("Statewright could not read the verified renewed credential.");
          }
          await onRenewed(renewedKey);
          apiKey = renewedKey;
        }
      })().then(() => { current.status = "complete"; }, error => {
        current.status = error.code === "DESKTOP_CONNECT_EXPIRED" ? "expired" : "failed";
        current.error = error;
      }).finally(ready);
    }
    const current = attempt;
    await current.ready;
    if (current.status === "complete") return { renewed: true };
    if (current.error) throw current.error;
    return current.presentation;
  };
}
