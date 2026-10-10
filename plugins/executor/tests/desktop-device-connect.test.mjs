import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connectDesktopProfile, desktopConnectDialogText } from "../lib/desktop-device-connect.mjs";

const device = {
  device_code: "a".repeat(32), user_code: "ABCD-EFGH-JKLM",
  verification_uri_complete: "https://wrong-origin.example/device?user_code=ABCD-EFGH-JKLM",
  expires_in: 600, interval: 5,
};
const key = `sw_live_${"b".repeat(32)}`;

async function fixture(t, withAuth = true) {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-oauth-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".statewright"));
  await writeFile(join(home, ".statewright", "environments.json"), JSON.stringify({ gateways: {
    staging: { gateway_url: "https://stage-gateway.example/mcp", ...(withAuth ? { auth_url: "https://stage-auth.example" } : {}) },
  } }));
  return { home, state: { profile: "staging", gateway_url: "https://stage-gateway.example" } };
}

test("Desktop missing-credential flow shows the device code, uses the selected auth origin, verifies and stores only its gateway key", async t => {
  const { home, state } = await fixture(t);
  const events = [];
  let polls = 0;
  let stored = null;
  const result = await connectDesktopProfile({ state, home, environment: {}, now: () => 0, sleep: async () => {},
    showDialog: async value => events.push(["dialog", value]),
    openBrowser: async url => events.push(["browser", url]),
    fetchImpl: async (url, options) => {
      events.push(["fetch", url]);
      if (url.endsWith("/api/oauth/device/code")) {
        assert.equal(options.body.get("client_id"), "statewright-codex");
        assert.equal(options.body.get("scope"), "mcp");
        return Response.json(device);
      }
      if (url.endsWith("/api/oauth/device/token")) {
        assert.equal(options.body.get("device_code"), device.device_code);
        return ++polls === 1 ? Response.json({ error: "authorization_pending" }, { status: 400 })
          : Response.json({ token_type: "Bearer", access_token: key });
      }
      assert.equal(url, "https://stage-auth.example/api/gateway/workflows");
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      return Response.json({ items: [] });
    },
    storeCredential: async (gateway, secret) => { stored = { gateway, secret }; },
    readCredential: async gateway => { assert.equal(gateway, "https://stage-gateway.example/mcp"); return stored?.secret; },
  });
  assert.equal(result.gatewayUrl, "https://stage-gateway.example/mcp");
  assert.deepEqual(events[1], ["dialog", { profile: "staging", userCode: device.user_code }]);
  assert.deepEqual(events[2], ["browser", `https://stage-auth.example/device?user_code=${device.user_code}`]);
  assert.equal(stored.gateway, "https://stage-gateway.example/mcp");
  assert.equal(stored.secret, key);
  assert.match(desktopConnectDialogText({ profile: "staging", userCode: device.user_code }).message,
    /will open Statewright in your browser to connect.*ABCD-EFGH-JKLM/);
});

test("Desktop OAuth denial does not store a credential", async t => {
  const { home, state } = await fixture(t);
  let stores = 0;
  await assert.rejects(connectDesktopProfile({ state, home, environment: {}, now: () => 0, sleep: async () => {},
    showDialog: async () => {}, openBrowser: async () => {},
    fetchImpl: async url => url.endsWith("/code") ? Response.json(device)
      : Response.json({ error: "access_denied" }, { status: 400 }),
    storeCredential: async () => { stores++; }, readCredential: async () => { throw new Error("not expected"); },
  }), { code: "DESKTOP_CONNECT_DENIED" });
  assert.equal(stores, 0);
});

test("Desktop OAuth without an authorization-service mapping fails before browser or network use", async t => {
  const { home, state } = await fixture(t, false);
  let calls = 0;
  await assert.rejects(connectDesktopProfile({ state, home, environment: {},
    showDialog: async () => { calls++; }, openBrowser: async () => { calls++; },
    fetchImpl: async () => { calls++; return Response.json(device); },
  }), { code: "DESKTOP_CONNECT_CONFIG" });
  assert.equal(calls, 0);
});

test("Desktop OAuth reports an offline issuer as a connection failure without opening a browser", async t => {
  const { home, state } = await fixture(t);
  let uiCalls = 0;
  await assert.rejects(connectDesktopProfile({ state, home, environment: {},
    showDialog: async () => { uiCalls++; }, openBrowser: async () => { uiCalls++; },
    fetchImpl: async () => { throw new Error("sensitive transport details"); },
  }), error => error.code === "DESKTOP_CONNECT_UNAVAILABLE" && !error.message.includes("sensitive transport details"));
  assert.equal(uiCalls, 0);
});
