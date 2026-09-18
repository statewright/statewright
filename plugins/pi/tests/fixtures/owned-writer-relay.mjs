import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";

// TEST ONLY: creator's separate Node IPC channel, never a model/HTTP endpoint.
// The parent trusts the creator's relay. Its events are NOT parent-observed
// kernel evidence; root's private authority still observes its own real handles.
export function writerRelaySelection(binding, parentPid, writerPid) {
  if (![parentPid, writerPid].every(pid => Number.isSafeInteger(pid) && pid > 0) || parentPid === writerPid) {
    throw new Error("Invalid registered relay PIDs");
  }
  return Object.freeze({ schema: "statewright/pi-owned-writer-relay/v1",
    executor_session_id: binding.executor_session_id, native_session_id: binding.native_session_id,
    native_session_file: binding.native_session_file, broker_lifetime_id: binding.broker_lifetime_id,
    parent_lifetime_id: binding.parent_lifetime_id, child_lifetime_id: binding.child_lifetime_id,
    writer_lease_id: binding.writer_lease_id, writer_lease_generation: binding.writer_lease_generation,
    parent_pid: parentPid, writer_pid: writerPid });
}

export function parentWriterPort(selected) {
  const events = new EventEmitter();
  let receipt = null;
  let port;
  port = Object.freeze({
    get pid() { return selected.writer_pid; },
    get exitCode() { return receipt?.code ?? null; },
    get signalCode() { return receipt?.signal ?? null; },
    get killed() { return false; },
    get exited() { return receipt !== null; },
    once(event, listener) {
      if (!["exit", "error"].includes(event) || typeof listener !== "function") throw new Error("Invalid private relay listener");
      events.once(event, listener); return port;
    },
    removeListener(event, listener) { events.removeListener(event, listener); return port; },
    receive(message) {
      if (receipt || !message || !isDeepStrictEqual(Object.keys(message).sort(), ["receipt", "selection", "type"])
        || message.type !== "writer-exit" || !isDeepStrictEqual(message.selection, selected)
        || !message.receipt || !isDeepStrictEqual(Object.keys(message.receipt).sort(), ["code", "signal"])
        || !(message.receipt.code === null && typeof message.receipt.signal === "string" && /^SIG[A-Z]+$/.test(message.receipt.signal)
          || Number.isSafeInteger(message.receipt.code) && message.receipt.code >= 0 && message.receipt.signal === null)) {
        throw new Error("Invalid or replayed creator lifecycle relay");
      }
      receipt = Object.freeze({ ...message.receipt });
      events.emit("exit", receipt.code, receipt.signal);
    },
  });
  return port;
}
