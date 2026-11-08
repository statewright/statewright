import { appendFile, chmod, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { interactionValue } from "./human-interaction.mjs";

const SENSITIVE_KEYS = new Set(["prompt", "input", "arguments", "content", "text"]);

export function scrubTelemetryFields(value) {
  if (Array.isArray(value)) return value.map(scrubTelemetryFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEYS.has(key))
      .map(([key, item]) => [key, scrubTelemetryFields(item)]),
  );
}

export function defaultTelemetryPath() {
  return join(homedir(), ".statewright", "telemetry", "codex-routing.jsonl");
}

export function humanInteractionOutbox(path, {endpoint = null, humanEndpoint = null, apiKey = null} = {}) {
  // Never deliver another profile/account's pending observations using this key.
  const target = humanEndpoint || (endpoint ? new URL("/api/gateway/human-interactions", endpoint).href : null);
  const scope = createHash("sha256").update(JSON.stringify([target, apiKey])).digest("hex");
  return path + ".human-pending-" + scope;
}

export function createTelemetryWriter(path = defaultTelemetryPath(), { endpoint = null, apiKey = null, humanEndpoint = null, clientId = null } = {}) {
  let sequence = 0;
  let delivery = Promise.resolve();
  const outbox = humanInteractionOutbox(path, {endpoint, humanEndpoint, apiKey});
  const flush = () => {
    delivery = delivery.catch(() => {}).then(async () => {
      if ((!endpoint && !humanEndpoint) || !apiKey) return;
      let names;
      try { names = (await readdir(outbox)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).slice(0, 100); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      if (!names.length) return;
      const events = [];
      let batchBytes = 32;
      for (const name of names) {
        const bytes = await readFile(join(outbox, name), "utf8");
        if (batchBytes + Buffer.byteLength(bytes) > 192 * 1024) break;
        events.push(JSON.parse(bytes));
        batchBytes += Buffer.byteLength(bytes) + 1;
      }
      if (!events.length) return;
      const target = humanEndpoint || new URL("/api/gateway/human-interactions", endpoint);
      const response = await fetch(target, {method:"POST",
        headers:{Authorization:`Bearer ${apiKey}`, "Content-Type":"application/json",
          ...(clientId ? {"X-Statewright-Client-Id":clientId} : {})},
        body:JSON.stringify({events}), signal:AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error("Human interaction upload was not acknowledged");
      const result = await response.json();
      const accepted = new Set([...(result.accepted_event_ids ?? []), ...(result.duplicate_event_ids ?? [])]);
      for (const record of events) if (accepted.has(record.event_id)) {
        await unlink(join(outbox, record.event_id + ".json"));
      }
    });
    return delivery;
  };
  return async (event, fields = {}) => {
    const human = fields.schema === "statewright/human-interaction/v1";
    const record = (human ? interactionValue : scrubTelemetryFields)({
      schema_version: 1,
      event_id: randomUUID(),
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      event,
      ...fields,
    });
    if (human) for (const key of ["dialog", "result"]) {
      const encoded = JSON.stringify(record[key]);
      if (encoded && encoded.length > 16384)
        record[key] = {truncated:true, excerpt:encoded.slice(0, 16000)};
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    if (human) {
      await mkdir(outbox, {recursive:true, mode:0o700});
      await writeFile(join(outbox, record.event_id + ".json"), JSON.stringify(record), {mode:0o600, flag:"wx"});
      await flush().catch(() => {});
      return;
    }
    void flush().catch(() => {});
    if (endpoint && apiKey) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ events: [record] }),
        });
        if (!response.ok) throw new Error(`telemetry endpoint returned ${response.status}`);
      } catch {
        // The local JSONL is the durable outbox. Delivery is best-effort and
        // must not alter workflow behavior when PocketBase is unavailable.
      }
    }
  };
}

export function createNullTelemetryWriter() {
  return async () => {};
}
