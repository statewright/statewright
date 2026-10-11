import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const MAX_BODY_BYTES = 4096;
const LANE_KEY = /^(?:legacy|discovery|(?:thread|new):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function validKey(key) {
  return typeof key === "string" && key === key.trim() && LANE_KEY.test(key)
    && (key === "legacy" || key === "discovery" || /^(thread|new):/.test(key));
}

export function desktopLaneClientId(profileClientId, key) {
  if (typeof profileClientId !== "string" || !profileClientId || !validKey(key)) {
    throw new Error("Invalid desktop lane identity.");
  }
  if (key === "legacy") return profileClientId;
  const digest = createHash("sha256")
    .update(JSON.stringify(["statewright-desktop-lane-v1", profileClientId, key]))
    .digest("hex");
  return `swc_${digest.slice(0, 32)}`;
}

function loopbackUrl(value) {
  if (typeof value !== "string") throw new Error("Invalid desktop bridge address.");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid desktop bridge address.");
  }
  return url.origin;
}

function bridgeDescriptor(bridge, clientId) {
  if (!bridge || bridge.clientId !== clientId || typeof bridge.token !== "string"
      || !bridge.token || /[\r\n]/.test(bridge.token) || typeof bridge.close !== "function") {
    throw new Error("Invalid desktop bridge.");
  }
  return { clientId, url: loopbackUrl(bridge.url), token: bridge.token };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onError);
    };
    const onError = () => { cleanup(); reject(new Error("Invalid request.")); };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        cleanup();
        request.once("error", () => {});
        request.resume();
        reject(Object.assign(new Error("Request too large."), { status: 413 }));
      } else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onError);
  });
}

function respond(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

export async function startDesktopBridgePool({ profileClientId, legacyBridge, createBridge, maxLanes = 16 }) {
  desktopLaneClientId(profileClientId, "legacy");
  const legacy = bridgeDescriptor(legacyBridge, profileClientId);
  if (typeof createBridge !== "function" || !Number.isSafeInteger(maxLanes) || maxLanes < 1) {
    throw new Error("Invalid desktop bridge pool configuration.");
  }
  const token = randomBytes(32).toString("hex");
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const lanes = new Map();
  let closing = false;
  let closePromise;

  function lane(key) {
    if (closing) throw Object.assign(new Error("Pool closed."), { status: 503 });
    if (key === "legacy") return Promise.resolve(legacy);
    if (lanes.has(key)) return lanes.get(key).then((bridge) => bridgeDescriptor(bridge, desktopLaneClientId(profileClientId, key)));
    if (lanes.size >= maxLanes) throw Object.assign(new Error("Pool full."), { status: 429 });
    const clientId = desktopLaneClientId(profileClientId, key);
    const pending = Promise.resolve().then(() => createBridge(clientId)).then(async (bridge) => {
      try { bridgeDescriptor(bridge, clientId); }
      catch {
        try { await bridge?.close?.(); } catch { /* Never expose factory errors. */ }
        throw new Error("Invalid desktop bridge.");
      }
      return bridge;
    });
    lanes.set(key, pending);
    pending.catch(() => { if (lanes.get(key) === pending) lanes.delete(key); });
    return pending.then((bridge) => bridgeDescriptor(bridge, clientId));
  }

  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/lane") {
      respond(response, 404, { error: "Not found." });
      return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (request.headersDistinct.authorization?.length !== 1
        || supplied.length !== expectedAuthorization.length
        || !timingSafeEqual(supplied, expectedAuthorization)) {
      respond(response, 401, { error: "Unauthorized." });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(request));
      if (!body || Array.isArray(body) || typeof body !== "object"
          || Object.keys(body).length !== 1 || !Object.hasOwn(body, "key") || !validKey(body.key)) {
        throw new Error("Invalid request.");
      }
    } catch (error) {
      respond(response, error.status === 413 ? 413 : 400, { error: "Invalid lane request." });
      return;
    }
    try {
      const descriptor = await lane(body.key);
      if (closing) throw Object.assign(new Error("Pool closed."), { status: 503 });
      respond(response, 200, descriptor);
    } catch (error) {
      const status = error.status === 429 ? 429 : error.status === 503 ? 503 : 502;
      respond(response, status, { error: "Desktop lane unavailable." });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      const stopped = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      closePromise = (async () => {
        const children = await Promise.allSettled([...lanes.values()]);
        const results = await Promise.allSettled(children.filter((entry) => entry.status === "fulfilled")
          .map(({ value }) => Promise.resolve().then(() => value.close())));
        await stopped;
        if (results.some((result) => result.status === "rejected")) throw new Error("Desktop bridge pool cleanup failed.");
      })();
      return closePromise;
    },
  };
}

export async function requestDesktopLaneBridge({ url, token, key }) {
  try {
    if (!validKey(key) || typeof token !== "string" || !token || /[\r\n]/.test(token)) {
      throw new Error("Invalid request.");
    }
    const response = await fetch(`${loopbackUrl(url)}/lane`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) throw Object.assign(new Error("Restart Desktop after saving your work to open more chats; closing a chat alone does not free its bridge."), { code: "DESKTOP_LANE_LIMIT" });
    if (!response.ok) throw new Error("Request failed.");
    const descriptor = await response.json();
    if (!descriptor || typeof descriptor.clientId !== "string" || !descriptor.clientId
        || typeof descriptor.token !== "string" || !descriptor.token || /[\r\n]/.test(descriptor.token)
        || Object.keys(descriptor).sort().join(",") !== "clientId,token,url") {
      throw new Error("Invalid response.");
    }
    return { clientId: descriptor.clientId, url: loopbackUrl(descriptor.url), token: descriptor.token };
  } catch (error) {
    if (error.code === "DESKTOP_LANE_LIMIT") throw error;
    throw new Error("Desktop lane bridge unavailable.");
  }
}
