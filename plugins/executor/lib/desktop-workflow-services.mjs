import { join } from "node:path";
import { readCodexRootSession } from "./managed-client-identity.mjs";
import { peekCodexResidentRouteRequest } from "./codex-app-server-resident.mjs";
import { WorkflowRouteOriginStore } from "./workflow-route-origin.mjs";
import { createTelemetryWriter } from "./telemetry.mjs";

// Keep per-thread workflow ownership separate from the profile-wide Desktop
// dispatcher. The loopback bridge supplies state; no gateway key enters here.
export function desktopWorkflowServices({home, controlDir, clientId, ownsThread, getState}) {
  const owns = async threadId => Boolean(await ownsThread(threadId))
    && (await readCodexRootSession(controlDir, clientId))?.sessionId === threadId;
  return {
    workflowService: {
      ownsThread: owns,
      getState: async threadId => {
        if (!await owns(threadId)) throw new Error("Desktop workflow is not owned by this thread");
        const state = await getState(threadId);
        if (!await owns(threadId)) throw new Error("Desktop workflow owner changed during state lookup");
        return state;
      },
    },
    workflowOriginStore: new WorkflowRouteOriginStore({
      root: join(controlDir, "..", "workflow-origins"), clientId,
      ownsBinding: binding => owns(binding.thread_id),
    }),
    routeOwner: async threadId => ({client_id: clientId, root_session_id: await owns(threadId) ? threadId : null}),
    peekRouteRequest: (threadId, turnId) => peekCodexResidentRouteRequest(controlDir, clientId, threadId, turnId),
    telemetry: createTelemetryWriter(join(home, ".statewright", "telemetry", "codex-routing.jsonl")),
  };
}
