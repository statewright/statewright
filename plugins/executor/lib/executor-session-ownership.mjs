import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gatewayEndpoint } from "./remote-client.mjs";
import { requestCheckpoint, requestReference, sameRequest, validateExecutorRequest } from "./executor-request-record.mjs";

const SCHEMA = "statewright/executor-session/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const printable = value => typeof value === "string" && value.length > 0 && value.length <= 1024
  && !/[\u0000-\u001f\u007f]/.test(value);
const noWorkflow = "No active workflow. Load a workflow before requesting state.";

function inside(root, path) {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(suffix);
}

export function createExecutorSessionStore({ root, workflow, projectId, host, cwd, apiKey, gatewayUrl }) {
  const scope = { workflow, project_id: projectId ?? null, host, cwd: resolve(cwd),
    gateway_url: gatewayEndpoint(gatewayUrl), credential_fingerprint: createHash("sha256").update(apiKey).digest("hex") };
  if (![workflow, host].every(printable) || scope.project_id !== null && !printable(scope.project_id)) {
    throw new Error("Invalid executor ownership scope");
  }
  const scopeId = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  const directory = join(root, scopeId);

  async function syncDirectory() {
    if (process.platform === "win32") return;
    const file = await open(directory, "r");
    try { await file.sync(); } finally { await file.close(); }
  }

  async function writeAtomic(path, record) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(JSON.stringify(record) + "\n");
      await file.sync(); await file.close(); file = null;
      await rename(temporary, path);
      await syncDirectory();
    } finally {
      await file?.close();
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }

  function validate(record, sessionId, nativeRoot) {
    if (record?.schema !== SCHEMA || record.executor_session_id !== sessionId || !isDeepStrictEqual(record.scope, scope)
      || typeof record.transport_client_id !== "string" || !record.transport_client_id.startsWith("br_exec_") || !UUID.test(record.transport_client_id.slice(8))
      || record.transport_session_id !== null && !printable(record.transport_session_id)
      || record.run_id !== null && !printable(record.run_id)
      || !printable(record.host_session_id) || typeof record.host_ready !== "boolean"
      || ["pi", "claude"].includes(scope.host) && !UUID.test(record.host_session_id)
      || scope.host === "pi" && record.host_ready && record.host_session_file === null
      || record.host_session_file !== null && (!printable(record.host_session_file) || !isAbsolute(record.host_session_file) || !inside(nativeRoot, record.host_session_file))
      || (record.run_id === null) !== (record.transport_session_id === null)
      || !Number.isSafeInteger(record.request_epoch) || record.request_epoch < 0
      || typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at))) {
      throw new Error("Invalid or foreign executor ownership record; resume denied");
    }
    validateExecutorRequest(record);
    return record;
  }

  async function openSession({ sessionId, resume = false } = {}) {
    if (resume && !sessionId) throw new Error("Resume requires an explicit executor session ID");
    sessionId ??= randomUUID();
    if (!UUID.test(sessionId)) throw new Error("Executor session ID must be a UUID");
    const path = join(directory, sessionId + ".json");
    const nativeRoot = join(directory, sessionId + ".native");
    if (resume) {
      try { validate(JSON.parse(await readFile(path, "utf8")), sessionId, nativeRoot); }
      catch (error) {
        if (error.code === "ENOENT") throw new Error("Explicit executor session not found; no replacement was created");
        throw error;
      }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = path + ".lock";
    const ownerToken = randomUUID();
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); } catch (error) {
      if (error.code === "EEXIST") throw new Error("Executor session is already owned; dead-owner recovery requires native-writer verification");
      throw error;
    }
    let released = false;
    let closing = false;
    let mutation = Promise.resolve();
    let record;
    async function assertOwner() {
      if (released || JSON.parse(await readFile(lockPath, "utf8")).owner_token !== ownerToken) {
        throw new Error("Executor ownership changed; continuation denied");
      }
      if (record && !isDeepStrictEqual(validate(JSON.parse(await readFile(path, "utf8")), sessionId, nativeRoot), record)) {
        throw new Error("Executor ownership record changed; continuation denied");
      }
    }
    async function release() {
      if (released) return;
      closing = true;
      await mutation;
      await assertOwner();
      await lock.close();
      await unlink(lockPath);
      await syncDirectory();
      released = true;
    }
    try {
      await lock.writeFile(JSON.stringify({ schema: "statewright/executor-owner/v1", owner_token: ownerToken, pid: process.pid, session_id: sessionId }));
      await lock.sync(); await syncDirectory();
      let raw;
      try { raw = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (resume) {
        if (!raw) throw new Error("Explicit executor session not found; no replacement was created");
        record = validate(JSON.parse(raw), sessionId, nativeRoot);
      } else {
        if (raw !== undefined) throw new Error("Executor session already exists; use explicit resume, not replacement");
        record = { schema: SCHEMA, executor_session_id: sessionId, scope, transport_client_id: `br_exec_${randomUUID()}`,
          transport_session_id: null, host_session_id: randomUUID(), host_session_file: null, host_ready: false,
          run_id: null, request_epoch: 0, created_at: new Date().toISOString() };
        await writeAtomic(path, record);
      }
    } catch (error) {
      // Only our freshly claimed lock is removed; never rewrite the record.
      await lock.close();
      await unlink(lockPath);
      throw error;
    }

    async function save(next) {
      await assertOwner();
      const disk = validate(JSON.parse(await readFile(path, "utf8")), sessionId, nativeRoot);
      if (!isDeepStrictEqual(disk, record)) throw new Error("Executor ownership record changed; continuation denied");
      validate(next, sessionId, nativeRoot);
      await writeAtomic(path, next);
      record = next;
    }

    function mutate(operation) {
      if (closing || released) return Promise.reject(new Error("Executor ownership is closing; continuation denied"));
      const result = mutation.then(async () => {
        await assertOwner();
        const next = await operation(structuredClone(record));
        await save(next);
        return structuredClone(record);
      });
      mutation = result.catch(() => {});
      return result;
    }

    async function assertRequest(reference, { terminal = false } = {}) {
      await stableOwner();
      if (closing || !sameRequest(record.request, reference)
        || !terminal && ["cancelled", "completed"].includes(record.request.phase)) {
        throw new Error("Request ownership changed or ended; continuation denied");
      }
      return structuredClone(record.request);
    }

    async function stableOwner() {
      // Public readers must not compare the new atomic disk image with the
      // preceding cached record while an owned queued write is completing.
      await mutation;
      await assertOwner();
    }

    function mutateRequest(reference, operation) {
      return mutate(next => {
        if (!sameRequest(next.request, reference) || ["cancelled", "completed"].includes(next.request.phase)) {
          throw new Error("Request ownership changed or ended; continuation denied");
        }
        next.request = operation(next.request);
        return next;
      }).then(next => next.request);
    }

    function assertGateway(live) {
      if (![live?.run_id, live?.run_session_id, live?.state].every(printable) || live.workflow !== scope.workflow
        || record.run_id !== null && record.run_id !== live.run_id
        || record.transport_session_id !== null && record.transport_session_id !== live.run_session_id) {
        throw new Error("Gateway run/session ownership identity mismatch; continuation denied");
      }
    }

    return {
      path, nativeRoot, scopeId, assertOwner: stableOwner, assertGateway, assertRequest, release,
      get record() { return structuredClone(record); },
      async bindGateway(live) {
        await mutate(next => {
          assertGateway(live);
          return { ...next, run_id: live.run_id, transport_session_id: live.run_session_id };
        });
      },
      async bindHost({ sessionId: hostSessionId, sessionFile = null }) {
        await mutate(next => {
          if (!printable(hostSessionId) || next.host_ready && (hostSessionId !== next.host_session_id || sessionFile !== next.host_session_file)
            || scope.host !== "cursor" && hostSessionId !== next.host_session_id) {
            throw new Error("Native session ownership identity mismatch; continuation denied");
          }
          return { ...next, host_session_id: hostSessionId, host_session_file: sessionFile, host_ready: true };
        });
      },
      async beginRequest({ inputDigest, nativeSessionId }) {
        const next = await mutate(next => {
          if (nativeSessionId !== next.host_session_id || !next.host_ready || !next.run_id
            || typeof inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(inputDigest) || next.request_epoch >= Number.MAX_SAFE_INTEGER) {
            throw new Error("Invalid native request ownership; continuation denied");
          }
          next.request_epoch += 1;
          next.request = { schema: "statewright/executor-request/v1", request_id: randomUUID(),
            request_epoch: next.request_epoch, native_session_id: nativeSessionId, input_digest: inputDigest,
            phase: "active", approval: null, release_nonce: null,
            consumed_approval_ids: next.request?.consumed_approval_ids ?? [], reason: null };
          return next;
        });
        return requestReference(next.request);
      },
      parkRequest(reference, live) {
        const checkpoint = requestCheckpoint(live);
        return mutateRequest(reference, request => {
          if (request.consumed_approval_ids.includes(checkpoint.pending_approval.approval_id)
            || request.approval && !isDeepStrictEqual(request.approval, checkpoint)) {
            throw new Error("Request approval changed or was consumed; continuation denied");
          }
          return { ...request, phase: request.phase === "ready" ? "ready" : "parked", approval: checkpoint };
        });
      },
      readyRequest(reference) {
        return mutateRequest(reference, request => {
          if (!["parked", "ready"].includes(request.phase)) throw new Error("Request has no parked release");
          return { ...request, phase: "ready", release_nonce: request.release_nonce ?? randomUUID() };
        });
      },
      consumeRequest(reference, nonce) {
        return mutateRequest(reference, request => {
          if (request.phase !== "ready" || request.release_nonce !== nonce || typeof nonce !== "string" || !UUID.test(nonce)) {
            throw new Error("Release is stale or already consumed; continuation denied");
          }
          return { ...request, phase: "active", approval: null, release_nonce: null,
            consumed_approval_ids: [...request.consumed_approval_ids, request.approval.pending_approval.approval_id] };
        });
      },
      cancelRequest(reference, reason = "cancelled") {
        return mutateRequest(reference, request => ({ ...request, phase: "cancelled", release_nonce: null, reason }));
      },
      completeRequest(reference) {
        return mutateRequest(reference, request => ({ ...request, phase: "completed", release_nonce: null, reason: "completed" }));
      },
    };
  }
  return { open: openSession, scopeId };
}

