import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const AXES = ["model", "effort", "service_tier"];
const STATUSES = new Set(["captured", "active", "restore_pending"]);

function value(value) {
  return value == null ? null : String(value).trim() || null;
}

export function workflowRouteBinding(route, threadId, owner = {}) {
  return {
    thread_id: value(threadId ?? route?.session_id),
    run_id: value(route?.run_id),
    run_session_id: value(route?.run_session_id),
    client_id: value(route?.client_id ?? owner.client_id),
    root_session_id: value(route?.root_session_id ?? owner.root_session_id),
  };
}

export function sameWorkflowRouteBinding(left, right) {
  if (!left || !right) return false;
  for (const key of ["thread_id", "run_id", "client_id", "root_session_id"]) {
    if (!left[key] || left[key] !== right[key]) return false;
  }
  if (left.run_session_id || right.run_session_id) {
    return Boolean(left.run_session_id) && left.run_session_id === right.run_session_id;
  }
  return true;
}

function normalizeOrigin(origin) {
  const model = value(origin?.model);
  if (!model) return null;
  return {
    provider: value(origin.provider),
    model,
    effort: value(origin.effort),
    service_tier: value(origin.service_tier) ?? "default",
  };
}

function normalizeAxes(axes) {
  return [...new Set((axes ?? []).filter(axis => AXES.includes(axis)))];
}

function sameValue(left, right) {
  return value(left) === value(right);
}

function validBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  const normalized = workflowRouteBinding(binding, binding.thread_id);
  if (!normalized.thread_id || !normalized.run_id || !normalized.client_id || !normalized.root_session_id) return false;
  if (normalized.thread_id !== normalized.root_session_id) return false;
  return Object.entries(normalized).every(([key, selected]) => selected === value(binding[key]));
}

function validRecord(record, threadId) {
  if (!record || typeof record !== "object" || Array.isArray(record) || record.version !== 1) return false;
  if (!validBinding(record.binding) || record.binding.thread_id !== threadId) return false;
  const origin = normalizeOrigin(record.origin);
  if (!origin || Object.keys(record.ownership ?? {}).some(axis => !AXES.includes(axis))) return false;
  if (!AXES.every(axis => typeof record.ownership?.[axis] === "boolean")) return false;
  if (!record.manual || typeof record.manual !== "object" || Array.isArray(record.manual)) return false;
  if (Object.keys(record.manual).some(axis => !AXES.includes(axis))) return false;
  if (record.routed !== null && (!record.routed || typeof record.routed !== "object" || Array.isArray(record.routed)
      || !value(record.routed.model))) return false;
  if (!STATUSES.has(record.status) || typeof record.captured_at !== "string" || typeof record.updated_at !== "string") return false;
  return true;
}

function recordPath(root, threadId) {
  const digest = createHash("sha256").update(threadId).digest("hex");
  return join(root, `${digest}.json`);
}

/**
 * Durable, execution-context-bound ownership of the route that Statewright
 * temporarily replaced. The store records values, never credentials.
 */
export class WorkflowRouteOriginStore {
  constructor({ root = null, clientId = null, ownsBinding = async () => true, now = () => new Date().toISOString() } = {}) {
    this.root = root;
    this.clientId = value(clientId);
    this.ownsBinding = ownsBinding;
    this.now = now;
    this.records = new Map();
  }

