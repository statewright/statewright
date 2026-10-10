import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createDesktopThreadDispatcher } from "./desktop-thread-dispatcher.mjs";
import { desktopLaneClientId, requestDesktopLaneBridge } from "./desktop-bridge-pool.mjs";
import { claimCodexRootSession, claimManagedControlIdentity, claimManagedSessionOwner,
  readCodexRootSession, releaseManagedSessionOwner } from "./managed-client-identity.mjs";
import { readCodexResumePermissions, readCodexThreadCwds } from "./codex-session-metadata.mjs";
import { nextCodexResidentRouteRequest } from "./codex-app-server-resident.mjs";
import { desktopWorkflowServices } from "./desktop-workflow-services.mjs";

const threadPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const discoveryReads = new Set(["thread/read", "thread/attachment/list", "thread/goal/get"]);

export async function runDesktopMultichatRuntime({ plan, environment, home, stdin, stdout, stderr,
  startRuntime, isolateEnvironment, classifierState, WebSocketImpl = WebSocket, setExitCode }) {
  const bindings = join(home, ".statewright", "codex-desktop-app-server", plan.clientId, "threads");
  await mkdir(bindings, { recursive: true, mode: 0o700 });
  const legacy = await readCodexRootSession(plan.controlDir, plan.clientId);
  const bindingPath = threadId => {
    if (!threadPattern.test(threadId)) throw new Error("Invalid Desktop thread identity.");
    return join(bindings, `${threadId}.json`);
  };
  const readBinding = async threadId => {
    if (legacy?.sessionId === threadId) return "legacy";
    let value;
    try { value = JSON.parse(await readFile(bindingPath(threadId), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (value.version !== 1 || value.threadId !== threadId
        || value.clientId !== desktopLaneClientId(plan.clientId, value.key)
        || !["thread:", "new:"].some(prefix => value.key.startsWith(prefix))
        || (value.key.startsWith("thread:") && value.key !== `thread:${threadId}`)) {
      throw new Error("Desktop thread binding is invalid; no workflow was reassigned.");
    }
    return value.key;
  };
  const saveBinding = async (threadId, key) => {
    const prior = await readBinding(threadId);
    if (prior) {
      if (prior !== key) throw new Error("Desktop thread is bound to another workflow identity.");
      return;
    }
    const record = { version: 1, threadId, key, clientId: desktopLaneClientId(plan.clientId, key) };
    // The native writer lease serializes creation for this exact thread. Never
    // overwrite a different mapping, even when another process wins a race.
    try { await writeFile(bindingPath(threadId), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST" || await readBinding(threadId) !== key) throw error;
    }
  };

  const dispatcher = createDesktopThreadDispatcher({ readBinding, saveBinding,
    emit: message => stdout.write(`${JSON.stringify(message)}\n`),
    openLane: async ({ key, threadId, discovery, emit, onClose }) => {
      const bridge = await requestDesktopLaneBridge({
        url: environment.STATEWRIGHT_DESKTOP_BRIDGE_POOL_URL,
        token: environment.STATEWRIGHT_DESKTOP_BRIDGE_POOL_TOKEN, key,
      });
      const clientId = desktopLaneClientId(plan.clientId, key);
      if (bridge.clientId !== clientId) throw new Error("Desktop bridge returned a foreign workflow identity.");
      const controlDir = join(home, ".statewright", "codex-desktop-app-server", clientId, "routes");
      await mkdir(controlDir, { recursive: true, mode: 0o700 });
      await claimManagedControlIdentity(controlDir, { host: "codex", clientId });
      const isolated = isolateEnvironment(environment, { controlDir, clientId });
      const codexHome = isolated.CODEX_HOME ?? join(home, ".codex");
      let runtime, socket, lease, expected = threadId, confirmed = null, pending = false, closed = false;
      const manifest = join(controlDir, "..", "manifest.json");
      const owner = randomUUID();
      const release = async () => {
        if (lease) { const held = lease; lease = null;
          await releaseManagedSessionOwner({ ...held, ownerId: held.owner_id, sessionId: held.session_id, home }); }
      };
      const claim = async id => {
        if (lease) return;
        const metadata = await readCodexThreadCwds({ threadIds: [id], codexHome });
        lease = await claimManagedSessionOwner({ host: "codex", sessionId: id, clientId, home,
          cwd: metadata[id]?.cwd ?? home });
      };
      const commit = async id => {
        // Persist the provisional lane identity first. If the root claim then
        // fails, retry still finds the same owner instead of orphaning it and
        // deriving a second workflow identity for this native thread.
        await saveBinding(id, key);
        await claimCodexRootSession(controlDir, { sessionId: id, clientId });
        confirmed = id;
        expected = id;
      };
      const close = async () => {
        if (closed) return;
        closed = true;
        socket?.close();
        try { await runtime?.close(); }
        finally {
          await release();
          try { if (JSON.parse(await readFile(manifest, "utf8")).owner === owner) await unlink(manifest); }
          catch (error) { if (error.code !== "ENOENT") stderr.write("[statewright] Desktop lane manifest cleanup failed.\n"); }
        }
      };
      try {
        runtime = await startRuntime({ command: plan.command, clientId,
          ...(!discovery ? desktopWorkflowServices({home, controlDir, clientId,
            ownsThread: async id => confirmed === id && !pending && !closed,
            getState: () => classifierState({bridge, clientId}),
          }) : {}),
          environment: { ...isolated, STATEWRIGHT_MANAGED_MCP_URL: bridge.url,
            STATEWRIGHT_MANAGED_MCP_TOKEN: bridge.token, STATEWRIGHT_CLASSIFIER_APPROVAL_RECEIPT: manifest },
          nextRouteRequest: id => nextCodexResidentRouteRequest(controlDir, clientId, id),
          getThreadCwds: ids => readCodexThreadCwds({ threadIds: ids, codexHome }),
          resolveResumePermissions: id => readCodexResumePermissions({ threadId: id, codexHome }),
          classifierApprovalService: discovery ? undefined : {
            ownsThread: async id => confirmed === id && (await readCodexRootSession(controlDir, clientId))?.sessionId === id,
            getState: () => classifierState({ bridge, clientId }),
          },
          authorizeThread: async ({ method, threadId: id }) => {
            if (discovery) {
              if (discoveryReads.has(method)) return;
              throw new Error("Discovery cannot execute or adopt a Desktop thread.");
            }
            if (method === "thread/start") {
              if (expected || pending || confirmed) throw new Error("Desktop lane already owns a thread.");
              pending = true;
              return;
            }
            if (!id || id !== expected) throw new Error("Desktop lane cannot access another thread.");
            if (method !== "thread/resume") {
              if (!confirmed || pending) throw new Error("Desktop thread has not completed native resume.");
              return;
            }
            if (pending) throw new Error("Desktop thread resume is already pending.");
            pending = true;
            const hadLease = Boolean(lease);
            try { await claim(id); } catch (error) { pending = false; throw error; }
            let settled = false;
            return { version: 1, kind: "statewright_thread_adoption", method, threadId: id,
              commit: async () => {
                if (settled) throw new Error("Desktop native confirmation is stale.");
                try { await commit(id); settled = true; }
                finally { pending = false; }
              },
              cancel: async () => {
                if (settled) return;
                settled = true; pending = false;
                if (!hadLease) await release();
              },
            };
          },
          onThreadStarted: async ({ threadId: id }) => {
            if (discovery || expected || !pending || !threadPattern.test(id)) throw new Error("Unexpected native thread creation.");
            try { await claim(id); await commit(id); }
            catch (error) { await release(); throw error; }
            finally { pending = false; }
          },
          requiredMcpToolSuffix: discovery ? null : "statewright_get_state",
          requiredMcpReadyTimeoutMs: 30_000, stderr,
        });
        if (!discovery) await writeFile(manifest, `${JSON.stringify({ version: 3, owner, pid: process.pid,
          clientId, proxyUrl: runtime.proxyUrl, proxyToken: runtime.proxyToken, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
        socket = new WebSocketImpl(runtime.proxyUrl);
        socket.on("message", raw => {
          try { emit(JSON.parse(String(raw))); }
          catch { onClose(); }
        });
        socket.on("close", onClose);
        socket.on("error", () => { onClose(); });
        await new Promise((resolve, reject) => {
          socket.once("open", resolve); socket.once("error", reject);
          socket.once("close", () => reject(new Error("Desktop lane closed before connecting.")));
        });
        return { send: message => {
          if (socket.readyState !== WebSocketImpl.OPEN) throw new Error("Desktop lane is disconnected.");
          socket.send(JSON.stringify(message));
        }, close };
      } catch (error) { await close(); throw error; }
    },
  });
  let buffer = "";
  const onData = chunk => {
    buffer += String(chunk);
    if (buffer.length > 8 * 1024 * 1024) { stderr.write("[statewright] Desktop input exceeds limit.\n"); void close(true); return; }
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try { void dispatcher.handle(JSON.parse(line)); }
      catch { stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } })}\n`); }
    }
  };
  let closing;
  const onEnd = () => { void close(); };
  const signals = new Map();
  const close = (abnormal = false) => closing ??= (async () => {
    if (abnormal) setExitCode(1);
    stdin.off("data", onData); stdin.off("end", onEnd); stdin.pause?.();
    for (const [signal, handler] of signals) process.off(signal, handler);
    await dispatcher.close();
  })();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => { void close(); };
    signals.set(signal, handler); process.once(signal, handler);
  }
  stdin.on("data", onData); stdin.once("end", onEnd);
  return { close };
}
