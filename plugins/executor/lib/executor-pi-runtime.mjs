import { AdapterBridge } from "./adapter-bridge.mjs";
import { assertPiNativeSession } from "./host-adapters.mjs";
import { createExecutorRequestController } from "./executor-request-controller.mjs";
import { createExecutorNativeReadiness } from "./executor-native-readiness.mjs";

/** Descriptor-first composition, shared by main and inert parent fixtures. */
export async function createPiExecutorRuntime({ client, sessionOwner, approvalMirror, executorId, deliveryActive, telemetry }) {
  await sessionOwner.assertOwner();
  const saved = sessionOwner.record;
  await assertPiNativeSession({ sessionFile: saved.host_session_file, sessionId: saved.host_session_id, cwd: saved.scope.cwd });
  await sessionOwner.assertOwner();
  const getState = async () => {
    await sessionOwner.assertOwner();
    const live = await client.call("statewright_get_state");
    await sessionOwner.assertOwner();
    sessionOwner.assertGateway(live);
    return live;
  };
  const requestController = createExecutorRequestController({ owner: sessionOwner, approvalMirror, getState });
  const nativeReadiness = createExecutorNativeReadiness({ owner: sessionOwner, requestController });
  try {
    const adapterBridge = await new AdapterBridge(client, { host: "pi", sessionOwner, requestController,
      nativeReadiness, executorId, deliveryActive, telemetry }).start();
    return Object.freeze({ adapterBridge, requestController, nativeReadiness });
  } catch (error) { await nativeReadiness.close(); throw error; }
}
