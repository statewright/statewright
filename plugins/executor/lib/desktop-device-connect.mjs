import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { getGatewayCredential, setGatewayCredential } from "./credential-store.mjs";
import { resolveGatewayProfile } from "./gateway-profile.mjs";

const execFile = promisify(execFileCallback);
const DEVICE_CLIENT_ID = "statewright-codex";
const DEVICE_SCOPE = "mcp";
const FETCH_TIMEOUT_MS = 15_000;
// A modal dialog may land on a monitor the user cannot see. It must not gate device polling.
const CONNECT_DIALOG_SECONDS = 12;

function connectionError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function requestJson(fetchImpl, url, options) {
  let response;
  try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); }
  catch { throw connectionError("Statewright authorization service is unreachable. Check your connection and retry.", "DESKTOP_CONNECT_UNAVAILABLE"); }
  let body;
  try { body = await response.json(); }
  catch { throw connectionError("Statewright authorization service returned an invalid response.", "DESKTOP_CONNECT_PROTOCOL"); }
  return { response, body };
}

function authorizationDetails(body) {
  if (!body || !/^[0-9a-f]{32}$/.test(body.device_code ?? "")
      || !/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(body.user_code ?? "")
      || typeof body.verification_uri_complete !== "string"
      || !Number.isInteger(body.expires_in) || body.expires_in < 60 || body.expires_in > 900
      || !Number.isInteger(body.interval) || body.interval < 5 || body.interval > 60) {
    throw connectionError("Statewright authorization service returned an invalid device request.", "DESKTOP_CONNECT_PROTOCOL");
  }
  return body;
}

export function desktopConnectDialogText({ profile, userCode, verificationUrl }) {
  const app = profile === "staging" ? "ChatGPT + Statewright Staging" : profile === "development" ? "ChatGPT + Statewright Dev" : "ChatGPT + Statewright";
  return { app, message: `Continue opens Statewright in your default browser. If you don't see the page, visit ${verificationUrl}. Confirm code ${userCode} and sign in. ${app} will wait for your approval.` };
}

async function showConnectDialog({ profile, userCode, verificationUrl }) {
  const { app, message } = desktopConnectDialogText({ profile, userCode, verificationUrl });
  try {
    await execFile("/usr/bin/osascript", [
      "-e", "on run argv",
      "-e", `display dialog (item 1 of argv) buttons {"Cancel", "Continue"} default button "Continue" with title (item 2 of argv) giving up after ${CONNECT_DIALOG_SECONDS}`,
      "-e", "end run",
      message, app,
    ], { timeout: (CONNECT_DIALOG_SECONDS + 8) * 1000 });
  } catch (error) {
    if (error?.code === 1) throw connectionError("Statewright connection was cancelled.", "DESKTOP_CONNECT_CANCELLED");
    throw connectionError("Statewright could not show the connection dialog.", "DESKTOP_CONNECT_UI");
  }
}

async function openConnectBrowser(url) {
  try { await execFile("/usr/bin/open", [url], { timeout: 15_000 }); }
  catch { throw connectionError("Statewright could not open the browser approval page.", "DESKTOP_CONNECT_UI"); }
}

export async function connectDesktopProfile({ state, environment = process.env, home = homedir(),
  fetchImpl = fetch, showDialog = showConnectDialog, openBrowser = openConnectBrowser,
  storeCredential = setGatewayCredential, readCredential = getGatewayCredential,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() } = {}) {
  if (!state?.gateway_url) throw connectionError("Desktop profile has no gateway.", "DESKTOP_CONNECT_CONFIG");
  const profile = await resolveGatewayProfile({ ...environment, STATEWRIGHT_GATEWAY_URL: state.gateway_url }, home);
  if (!profile.authUrl) throw connectionError("Desktop gateway has no authorization-service mapping.", "DESKTOP_CONNECT_CONFIG");
  const codeUrl = `${profile.authUrl}/api/oauth/device/code`;
  const tokenUrl = `${profile.authUrl}/api/oauth/device/token`;
  const verificationUrl = new URL("/device", profile.authUrl);
  const codeRequest = await requestJson(fetchImpl, codeUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: DEVICE_CLIENT_ID, scope: DEVICE_SCOPE }),
  });
  if (!codeRequest.response.ok) throw connectionError(`Statewright device connection could not start (HTTP ${codeRequest.response.status}).`, "DESKTOP_CONNECT_UNAVAILABLE");
  const authorization = authorizationDetails(codeRequest.body);
  verificationUrl.searchParams.set("user_code", authorization.user_code);

  try {
    await showDialog({ profile: state.profile, userCode: authorization.user_code, verificationUrl: verificationUrl.href });
  } catch (error) {
    // The informational dialog is not authorization. If macOS cannot show it,
    // keep the real browser approval path available; only an explicit Cancel stops us.
    if (error.code !== "DESKTOP_CONNECT_UI") throw error;
  }
  await openBrowser(verificationUrl.href);

  const deadline = now() + authorization.expires_in * 1000;
  let interval = authorization.interval;
  while (now() < deadline) {
    await sleep(interval * 1000);
    if (now() >= deadline) break;
    let tokenRequest;
    try {
      tokenRequest = await requestJson(fetchImpl, tokenUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: authorization.device_code, client_id: DEVICE_CLIENT_ID }),
      });
    } catch (error) {
      if (error.code === "DESKTOP_CONNECT_UNAVAILABLE") continue;
      throw error;
    }
    if (tokenRequest.response.ok) {
      const key = tokenRequest.body?.token_type === "Bearer" ? tokenRequest.body.access_token : null;
      if (!/^sw_live_(?:[0-9a-f]{32}|[0-9A-Za-z]{64})$/.test(key ?? "")) throw connectionError("Statewright returned an invalid gateway credential.", "DESKTOP_CONNECT_PROTOCOL");
      let verified;
      try {
        verified = await fetchImpl(`${profile.authUrl}/api/gateway/workflows`, {
          headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch { throw connectionError("Statewright could not verify the new gateway credential. Check your connection and retry.", "DESKTOP_CONNECT_UNAVAILABLE"); }
      if (!verified.ok) throw connectionError("Statewright did not accept the new gateway credential.", "DESKTOP_CONNECT_REJECTED");
      await storeCredential(profile.gatewayUrl, key, { environment, home });
      if (await readCredential(profile.gatewayUrl, { environment, home }) !== key) {
        throw connectionError("Statewright could not confirm the credential in the OS store.", "DESKTOP_CONNECT_STORE");
      }
      return { gatewayUrl: profile.gatewayUrl, userCode: authorization.user_code };
    }
    switch (tokenRequest.body?.error) {
      case "authorization_pending": break;
      case "slow_down": interval = Math.min(interval + 5, 60); break;
      case "access_denied": throw connectionError("Statewright connection was denied in the browser.", "DESKTOP_CONNECT_DENIED");
      case "expired_token":
      case "invalid_grant": throw connectionError("Statewright device request expired. Open the app again to retry.", "DESKTOP_CONNECT_EXPIRED");
      default: throw connectionError("Statewright authorization service returned an unexpected token response.", "DESKTOP_CONNECT_PROTOCOL");
    }
  }
  throw connectionError("Statewright device request expired. Open the app again to retry.", "DESKTOP_CONNECT_EXPIRED");
}
