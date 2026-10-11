import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { desktopLaneClientId, requestDesktopLaneBridge, startDesktopBridgePool } from "../lib/desktop-bridge-pool.mjs";

const PROFILE = "swc_0123456789abcdef0123456789abcdef";
const THREAD = "thread:01234567-89ab-cdef-0123-456789abcdef";
const NEW = "new:01234567-89ab-cdef-0123-456789abcdef";

async function fixture(options = {}) {
  const created = [];
  const closed = [];
  const legacyBridge = { clientId: PROFILE, url: "http://127.0.0.1:12345", token: "legacy-secret", close: () => closed.push("legacy") };
  const createBridge = async (clientId) => {
    created.push(clientId);
    return { clientId, url: "http://127.0.0.1:12346", token: `child-secret-${clientId}`, close: () => closed.push(clientId) };
  };
  const pool = await startDesktopBridgePool({ profileClientId: PROFILE, legacyBridge, createBridge, ...options });
  return { pool, created, closed, createBridge };
}

function raw(pool, body, token = pool.token, path = "/lane") {
  return fetch(`${pool.url}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
}

test("desktop lane identity is stable, profile-scoped and strict", () => {
  assert.equal(desktopLaneClientId(PROFILE, "legacy"), PROFILE);
  assert.match(desktopLaneClientId(PROFILE, THREAD), /^swc_[a-f0-9]{32}$/);
  assert.equal(desktopLaneClientId(PROFILE, THREAD), desktopLaneClientId(PROFILE, THREAD));
  assert.notEqual(desktopLaneClientId(PROFILE, THREAD), desktopLaneClientId("other", THREAD));
  assert.notEqual(desktopLaneClientId(PROFILE, THREAD), desktopLaneClientId(PROFILE, NEW));
  for (const key of ["Legacy", "DISCOVERY", "thread:x", "thread:../secret", "new:0123456789abcdef0123456789abcdef", "discovery\n", `${THREAD}\n`, null, {}]) {
    assert.throws(() => desktopLaneClientId(PROFILE, key), /Invalid desktop lane identity/);
  }
});

test("pool shares one creation per key and isolates discovery, thread and new lanes", async () => {
  const { pool, created, closed } = await fixture();
  try {
    const lanes = await Promise.all(Array.from({ length: 12 }, () => requestDesktopLaneBridge({ ...pool, key: THREAD })));
    assert.equal(created.length, 1);
    for (const result of lanes) assert.deepEqual(result, lanes[0]);
    const discovery = await requestDesktopLaneBridge({ ...pool, key: "discovery" });
    const fresh = await requestDesktopLaneBridge({ ...pool, key: NEW });
    const legacy = await requestDesktopLaneBridge({ ...pool, key: "legacy" });
    assert.equal(new Set([lanes[0].clientId, discovery.clientId, fresh.clientId, legacy.clientId]).size, 4);
    assert.equal(legacy.clientId, PROFILE);
    assert.equal(legacy.token, "legacy-secret");
    assert.equal(created.length, 3);
  } finally { await pool.close(); }
  await pool.close();
  assert.deepEqual(closed.sort(), created.sort());
});

test("pool rejects foreign auth, malformed input, extra fields and oversized bodies without secrets", async () => {
  const { pool, created } = await fixture();
  try {
    for (const token of ["", "foreign-secret", `Bearer ${pool.token}`]) {
      const response = await raw(pool, JSON.stringify({ key: THREAD }), token);
      assert.equal(response.status, 401);
      assert.equal(await response.text(), '{"error":"Unauthorized."}');
    }
    for (const body of ["{", "null", "[]", '"discovery"', '{}', '{"key":"thread:bad"}',
      '{"key":"discovery","gatewayUrl":"secret"}', '{"key":"discovery","apiKey":"secret"}',
      '{"key":"discovery","clientId":"secret"}']) {
      const response = await raw(pool, body);
      assert.equal(response.status, 400, body);
      assert.equal(await response.text(), '{"error":"Invalid lane request."}');
    }
    assert.equal((await raw(pool, JSON.stringify({ key: "x".repeat(4096) }))).status, 413);
    assert.equal((await raw(pool, '{"key":"discovery"}', pool.token, "/lane?secret")).status, 404);
    assert.equal(created.length, 0);
  } finally { await pool.close(); }
});

test("independent pools cannot authenticate to each other", async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    assert.notEqual(first.pool.token, second.pool.token);
    assert.equal((await raw(first.pool, JSON.stringify({ key: THREAD }), second.pool.token)).status, 401);
    assert.equal((await raw(second.pool, JSON.stringify({ key: THREAD }), first.pool.token)).status, 401);
    assert.deepEqual(first.created, []);
    assert.deepEqual(second.created, []);
  } finally { await Promise.all([first.pool.close(), second.pool.close()]); }
});

test("pool limit counts in-flight children, preserves legacy and retries failed creation", async () => {
  let attempts = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { pool, closed } = await fixture({ maxLanes: 1, createBridge: async (clientId) => {
    attempts++;
    if (attempts === 1) { await pending; throw new Error("PRIVATE API KEY secret"); }
    return { clientId, url: "http://127.0.0.1:12346", token: "safe-token", close() {} };
  } });
  try {
    const first = raw(pool, JSON.stringify({ key: THREAD }));
    while (!attempts) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await raw(pool, '{"key":"discovery"}')).status, 429);
    assert.equal((await requestDesktopLaneBridge({ ...pool, key: "legacy" })).clientId, PROFILE);
    release();
    const failed = await first;
    assert.equal(failed.status, 502);
    assert.equal(await failed.text(), '{"error":"Desktop lane unavailable."}');
    assert.equal((await requestDesktopLaneBridge({ ...pool, key: THREAD })).clientId, desktopLaneClientId(PROFILE, THREAD));
    assert.equal(attempts, 2);
  } finally { release(); await pool.close(); }
  assert.deepEqual(closed, []);
});

test("close waits for in-flight creation, closes late children once and leaves legacy owned by caller", async () => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  let closeCount = 0;
  const { pool, closed } = await fixture({ createBridge: async (clientId) => {
    entered();
    await pending;
    return { clientId, url: "http://127.0.0.1:12346", token: "safe-token", close() { closeCount++; } };
  } });
  const request = requestDesktopLaneBridge({ ...pool, key: THREAD }).catch((error) => error);
  await started;
  const closing = pool.close();
  assert.equal(pool.close(), closing);
  release();
  await closing;
  assert.equal(closeCount, 1);
  assert.deepEqual(closed, []);
  assert.match((await request).message, /Desktop lane bridge unavailable/);
  await assert.rejects(requestDesktopLaneBridge({ ...pool, key: "legacy" }), /Desktop lane bridge unavailable/);
});

test("pool rejects mismatched factory identity and sanitizes client errors", async () => {
  let closed = 0;
  const { pool } = await fixture({ createBridge: async () => ({
    clientId: "foreign-secret", url: "http://127.0.0.1:12346", token: "private-secret", close() { closed++; },
  }) });
  try {
    await assert.rejects(requestDesktopLaneBridge({ ...pool, key: THREAD }), { message: "Desktop lane bridge unavailable." });
    assert.equal(closed, 1);
    await assert.rejects(requestDesktopLaneBridge({ url: "http://private-secret.example", token: "secret", key: THREAD }),
      { message: "Desktop lane bridge unavailable." });
  } finally { await pool.close(); }
});

test("client uses a 15 second timeout and rejects redirect or malformed descriptors", async () => {
  const originalTimeout = AbortSignal.timeout;
  const timeouts = [];
  AbortSignal.timeout = (milliseconds) => { timeouts.push(milliseconds); return originalTimeout(milliseconds); };
  let reply = { clientId: PROFILE, url: "https://remote-secret.example", token: "secret" };
  let redirect = false;
  const server = createServer((_request, response) => {
    if (redirect) {
      response.writeHead(302, { Location: "http://private-secret.example" }).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(reply));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const options = { url: `http://127.0.0.1:${server.address().port}`, token: "pool-token", key: THREAD };
    await assert.rejects(requestDesktopLaneBridge(options), { message: "Desktop lane bridge unavailable." });
    reply = { clientId: PROFILE, url: "http://127.0.0.1:12345", token: "secret", apiKey: "secret" };
    await assert.rejects(requestDesktopLaneBridge(options), { message: "Desktop lane bridge unavailable." });
    redirect = true;
    await assert.rejects(requestDesktopLaneBridge(options), { message: "Desktop lane bridge unavailable." });
    assert.deepEqual(timeouts, [15_000, 15_000, 15_000]);
  } finally {
    AbortSignal.timeout = originalTimeout;
    await new Promise((resolve) => server.close(resolve));
  }
});
