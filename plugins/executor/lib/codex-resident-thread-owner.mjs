import { bindManagedClientIdentity, commitCodexRootAttachment, readCodexRootSession } from "./managed-client-identity.mjs";

const ATTACH = new Set(["thread/start", "thread/resume", "thread/fork"]);
const ownershipError = message => Object.assign(new Error(message), {code: "STATEWRIGHT_THREAD_OWNERSHIP"});

// One attachment at a time across this resident's connections. Native Codex
// still decides whether a thread can be resumed (including active writers).
export function residentThreadAuthorizer({controlDir, clientId, home, cwd}) {
  let pending = null;
  return async ({method, threadId}) => {
    if (pending) throw ownershipError("Statewright is waiting for native thread attachment to finish. Try again after it completes.");
    if (!ATTACH.has(method)) return;
    const reservation = {};
    pending = reservation;
    try {
      const expectedRoot = await readCodexRootSession(controlDir);
      if (expectedRoot && expectedRoot.clientId !== clientId) {
        throw ownershipError("Statewright thread belongs to another managed client.");
      }
      let status = "pending";
      const assertPending = () => {
        if (status !== "committing" || pending !== lifecycle) {
          throw ownershipError("Statewright thread attachment was cancelled. Resume the conversation again.");
        }
      };
      const lifecycle = {
        version: 1, kind: "statewright_thread_adoption", method, threadId: threadId ?? null,
        async commit({threadId: attachedThreadId}) {
          if (status !== "pending") throw ownershipError("Statewright thread attachment is already settled.");
          status = "committing";
          try {
            await commitCodexRootAttachment(controlDir, {
              sessionId: attachedThreadId, clientId, expectedRoot, assertPending,
              beforeCommit: () => bindManagedClientIdentity({host: "codex", sessionId: attachedThreadId,
                clientId, home, cwd, preserveExisting: true}),
            });
            status = "committed";
          } finally { if (pending === lifecycle) pending = null; }
        },
        async cancel() {
          if (status === "committed") return;
          const committing = status === "committing";
          status = "cancelled";
          if (!committing && pending === lifecycle) pending = null;
        },
      };
      pending = lifecycle;
      return lifecycle;
    } finally { if (pending === reservation) pending = null; }
  };
}
