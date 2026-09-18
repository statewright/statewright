import { isAbsolute, normalize } from "node:path";

const SCHEMA = "statewright/native-writer-recovery-binding/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const uuidFields = ["executor_session_id", "native_session_id", "owner_token",
  "parent_lifetime_id", "child_lifetime_id", "broker_lifetime_id", "writer_lease_id", "intent_id"];
const digestFields = ["scope_id", "owner_sha256", "lock_sha256", "native_sha256"];
const fields = ["schema", ...uuidFields, ...digestFields, "transport_client_id",
  "transport_session_id", "run_id", "native_session_file", "checkpoint_sha256",
  "request_epoch", "writer_lease_generation"];
const printable = value => typeof value === "string" && value.length > 0 && value.length <= 1024
  && !/[\u0000-\u001f\u007f]/.test(value);

function copyBinding(value) {
  const invalid = () => { throw new Error("Invalid native-writer recovery binding metadata"); };
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) invalid();
  const copy = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
    copy[field] = descriptor.value;
  }
  if (copy.schema !== SCHEMA
    || !uuidFields.every(field => typeof copy[field] === "string" && UUID.test(copy[field]))
    || !digestFields.every(field => typeof copy[field] === "string" && SHA256.test(copy[field]))
    || typeof copy.transport_client_id !== "string" || !copy.transport_client_id.startsWith("br_exec_")
    || !UUID.test(copy.transport_client_id.slice(8))
    || ![copy.transport_session_id, copy.run_id].every(printable)
    || !printable(copy.native_session_file) || !isAbsolute(copy.native_session_file)
    || normalize(copy.native_session_file) !== copy.native_session_file
    || copy.checkpoint_sha256 !== null && !(typeof copy.checkpoint_sha256 === "string" && SHA256.test(copy.checkpoint_sha256))
    || !Number.isSafeInteger(copy.request_epoch) || copy.request_epoch < 0
    || !Number.isSafeInteger(copy.writer_lease_generation) || copy.writer_lease_generation < 1) invalid();
  return copy;
}

/**
 * Compare untrusted binding METADATA with a separately selected expected intent.
 * This pure comparison is replayable: it verifies neither writer exit nor intent
 * provenance/one-use authority. Its result is NOT a recovery capability. No store
 * accepts it as authorization; a future private broker must supply those proofs.
 * Paths are lexical and digests are caller supplied, not observed filesystem facts.
 * Inputs are JSON-like data; executing hostile JavaScript Proxies is out of scope.
 */
export function matchExecutorRecoveryBinding(candidate, expected) {
  const selected = copyBinding(expected);
  const supplied = copyBinding(candidate);
  if (fields.some(field => supplied[field] !== selected[field])) {
    throw new Error("Native-writer recovery binding metadata mismatch");
  }
  return Object.freeze(supplied);
}
