import { appendFile, chmod, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

export function createTelemetryWriter(path = defaultTelemetryPath(), { endpoint = null, apiKey = null } = {}) {
  let sequence = 0;
  return async (event, fields = {}) => {
    const record = scrubTelemetryFields({
      schema_version: 1,
      event_id: randomUUID(),
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      event,
      ...fields,
    });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
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
