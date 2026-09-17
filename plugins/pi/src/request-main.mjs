import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage, ModelRegistry, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { createJiti } from "@mariozechner/jiti";
import { assertPiNativeSession } from "../../executor/lib/host-adapters.mjs";
import { createPiRequestFrontend } from "./request-frontend.mjs";
import { createPiNativeReadinessPublisher, validatePiNativeReadinessChallenge } from "./request-readiness.mjs";
import { parsePiRequestMode, runPiRequestMode } from "./request-mode.mjs";

const keys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());

export function piRequestLaunchConfiguration(env) {
  const encoded = env.STATEWRIGHT_PI_REQUEST_LAUNCH;
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 16_384) throw new Error("Private managed Pi launch configuration required");
  let launch;
  try { launch = JSON.parse(encoded); } catch { throw new Error("Invalid private managed Pi launch configuration"); }
  if (!keys(launch, ["schema", "challenge", "cwd", "agent_dir", "model"])
    || launch.schema !== "statewright/pi-request-launch/v1"
    || ![launch.cwd, launch.agent_dir].every(value => typeof value === "string" && isAbsolute(value))
    || !keys(launch.model, ["provider", "id"]) || ![launch.model.provider, launch.model.id].every(value => typeof value === "string" && value.length > 0 && value.length <= 256)) {
    throw new Error("Invalid private managed Pi launch configuration");
  }
  return { ...launch, challenge: validatePiNativeReadinessChallenge(launch.challenge) };
}

export function createPiPrivateRequestTransport(env, { timeoutMs = 10_000 } = {}) {
  let url;
  try { url = new URL(env.STATEWRIGHT_ADAPTER_URL); } catch { throw new Error("Private loopback Pi bridge required"); }
  const token = env.STATEWRIGHT_ADAPTER_TOKEN;
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password
    || url.search || url.hash || url.pathname !== "/" || typeof token !== "string" || !token.length || token.length > 256
    || /[\u0000-\u0020\u007f]/.test(token) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Private loopback Pi bridge required");
  const origin = url.origin;
  return async (action, body, signal) => {
    if (!["ready", "begin", "status", "consume", "cancel"].includes(action)) throw new Error("Invalid private Pi request action");
    const response = await fetch(`${origin}/hooks/request/${action}`, { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Private Pi request refused (${response.status})`); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 65_536) throw new Error("Private Pi response exceeds its limit");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
}

async function registerProject(pi, ownership) {
  // Same upstream TypeScript-loader family; fixed project module, no caller
  // extension paths or loader discovery, no filesystem transpilation cache.
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
  const register = await jiti.import(fileURLToPath(new URL("./index.ts", import.meta.url)), { default: true });
  if (typeof register !== "function") throw new Error("Managed Pi project registration unavailable");
  await register(pi, ownership);
}

export async function runPiManagedCli({ argv = process.argv.slice(2), env = process.env, register = registerProject } = {}) {
  // The fixed project extension reads process.env itself. Never let its gateway
  // configuration differ from the private transport/launch configuration.
  if (register === registerProject && env !== process.env) throw new Error("Fixed managed Pi registration requires the process environment");
  const trace = stage => { if (env.STATEWRIGHT_PI_REQUEST_DEBUG === "1") process.stderr.write(`[statewright] Managed Pi stage: ${stage}\n`); };
  trace("intake");
  const mode = parsePiRequestMode(argv);
  const launch = piRequestLaunchConfiguration(env);
  const call = createPiPrivateRequestTransport(env);
  const { native_session_id: nativeSessionId, native_session_file: sessionFile } = launch.challenge;
  await assertPiNativeSession({ sessionFile, sessionId: nativeSessionId, cwd: launch.cwd });
  trace("descriptor verified");
  const sessionManager = SessionManager.open(sessionFile, undefined, launch.cwd);
  const authStorage = AuthStorage.create(join(launch.agent_dir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(launch.agent_dir, "models.json"));
  const model = modelRegistry.find(launch.model.provider, launch.model.id);
  if (!model) throw new Error("Exact managed Pi model unavailable");
  trace("model found");
  const onReady = createPiNativeReadinessPublisher({ challenge: launch.challenge, sessionManager, call });
  const frontend = await createPiRequestFrontend({ nativeSessionId, call,
    target: { cwd: launch.cwd, agentDir: launch.agent_dir, sessionManager },
    servicesOptions: { authStorage, modelRegistry, settingsManager: SettingsManager.create(launch.cwd, launch.agent_dir) },
    sessionOptions: { model, thinkingLevel: mode.thinkingLevel }, register: async (pi, ownership) => {
      trace("project registration started"); await register(pi, ownership); trace("project registered");
    }, onReady: async receipt => { trace("private acknowledgement started"); await onReady(receipt); trace("private acknowledgement received"); } });
  trace("native mode started");
  return runPiRequestMode(frontend, mode);
}
