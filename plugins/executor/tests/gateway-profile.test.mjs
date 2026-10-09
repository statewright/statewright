import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalGateway, resolveGatewayProfile, resolvedGatewayEnvironment } from "../lib/gateway-profile.mjs";

test("gateway profiles resolve explicit URL and named environments without secret material", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-profiles-"));
  await mkdir(join(home, ".statewright"), { recursive: true });
  await writeFile(join(home, ".statewright", "environments.json"), JSON.stringify({
    gateways: {
      staging: { gateway_url: "https://staging.example.test", auth_url: "https://accounts.staging.example.test" },
      dev1: { gateway_url: "https://dev1.example.test/api", pb_url: "https://accounts.dev1.example.test/" },
      dev2: { gateway_url: "https://dev2.example.test/mcp", auth_url: "https://accounts.dev2.example.test" },
    },
  }));

  const staging = await resolveGatewayProfile({ STATEWRIGHT_GATEWAY_URL: "https://staging.example.test/" }, home);
  assert.equal(staging.gatewayUrl, "https://staging.example.test/mcp");
  assert.equal(staging.authUrl, "https://accounts.staging.example.test");
  const dev1 = await resolvedGatewayEnvironment({ STATEWRIGHT_ENV: "dev1" }, home);
  assert.equal(dev1.STATEWRIGHT_GATEWAY_URL, "https://dev1.example.test/api/mcp");
  assert.equal(dev1.STATEWRIGHT_PB_URL, "https://accounts.dev1.example.test");
  assert.equal("STATEWRIGHT_API_KEY" in dev1, false);
  const dev2 = await resolveGatewayProfile({ STATEWRIGHT_GATEWAY_URL: "https://dev2.example.test" }, home);
  assert.equal(dev2.gatewayUrl, "https://dev2.example.test/mcp");
  assert.equal(dev2.authUrl, "https://accounts.dev2.example.test");
  assert.notEqual(dev2.authUrl, staging.authUrl);
});

test("unknown named environments fail closed", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-profiles-"));
  await assert.rejects(resolveGatewayProfile({ STATEWRIGHT_ENV: "dev2" }, home), /not configured/);
});

test("gateway canonicalization rejects secret-bearing identities", () => {
  assert.equal(canonicalGateway("HTTPS://EXAMPLE.TEST:443/mcp/"), "https://example.test/mcp");
  for (const value of [
    "file:///tmp/statewright",
    "https://user@example.test",
    "https://example.test?token=secret",
    "https://example.test/#secret",
  ]) assert.throws(() => canonicalGateway(value), /Gateway identity/);
});
