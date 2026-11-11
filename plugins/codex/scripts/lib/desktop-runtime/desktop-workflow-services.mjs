import { join } from "node:path";
import { readCodexRootSession } from "./managed-client-identity.mjs";
import { WorkflowRouteOriginStore, sameWorkflowRouteBinding } from "./workflow-route-origin.mjs";
import { createTelemetryWriter } from "./telemetry.mjs";
import { DesktopUsageRelay, projectDesktopUsage } from "./desktop-native-usage.mjs";

// Keep per-thread workflow ownership separate from the profile-wide Desktop
// dispatcher. The loopback bridge supplies state; no gateway key enters here.
export function codexWorkflowServices({home, controlDir, clientId, ownsThread, getState, bridge,
  verifyRouteSuccessor, peekRouteRequest = async () => null}) {
  const owns = async threadId => Boolean(await ownsThread(threadId))
    && (await readCodexRootSession(controlDir, clientId))?.sessionId === threadId;
  const telemetry = createTelemetryWriter(join(home, ".statewright", "telemetry", "codex-routing.jsonl"), {
    humanEndpoint:bridge ? `${bridge.url}/human-interactions` : null,
    apiKey:bridge?.token ?? null, clientId,
  });
  const usage = bridge ? new DesktopUsageRelay({
    path: join(controlDir, "..", "native-usage-relay.jsonl"),
    deliver: async event => {
      const response = await fetch(`${bridge.url}/native-usage`, {
        method: "POST", headers: {Authorization: `Bearer ${bridge.token}`,
          "X-Statewright-Client-Id": clientId, "Content-Type": "application/json"},
        body: JSON.stringify(event), signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error(`Desktop native usage receipt HTTP ${response.status}`);
    },
  }) : null;
  return {
    closeNativeUsage: () => usage?.close(),
    workflowService: {
      ownsThread: owns,
      async verifyRouteSuccessor(previous, current) {
        if (!await owns(current.thread_id) || previous.client_id !== clientId
            || current.client_id !== clientId) return false;
        let verified;
        if (verifyRouteSuccessor) {
          verified = await verifyRouteSuccessor(previous, current);
        } else if (bridge) {
          const response = await fetch(`${bridge.url}/route-successor`, {
            method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${bridge.token}`,
              "X-Statewright-Client-Id":clientId},body:JSON.stringify({previous,current}),
            signal:AbortSignal.timeout(15000),redirect:"error",
          });
          if (!response.ok) return false;
          const result = await response.json();
          verified = result.schema === "statewright/route-successor/v1" && result.verified === true
            && sameWorkflowRouteBinding(result.previous, previous)
            && sameWorkflowRouteBinding(result.current, current);
        }
        return verified === true && await owns(current.thread_id);
      },
      getState: async threadId => {
        if (!await owns(threadId)) throw Object.assign(new Error("Statewright workflow is not owned by this thread. Resume the conversation again before sending."), {code: "STATEWRIGHT_THREAD_OWNERSHIP"});
        const state = await getState(threadId);
        if (!await owns(threadId)) throw Object.assign(new Error("Statewright workflow owner changed during state lookup. Resume the conversation again before sending."), {code: "STATEWRIGHT_THREAD_OWNERSHIP"});
        return state;
      },
    },
    workflowOriginStore: new WorkflowRouteOriginStore({
      root: join(controlDir, "..", "workflow-origins"), clientId,
      ownsBinding: binding => owns(binding.thread_id),
    }),
    routeOwner: async threadId => ({client_id: clientId, root_session_id: await owns(threadId) ? threadId : null}),
    peekRouteRequest,
    telemetry,
    onNativeUsage: async event => {
      if (!await owns(event.conversation_id)) return;
      if (usage) usage.append(event);
      else await telemetry("app_server_native_usage", projectDesktopUsage(event));
    },
  };
}

export const desktopWorkflowServices = codexWorkflowServices;