/** Reattach exact owned state, or ask durable storage for the exact owned run. */
export async function attachExecutorSession({ client, owner, resume = false }) {
  await owner.assertOwner();
  const saved = owner.record;
  if (resume && (!saved.run_id || !saved.transport_session_id)) {
    throw new Error("Incomplete executor run ownership; explicit recovery is required");
  }
  await client.initialize();
  async function bindState(state) {
    await owner.assertOwner();
    if (client.requireNegotiatedSessionId && state?.run_session_id !== client.sessionId) {
      throw new Error("Gateway state does not match its authoritative MCP session; continuation denied");
    }
    await owner.bindGateway(state);
  }
  let state;
  if (resume) {
    let inactive = false;
    try { state = await client.call("statewright_get_state"); } catch (error) {
      if (error.message !== noWorkflow) throw error;
      inactive = true;
    }
    if (!inactive) {
      await bindState(state);
      return state;
    }
  }
  await owner.assertOwner();
  if (resume && !await client.supportsExactRunResume()) {
    throw new Error("Gateway does not advertise exact-run resume; no workflow was loaded");
  }
  await owner.assertOwner();
  await client.call("statewright_load_workflow", { name: saved.scope.workflow, resume,
    ...(resume ? { run_id: saved.run_id } : {}), ...(saved.scope.project_id ? { project_id: saved.scope.project_id } : {}) });
  state = await client.call("statewright_get_state");
  await bindState(state);
  return state;
}
