#!/usr/bin/env node
/**
 * P1 canary fake pi host.
 *
 * A deterministic, LLM-free stand-in for the pi host: it ignores every argv
 * (including --no-extensions/--provider/--extension), talks to the reference
 * gateway's /mcp streamable endpoint the same way the real pi extension does
 * (Bearer key, X-Statewright-Client-Id, mcp-session-id handshake), and drives
 * the p1-restart-readm-v1 workflow exactly per its instructions.
 *
 * SW_CANARY_MODE=park  : session 1 - fire GO_A, wait until the gateway parks
 *                        it (or the trusted callback already advanced to s2),
 *                        log the park, and exit so the executor pauses.
 * SW_CANARY_MODE=resume: session 2 - exercise restart readmission: if the
 *                        trusted decision already applied before pause,
 *                        continue from s2; if the run restored parked on s1,
 *                        re-fire GO_A exactly once and require the trusted
 *                        (out-of-band) decision to admit it without a second
 *                        approval. Then owner-self-approve GO_B, write the
 *                        artifact, and finish at s4.
 */
import { writeFileSync } from "node:fs";

const gatewayUrl = process.env.STATEWRIGHT_GATEWAY_URL?.trim().replace(/\/$/, "");
const apiKey = process.env.STATEWRIGHT_API_KEY?.trim();
const mode = process.env.SW_CANARY_MODE?.trim();
if (!gatewayUrl || !apiKey || !["park", "resume"].includes(mode)) {
  console.error("fake-pi: STATEWRIGHT_GATEWAY_URL, STATEWRIGHT_API_KEY, SW_CANARY_MODE=park|resume are required");
  process.exit(2);
}

const endpoint = gatewayUrl.endsWith("/mcp") ? gatewayUrl : `${gatewayUrl}/mcp`;
const clientId = process.env.STATEWRIGHT_CLIENT_ID?.trim() || "fake-pi-p1";
let sessionId = null;
let rpcId = 0;

function log(msg) {
  const line = `FAKEPI ${msg}`;
  process.stdout.write(`${line}\n`);
  process.stderr.write(`${line}\n`);
}

async function rpc(method, params, { notify = false } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "X-Statewright-Client-Id": clientId,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const body = { jsonrpc: "2.0", id: rpcId++, method, params };
  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const sid = resp.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  if (!resp.ok) throw new Error(`fake-pi: ${method} -> HTTP ${resp.status}`);
  const data = await resp.json();
  if (notify) return null;
  if (data.error) throw new Error(`fake-pi: ${method} JSON-RPC error: ${JSON.stringify(data.error)}`);
  const result = data.result;
  if (result?.isError) {
    throw new Error(`fake-pi: ${method} tool error: ${result?.content?.[0]?.text ?? "unknown"}`);
  }
  const text = result?.content?.[0]?.text;
  if (text === undefined || text === null) return result ?? null;
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

function init() {
  return rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fake-pi-p1", version: "1" },
  }).then(() => rpc("notifications/initialized", {}, { notify: true }));
}

async function getState() {
  const result = await rpc("tools/call", { name: "statewright_get_state", arguments: {} });
  return result?.state ?? result;
}

async function transition(event, data) {
  return rpc("tools/call", { name: "statewright_transition", arguments: { event, ...(data ? { data } : {}) } });
}

async function waitFor(ms, probe) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const parked = (s) => Boolean(s?.pending_approval?.approval_id);
const stateOf = (s) => s?.state ?? "?";

try {
  await init();
  log(`mode=${mode} connected client=${clientId}`);

  if (mode === "park") {
    // Fire GO_A once. Never re-fire: the external approver (harness) owns it.
    let result;
    try {
      result = await transition("GO_A");
    } catch (err) {
      log(`GO_A error=${err.message}`);
    }
    log(`GO_A result=${JSON.stringify(result ?? null)}`);
    const advanced = await waitFor(90_000, async () => {
      const s = await getState();
      return stateOf(s) === "s2" ? s : null;
    });
    if (advanced) {
      log(`park-mode: trusted callback raced ahead; state=s2 approval=${parked(advanced) ? "still-parked" : "cleared"}`);
      process.exit(0);
    }
    const s = await getState();
    if (!parked(s) && stateOf(s) !== "s1") {
      log(`park-mode: unexpected state=${stateOf(s)}; exiting for executor pause`);
      process.exit(0);
    }
    log(`park-mode: state=${stateOf(s)} approval=${s?.pending_approval?.approval_id ?? "?"} to=${s?.pending_approval?.to_state ?? "?"}`);
    // Give the executor a beat to mirror the park into its checkpoint, then
    // exit so it pauses the run; the harness kills the session tree after.
    await new Promise((r) => setTimeout(r, 2500));
    process.exit(0);
  }

  // mode === "resume"
  const s1 = await getState();
  log(`resume-start state=${stateOf(s1)} approval=${s1?.pending_approval?.approval_id ?? "none"}`);

  let atS2 = stateOf(s1) === "s2";
  if (!atS2 && stateOf(s1) === "s1") {
    // The run restored parked on s1. Re-fire GO_A exactly once: the trusted
    // out-of-band decision must admit it. No second re-fire, no re-approval.
    log("re-admitting GO_A via trusted decision (single re-fire)");
    const result = await transition("GO_A");
    log(`re-GO_A result=${JSON.stringify(result ?? null)}`);
    const admitted = await waitFor(30_000, async () => {
      const s = await getState();
      return stateOf(s) === "s2" ? s : null;
    });
    if (!admitted) {
      const s = await getState();
      log(`re-admit-FAIL state=${stateOf(s)} approval=${s?.pending_approval?.approval_id ?? "?"}`);
      process.exit(3);
    }
    log(`re-admit-OK state=s2 approval=${parked(admitted) ? "parked" : "cleared"}`);
    atS2 = true;
  }
  if (!atS2) {
    log(`resume-FAIL unexpected state=${stateOf(s1)}`);
    process.exit(3);
  }

  // Owner self-approval of GO_B by repetition (workflow owner is the host).
  let result;
  try {
    result = await transition("GO_B");
  } catch (err) {
    log(`GO_B error=${err.message}`);
  }
  log(`GO_B result=${JSON.stringify(result ?? null)}`);
  const atS3 = await waitFor(30_000, async () => {
    const s = await getState();
    return stateOf(s) === "s3" ? s : null;
  });
  if (!atS3) {
    const s = await getState();
    if (parked(s) && stateOf(s) === "s2") {
      log("owner self-approving GO_B (re-fire)");
      const again = await transition("GO_B");
      log(`GO_B repeat result=${JSON.stringify(again ?? null)}`);
      const retry = await waitFor(30_000, async () => {
        const s2 = await getState();
        return stateOf(s2) === "s3" ? s2 : null;
      });
      if (!retry) { log(`self-approve-FAIL state=${stateOf(await getState())}`); process.exit(4); }
      log("self-approve-OK state=s3");
    } else {
      log(`s3-wait-FAIL state=${stateOf(s)}`);
      process.exit(4);
    }
  }

  writeFileSync("canary-p1-approved.txt", "approved\n", "utf8");
  log("artifact canary-p1-approved.txt written");
  const done = await transition("DONE");
  log(`DONE result=${JSON.stringify(done ?? null)}`);
  const final = await waitFor(15_000, async () => {
    const s = await getState();
    return stateOf(s) === "s4" ? s : null;
  });
  if (!final) { log(`final-wait-FAIL state=${stateOf(await getState())}`); process.exit(5); }
  log("complete state=s4");
  process.exit(0);
} catch (err) {
  log(`fatal=${err.message}`);
  process.exit(1);
}
