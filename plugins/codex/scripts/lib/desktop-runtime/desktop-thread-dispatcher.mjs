import { randomUUID } from "node:crypto";

const threadPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const reads = new Set(["thread/read", "thread/attachment/list", "thread/goal/get"]);
const idKey = id => JSON.stringify([typeof id, id]);

// This layer selects isolated owners. It does not grant workflow permissions;
// each lane's existing route/approval proxy still authorizes execution.
export function createDesktopThreadDispatcher({ openLane, readBinding, saveBinding,
  emit, maxLanes = 16, initializeTimeoutMs = 30_000 }) {
  const lanes = new Map();
  const attached = new Map();
  const requests = new Map();
  const replies = new Map();
  const nonce = randomUUID();
  let sequence = 0;
  let initialization = null;
  let initialized = false;
  let closing = false;
  const work = new Set();

  const fail = (id, message) => emit({ jsonrpc: "2.0", id,
    error: { code: -32603, message: `Statewright Desktop: ${message}` } });

  async function retire(lane, reason) {
    if (lane.closed) return;
    lane.closed = true;
    lane.initReject?.(new Error(reason));
    clearTimeout(lane.initTimer);
    for (const [id, pending] of requests) if (pending.lane === lane) {
      requests.delete(id);
      fail(pending.id, reason);
    }
    for (const [id, pending] of replies) if (pending.lane === lane) replies.delete(id);
    for (const [id, owner] of attached) if (owner === lane) attached.delete(id);
    lanes.delete(lane.key);
    await lane.connection?.close();
  }

  async function fromLane(lane, message) {
    if (closing || lane.closed) return;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      await retire(lane, "Invalid native lane response."); return;
    }
    if (message.method && message.id !== undefined) {
      const id = `statewright-desktop:${nonce}:${++sequence}`;
      replies.set(idKey(id), { lane, originalId: message.id });
      emit({ ...message, id });
      return;
    }
    if (!message.method && message.id !== undefined) {
      if (message.id === lane.initId) {
        clearTimeout(lane.initTimer);
        if (message.error) lane.initReject(new Error("Native lane initialization failed."));
        else lane.initResolve();
        return;
      }
      const key = idKey(message.id);
      const pending = requests.get(key);
      if (!pending || pending.lane !== lane) {
        await retire(lane, "Native response did not belong to its lane."); return;
      }
      requests.delete(key);
      if (["thread/start", "thread/resume"].includes(pending.method)) lane.attaching = false;
      if (!message.error && ["thread/start", "thread/resume"].includes(pending.method)) {
        const threadId = message.result?.thread?.id;
        try {
          if (!threadPattern.test(threadId ?? "")
              || (pending.threadId && pending.threadId !== threadId)) {
            throw new Error("Native response returned a different or invalid thread.");
          }
          if (attached.has(threadId) && attached.get(threadId) !== lane) {
            throw new Error("Thread is already attached to another Desktop lane.");
          }
          await saveBinding(threadId, lane.key);
          if (closing || lane.closed) return;
          attached.set(threadId, lane);
          lane.threadId = threadId;
        } catch (error) {
          fail(message.id, error.message);
          await retire(lane, "Could not commit Desktop thread binding."); return;
        }
      }
      emit(message);
      if (message.error && ["thread/start", "thread/resume"].includes(pending.method)
          && !lane.threadId) await retire(lane, "Native thread attachment failed.");
      return;
    }
    emit(message);
  }

  async function getLane(key, threadId = null) {
    if (lanes.has(key)) return lanes.get(key).ready;
    if (lanes.size >= maxLanes) throw new Error("Desktop lane limit reached; save your work and restart Desktop before opening more chats.");
    const lane = { key, threadId: null, closed: false, connection: null, output: Promise.resolve() };
    lanes.set(key, lane);
    lane.ready = (async () => {
      try {
        lane.connection = await openLane({ key, threadId, discovery: key === "discovery",
          emit: message => { lane.output = lane.output.then(() => fromLane(lane, message))
            .catch(() => retire(lane, "Native lane protocol failure.")); },
          onClose: () => { void retire(lane, "Native Desktop lane disconnected."); },
        });
        if (closing || lane.closed) { await lane.connection.close(); throw new Error("Desktop is closing."); }
        if (key !== "discovery") {
          lane.initId = `statewright-desktop-init:${nonce}:${++sequence}`;
          const ready = new Promise((resolve, reject) => {
            lane.initResolve = resolve; lane.initReject = reject;
            lane.initTimer = setTimeout(() => reject(new Error("Native lane initialization timed out.")), initializeTimeoutMs);
          });
          lane.connection.send({ ...initialization, id: lane.initId });
          await ready;
          lane.connection.send({ method: "initialized" });
        }
        return lane;
      } catch (error) { await retire(lane, error.message); throw error; }
    })();
    return lane.ready;
  }

  async function dispatch(message) {
    if (closing) throw new Error("Desktop is closing.");
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid Desktop request.");
    if (!message.method) {
      const reply = replies.get(idKey(message.id));
      if (!reply) throw new Error("Approval response has no matching native lane.");
      replies.delete(idKey(message.id));
      reply.lane.connection.send({ ...message, id: reply.originalId });
      return;
    }
    if (message.method === "initialize") {
      if (initialization) throw new Error("Desktop is already initialized.");
      initialization = message;
    } else if (message.method === "initialized") {
      if (!initialization) throw new Error("Desktop initialize is required.");
      initialized = true;
    } else if (!initialized) throw new Error("Desktop initialization has not completed.");

    if (["config/value/write", "config/batchWrite"].includes(message.method)) {
      throw new Error("Profile-wide settings writes are not supported by the multi-chat broker yet. Change settings outside this launcher and restart it; per-chat settings remain available.");
    }

    const threadId = message.params?.threadId;
    if (threadId !== undefined && !threadPattern.test(threadId)) throw new Error("Invalid native thread ID.");
    if (message.method === "thread/fork") throw new Error("Forking requires its own managed thread binding and is not supported by this Desktop broker yet.");
    let lane;
    if (message.method === "thread/start") lane = await getLane(`new:${randomUUID()}`);
    else if (message.method === "thread/resume") {
      if (!threadId) throw new Error("A native thread ID is required to resume.");
      lane = attached.get(threadId) ?? await getLane(await readBinding(threadId) ?? `thread:${threadId}`, threadId);
    } else if (threadId && !reads.has(message.method)) {
      lane = attached.get(threadId);
      if (!lane) throw new Error("Resume this chat before changing it; no other chat's workflow was used.");
    } else lane = await getLane("discovery");
    if (["thread/start", "thread/resume"].includes(message.method) && lane.attaching) {
      throw new Error("Native resume for this chat is already pending.");
    }
    if (message.id !== undefined) {
      const key = idKey(message.id);
      if (requests.has(key)) throw new Error("Duplicate in-flight Desktop request ID.");
      requests.set(key, { id: message.id, lane, method: message.method, threadId });
    }
    if (["thread/start", "thread/resume"].includes(message.method)) lane.attaching = true;
    lane.connection.send(message);
  }

  return {
    handle(message) {
      // A slow new lane must not hold up replies to an existing lane's human
      // prompt, discovery reads, or another already-initialized thread.
      const pending = dispatch(message).catch(error => {
        if (message?.method && message.id !== undefined) fail(message.id, error.message);
      });
      work.add(pending);
      void pending.finally(() => work.delete(pending));
      return pending;
    },
    async close() {
      if (closing) return;
      closing = true;
      await Promise.all([...lanes.values()].map(lane => retire(lane, "Desktop dispatcher closed.")));
      await Promise.all([...work]);
    },
  };
}
