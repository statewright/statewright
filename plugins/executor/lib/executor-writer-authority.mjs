import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { matchExecutorRecoveryBinding } from "./executor-recovery-contract.mjs";

const stable = ["scope_id", "executor_session_id", "transport_client_id", "transport_session_id", "run_id",
  "native_session_id", "native_session_file", "parent_lifetime_id", "child_lifetime_id", "broker_lifetime_id",
  "writer_lease_id", "writer_lease_generation"];
function capability() {
  return Object.freeze({ toJSON() { throw new Error("Private lifecycle capability cannot be serialized"); } });
}
async function bounded(promise, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid exit observation deadline");
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Owned process observation timed out")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Trusted-root-only experimental authority for a registered Node parent/writer pair.
 * Never exposed through a bridge/CLI/model tool. No arbitrary PID/handle adoption,
 * filesystem verification/reclamation, durable ledger or unregistered-writer proof.
 * Closing revokes authority, NOT proof of exit; owned ports remain for cleanup.
 */
export function createExecutorWriterAuthority() {
  const lifetimeId = randomUUID();
  const leases = new WeakMap();
  const witnesses = new WeakMap();
  const reservations = new Set();
  const intents = new Set();
  let closed = false;
  const available = () => { if (closed) throw new Error("Writer authority is closed"); };
  function select(lease) {
    available();
    const entry = lease && leases.get(lease);
    if (!entry) throw new Error("Unknown private writer lease");
    return entry;
  }
  return Object.freeze({
    lifetimeId,
    reserve(binding) {
      available();
      const selected = matchExecutorRecoveryBinding(binding, binding);
      if (selected.broker_lifetime_id !== lifetimeId) throw new Error("Foreign writer authority lifetime");
      const keys = [`scope:${selected.scope_id}:${selected.executor_session_id}`,
        `native:${selected.native_session_id}`, `file:${selected.native_session_file}`];
      if (keys.some(key => reservations.has(key))) throw new Error("Writer lineage is already reserved");
      if (selected.parent_lifetime_id === selected.child_lifetime_id || selected.writer_lease_generation !== 1) {
        throw new Error("Unsupported writer lifecycle generation or role alias");
      }
      const lease = capability();
      leases.set(lease, { selected, children: new Map(), phase: "active" });
      for (const key of keys) reservations.add(key);
      return lease;
    },
    startNode(lease, role, options) {
      const entry = select(lease);
      if (entry.phase !== "active") throw new Error("Writer lease is sealed");
      if (!["parent", "writer"].includes(role) || entry.children.has(role)) throw new Error("Invalid or already registered writer role");
      if (!options || Object.keys(options).sort().join(",") !== "args,cwd"
        || !Array.isArray(options.args) || !options.args.every(value => typeof value === "string")
        || typeof options.cwd !== "string" || !isAbsolute(options.cwd)) throw new Error("Invalid private Node launch options");
      let resolveExit, resolveClose;
      const record = { spawned: false, failed: false, exited: false };
      const exit = new Promise(resolve => { resolveExit = resolve; });
      const close = new Promise(resolve => { resolveClose = resolve; });
      // Reserve the role before any native launch/async publication.
      entry.children.set(role, record);
      let child;
      try {
        child = spawn(process.execPath, [...options.args], { cwd: options.cwd,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          stdio: ["ignore", "pipe", "pipe", "ipc"], detached: false, shell: false });
      } catch (error) { record.failed = true; throw error; }
      child.stdout.resume(); child.stderr.resume();
      child.once("spawn", () => { record.spawned = true; });
      child.on("error", () => { record.failed = true; });
      child.once("exit", (code, signal) => {
        record.exited = true;
        resolveExit(Object.freeze({ code, signal }));
      });
      child.once("close", (code, signal) => { resolveClose(Object.freeze({ code, signal })); });
      // Do not expose the ChildProcess: callers cannot emit fake exit events or
      // mutate its exit fields. Callbacks never receive the native handle as this.
      const listeners = new Map();
      let port;
      port = Object.freeze({
        get pid() { return child.pid ?? null; },
        get exitCode() { return child.exitCode; },
        get signalCode() { return child.signalCode; },
        get killed() { return child.killed; },
        get exited() { return record.exited; },
        once(event, listener) {
          if (!["exit", "error"].includes(event) || typeof listener !== "function") throw new Error("Invalid owned lifecycle listener");
          let byListener = listeners.get(event);
          if (!byListener) { byListener = new Map(); listeners.set(event, byListener); }
          if (byListener.has(listener)) throw new Error("Duplicate owned lifecycle listener");
          const wrapped = (...values) => { byListener.delete(listener); listener(...values); };
          byListener.set(listener, wrapped); child.once(event, wrapped);
          return port;
        },
        removeListener(event, listener) {
          const byListener = listeners.get(event), wrapped = byListener?.get(listener);
          if (wrapped) { child.removeListener(event, wrapped); byListener.delete(listener); }
          return port;
        },
        onMessage(listener) {
          if (typeof listener !== "function") throw new Error("Invalid owned IPC listener");
          const wrapped = message => listener(message);
          child.on("message", wrapped);
          return () => { child.removeListener("message", wrapped); };
        },
        send(message) {
          available();
          if (entry.phase !== "active" || !child.connected || record.exited) throw new Error("Owned process IPC unavailable");
          return new Promise((resolve, reject) => child.send(message, error => error ? reject(error) : resolve()));
        },
        signal(signal) {
          if (!["SIGTERM", "SIGKILL"].includes(signal)) throw new Error("Unsupported owned cleanup signal");
          return record.exited ? false : child.kill(signal);
        },
        waitForExit(timeoutMs = 5_000) { return bounded(exit, timeoutMs); },
        waitForClose(timeoutMs = 5_000) { return bounded(close, timeoutMs); },
        toJSON() { throw new Error("Private owned process port cannot be serialized"); },
      });
      return port;
    },
    seal(lease, candidate, expected) {
      const entry = select(lease);
      if (entry.phase !== "active") throw new Error("Writer lease is sealed");
      const selected = matchExecutorRecoveryBinding(candidate, expected);
      if (stable.some(field => selected[field] !== entry.selected[field])) throw new Error("Reserved writer lineage mismatch");
      if (entry.children.size !== 2 || [...entry.children.values()].some(child => !child.spawned || child.failed || !child.exited)) {
        throw new Error("Writer witness requires observed exits for both registered roles");
      }
      if (intents.has(selected.intent_id)) throw new Error("Recovery intent was already witnessed");
      const witness = capability();
      witnesses.set(witness, { entry, selected, consumed: false });
      intents.add(selected.intent_id);
      entry.phase = "sealed";
      return witness;
    },
    consume(witness, candidate) {
      available();
      const proof = witness && witnesses.get(witness);
      if (!proof) throw new Error("Unknown private writer witness");
      if (proof.consumed) throw new Error("Writer witness was consumed");
      const selected = matchExecutorRecoveryBinding(candidate, proof.selected);
      proof.consumed = true;
      proof.entry.phase = "consumed";
      // No transfer/unlock: reservation deliberately remains held even now.
      return selected;
    },
    close() { closed = true; },
  });
}
