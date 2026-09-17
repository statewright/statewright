import { isDeepStrictEqual } from "node:util";

const fields = ["schema", "executor_session_id", "native_session_id", "native_session_file", "parent_lifetime_id", "child_lifetime_id"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Trusted frontend onReady callback. No model tool, approval or resolver surface.
export function validatePiNativeReadinessChallenge(challenge) {
  if (!challenge || !isDeepStrictEqual(Object.keys(challenge).sort(), [...fields].sort())
    || challenge.schema !== "statewright/native-readiness-challenge/v1"
    || ![challenge.executor_session_id, challenge.native_session_id, challenge.parent_lifetime_id, challenge.child_lifetime_id].every(value => typeof value === "string" && uuid.test(value))
    || typeof challenge.native_session_file !== "string" || !challenge.native_session_file.startsWith("/")) throw new Error("Invalid private native readiness challenge");
  return Object.freeze({ ...challenge });
}

export function createPiNativeReadinessPublisher({ challenge, sessionManager, call, timeoutMs = 10_000 }) {
  const captured = validatePiNativeReadinessChallenge(challenge);
  if (typeof call !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid private native readiness transport limits");
  let started = false;
  const exactNative = () => sessionManager?.getSessionId() === captured.native_session_id
    && sessionManager?.getSessionFile() === captured.native_session_file;
  return async receipt => {
    if (started || !isDeepStrictEqual(receipt, { schema: "statewright/pi-native-readiness/v1", native_session_id: captured.native_session_id })
      || !exactNative()) throw new Error("Native readiness ownership mismatch");
    started = true;
    const controller = new AbortController();
    let timer;
    let acknowledgement;
    try {
      acknowledgement = await Promise.race([
        Promise.resolve().then(() => call("ready", { ...captured, schema: "statewright/pi-native-ready/v1" }, controller.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => {
          const error = new Error("Private native readiness acknowledgement timed out");
          controller.abort(error); reject(error);
        }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
    if (!exactNative() || !isDeepStrictEqual(acknowledgement,
      { ...captured, schema: "statewright/native-readiness-ack/v1", ready: true })) throw new Error("Invalid private native readiness acknowledgement");
  };
}
