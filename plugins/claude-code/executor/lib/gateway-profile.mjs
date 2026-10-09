import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_GATEWAY = "https://mcp.statewright.ai/mcp";
export const PRODUCTION_AUTH_URL = "https://statewright.ai";

export function canonicalGateway(value = PRODUCTION_GATEWAY) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("Gateway identity must be an HTTP URL without credentials, query or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/mcp") ? path : `${path}/mcp`;
  return url.href;
}

function canonicalServiceUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("Statewright authorization service must be an HTTP URL without credentials, query or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}

async function environmentConfig(home) {
  try {
    const parsed = JSON.parse(await readFile(join(home, ".statewright", "environments.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error("Could not read ~/.statewright/environments.json");
  }
}

export async function resolveGatewayProfile(environment = process.env, home = homedir()) {
  const config = await environmentConfig(home);
  const profiles = config.gateways && typeof config.gateways === "object" ? config.gateways : {};
  const name = environment.STATEWRIGHT_ENV?.trim();
  const named = name ? profiles[name] : null;
  if (name && (!named || typeof named.gateway_url !== "string")) {
    throw new Error(`Statewright environment '${name}' is not configured in ~/.statewright/environments.json`);
  }

  const gatewayUrl = canonicalGateway(environment.STATEWRIGHT_GATEWAY_URL || named?.gateway_url || PRODUCTION_GATEWAY);
  let authUrl = environment.STATEWRIGHT_PB_URL || named?.auth_url || named?.pb_url;
  if (!authUrl && gatewayUrl === PRODUCTION_GATEWAY) authUrl = PRODUCTION_AUTH_URL;
  if (!authUrl) {
    for (const profile of Object.values(profiles)) {
      if (profile && typeof profile.gateway_url === "string" && canonicalGateway(profile.gateway_url) === gatewayUrl) {
        authUrl = profile.auth_url || profile.pb_url;
        break;
      }
    }
  }

  return {
    name: name || (gatewayUrl === PRODUCTION_GATEWAY ? "production" : null),
    gatewayUrl,
    authUrl: authUrl ? canonicalServiceUrl(authUrl) : null,
    identity: createHash("sha256").update(gatewayUrl).digest("hex"),
  };
}

export async function resolvedGatewayEnvironment(environment = process.env, home = homedir()) {
  const profile = await resolveGatewayProfile(environment, home);
  return {
    ...environment,
    STATEWRIGHT_GATEWAY_URL: profile.gatewayUrl,
    ...(profile.authUrl ? { STATEWRIGHT_PB_URL: profile.authUrl } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--profile-json")) {
  const profile = await resolveGatewayProfile();
  process.stdout.write(`${JSON.stringify({
    name: profile.name,
    gateway_url: profile.gatewayUrl,
    auth_url: profile.authUrl,
    identity: profile.identity,
  })}\n`);
}