  async #load(threadId) {
    if (this.records.has(threadId)) return this.records.get(threadId);
    if (!this.root) return null;
    let record = null;
    try { record = JSON.parse(await readFile(recordPath(this.root, threadId), "utf8")); } catch { /* absent or invalid is a safe miss */ }
    if (!validRecord(record, threadId)) return null;
    if (this.clientId && record.binding.client_id !== this.clientId) return null;
    this.records.set(threadId, record);
    return record;
  }

  async #write(record) {
    this.records.set(record.binding.thread_id, record);
    if (!this.root) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = recordPath(this.root, record.binding.thread_id);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  async #remove(threadId) {
    this.records.delete(threadId);
    if (this.root) await unlink(recordPath(this.root, threadId)).catch(error => {
      if (error?.code !== "ENOENT") throw error;
    });
  }

  async #authorized(binding) {
    if (!binding?.thread_id || !binding.run_id || !binding.client_id || !binding.root_session_id) return false;
    if (binding.thread_id !== binding.root_session_id) return false;
    if (this.clientId && binding.client_id !== this.clientId) return false;
    try { return await this.ownsBinding(binding); } catch { return false; }
  }

  async capture(binding, origin) {
    const normalized = normalizeOrigin(origin);
    if (!normalized) return { status: "missing_origin" };
    if (!await this.#authorized(binding)) return { status: "unowned_binding" };
    const existing = await this.#load(binding.thread_id);
    if (existing) {
      return sameWorkflowRouteBinding(existing.binding, binding)
        ? { status: "existing", record: structuredClone(existing) }
        : { status: "binding_conflict", record: structuredClone(existing) };
    }
    const timestamp = this.now();
    const record = {
      version: 1,
      binding: structuredClone(binding),
      origin: normalized,
      ownership: Object.fromEntries(AXES.map(axis => [axis, true])),
      manual: {},
      routed: null,
      status: "captured",
      captured_at: timestamp,
      updated_at: timestamp,
    };
    await this.#write(record);
    return { status: "captured", record: structuredClone(record) };
  }

  async confirmRoute(binding, route) {
    const record = await this.#load(binding?.thread_id);
    if (!record || !sameWorkflowRouteBinding(record.binding, binding)) return { status: "binding_mismatch" };
    if (!await this.#authorized(binding)) return { status: "unowned_binding" };
    const routed = {
      model: value(route?.model),
      effort: value(route?.effort),
      service_tier: value(route?.service_tier) ?? "default",
    };
    if (!routed.model) return { status: "invalid_route" };
    record.routed = routed;
    record.status = "active";
    record.updated_at = this.now();
    await this.#write(record);
    return { status: "confirmed", record: structuredClone(record) };
  }

  async relinquish(threadId, axes, changes = {}) {
    const selected = normalizeAxes(axes);
    const record = await this.#load(threadId);
    if (!record || selected.length === 0) return { status: record ? "unchanged" : "missing" };
    if (!await this.#authorized(record.binding)) return { status: "unowned_binding" };
    for (const axis of selected) {
      record.ownership[axis] = false;
      const changed = value(changes[axis]);
      if (changed) record.manual[axis] = changed;
    }
    record.updated_at = this.now();
    await this.#write(record);
    return { status: "relinquished", axes: selected, record: structuredClone(record) };
  }

  async prepareRestore(binding, current = {}) {
    const record = await this.#load(binding?.thread_id);
    if (!record) return { status: "missing_provenance" };
    if (!sameWorkflowRouteBinding(record.binding, binding)) return { status: "binding_mismatch" };
    if (!await this.#authorized(binding)) return { status: "unowned_binding" };
    if (!["active", "restore_pending"].includes(record.status) || !record.routed?.model) {
      return { status: "route_unconfirmed" };
    }
    const observed = {
      model: value(current.model),
      effort: value(current.effort),
      service_tier: value(current.service_tier) ?? "default",
    };
    if (!observed.model) return { status: "current_model_unknown" };
    // A settings callback is not the only way a human can change the native
    // route (for example, across a reconnect).  The last settings-confirmed
    // Statewright route is therefore the ownership boundary.  If any observed
    // axis diverged, preserve the complete current tuple; mixing an original
    // effort back into a manually selected model is not safe.
    const route = {};
    const restored = [];
    const relinquished = [];
    for (const axis of AXES) {
      if (record.ownership[axis]) {
        route[axis] = record.origin[axis];
        restored.push(axis);
      } else {
        route[axis] = value(record.manual?.[axis]) ?? observed[axis];
        relinquished.push(axis);
      }
    }
    // A restore may be interrupted before its settings notification arrives.
    // Retrying the exact binding is safe while native settings still equal
    // either the last confirmed Statewright route or the already-applied
    // restore target. Any third tuple is a later manual override and wins.
    const observedMatchesRouted = AXES.every(axis => sameValue(observed[axis], record.routed[axis]));
    const observedMatchesRestore = record.status === "restore_pending"
      && AXES.every(axis => sameValue(observed[axis], route[axis]));
    if (!observedMatchesRouted && !observedMatchesRestore) {
      await this.#remove(binding.thread_id);
      return { status: "relinquished", route: observed, restored: [], relinquished: [...AXES],
        reason: "observed_route_diverged" };
    }
    if (!route.model) return { status: "current_model_unknown", restored, relinquished };
    if (restored.length === 0) {
      await this.#remove(binding.thread_id);
      return { status: "relinquished", route, restored, relinquished };
    }
    record.status = "restore_pending";
    record.updated_at = this.now();
    await this.#write(record);
    return { status: "ready", route, restored, relinquished, record: structuredClone(record) };
  }

  async confirmRestore(binding) {
    const record = await this.#load(binding?.thread_id);
    if (!record || !sameWorkflowRouteBinding(record.binding, binding)) return { status: "binding_mismatch" };
    if (!await this.#authorized(binding)) return { status: "unowned_binding" };
    if (record.status !== "restore_pending") return { status: "restore_not_pending" };
    await this.#remove(binding.thread_id);
    return { status: "restored" };
  }

  async inspect(threadId) {
    const record = await this.#load(threadId);
    return record ? structuredClone(record) : null;
  }

  async binding(threadId) {
    const record = await this.#load(threadId);
    return record ? structuredClone(record.binding) : null;
  }
}
