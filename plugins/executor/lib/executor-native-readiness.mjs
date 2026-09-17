import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

// Ephemeral parent/owned-child authority, never persisted as process readiness.
export function createExecutorNativeReadiness({ owner, requestController }) {
  const saved = owner?.record;
  if (saved?.scope.host !== "pi" || !saved.host_ready || !saved.host_session_file
    || !saved.run_id || !saved.transport_session_id || typeof requestController?.close !== "function") {
    throw new Error("Native readiness requires an exact owned Pi descriptor");
  }
  const challenge = Object.freeze({ schema: "statewright/native-readiness-challenge/v1",
    executor_session_id: saved.executor_session_id, native_session_id: saved.host_session_id,
    native_session_file: saved.host_session_file, parent_lifetime_id: randomUUID(), child_lifetime_id: randomUUID() });
  const expected = { ...challenge, schema: "statewright/pi-native-ready/v1" };
  const acknowledgement = Object.freeze({ ...challenge, schema: "statewright/native-readiness-ack/v1", ready: true });
  let child = null;
  let phase = "waiting";
  let closing = null;
  const descriptor = () => {
    const now = owner.record;
    return now.host_ready && now.executor_session_id === saved.executor_session_id
      && now.host_session_id === saved.host_session_id && now.host_session_file === saved.host_session_file
      && now.run_id === saved.run_id && now.transport_session_id === saved.transport_session_id;
  };
  const alive = () => child && child.exitCode === null && child.signalCode === null && !child.killed;
  const ended = () => { void close().catch(() => {}); };
  function close() {
    phase = "closed";
    if (!closing) {
      child?.removeListener("exit", ended);
      child?.removeListener("error", ended);
      // Claim completion before the controller can invoke callbacks.
      closing = Promise.resolve().then(() => requestController.close());
    }
    return closing;
  }
  function check() {
    if (phase === "closed" || !alive() || !descriptor()) throw new Error("Native readiness unavailable; continuation denied");
  }
  async function assertAlive() {
    try { check(); await owner.assertOwner(); check(); }
    catch (error) { await close(); throw error; }
  }
  return Object.freeze({
    challenge,
    isBoundTo: (candidateOwner, candidateController) => candidateOwner === owner && candidateController === requestController,
    bindChild(ownedChild) {
      if (child || phase === "closed" || !Number.isSafeInteger(ownedChild?.pid) || ownedChild.pid <= 0
        || typeof ownedChild.once !== "function" || typeof ownedChild.removeListener !== "function"
        || ownedChild.exitCode !== null || ownedChild.signalCode !== null || ownedChild.killed) {
        throw new Error("Native readiness requires a fresh owned child");
      }
      child = ownedChild;
      child.once("exit", ended);
      child.once("error", ended);
    },
    async accept(receipt) {
      if (phase !== "waiting" || !isDeepStrictEqual(receipt, expected)) throw new Error("Invalid or replayed native readiness");
      // Synchronous claim: concurrent replay cannot share the first acknowledgement.
      phase = "accepting";
      await assertAlive();
      check();
      phase = "ready";
      return acknowledgement;
    },
    async assertReady() {
      await assertAlive();
      if (phase !== "ready") throw new Error("Native readiness unavailable; continuation denied");
    },
    get ready() {
      if (phase !== "ready") return false;
      try { check(); return true; } catch { ended(); return false; }
    },
    close,
  });
}
