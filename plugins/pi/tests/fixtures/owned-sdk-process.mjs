import { join } from "node:path";
import { AuthStorage, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { createPiRequestFrontend } from "../../src/request-frontend.mjs";
import { createPiNativeReadinessPublisher } from "../../src/request-readiness.mjs";

// Task-owned IPC driver only: public SDK, inert provider, no native mode init/run.
const schema = "statewright/pi-process-fixture/v1";
const send = (type, value = {}) => process.send?.({ schema, type, pid: process.pid, ...value });
let frontend;
let prompt;
let initialized = false;
let closing = false;

async function initialize(options) {
  if (initialized || closing) throw new Error("Fixture initialization replay");
  initialized = true;
  const { challenge, cwd, nativeRoot, bridge, providerUrl, withholdBegin } = options;
  const sessionManager = SessionManager.open(challenge.native_session_file, nativeRoot, cwd);
  const call = async (action, body, signal) => {
    const response = await fetch(`${bridge.url}/hooks/request/${action}`, {
      method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (action === "begin" && withholdBegin) {
      // Parent completed durable admission; the frontend never receives its ref.
      send("begin-withheld", { reference: result.reference });
      await new Promise((_, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return result;
  };
  const model = { id: "synthetic-chat", name: "Synthetic", api: "openai-completions", provider: "synthetic-provider",
    baseUrl: providerUrl, reasoning: false, input: ["text"], contextWindow: 65_536, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const modelRegistry = { hasConfiguredAuth: () => true,
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-not-a-secret" }),
    getAll: () => [], getAvailable: () => [model], find: () => model, isUsingOAuth: () => false,
    registerProvider() {}, unregisterProvider() {} };
  const publish = createPiNativeReadinessPublisher({ challenge, sessionManager, call });
  let reportedPark = false;
  frontend = await createPiRequestFrontend({ nativeSessionId: challenge.native_session_id, call,
    target: { cwd, agentDir: join(cwd, "fixture-agent"), sessionManager },
    servicesOptions: { authStorage: AuthStorage.inMemory(), modelRegistry,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) },
    resources: { noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, systemPrompt: "Synthetic fixture" },
    sessionOptions: { model, thinkingLevel: "off", noTools: "all" },
    gateOptions: { pollMs: 10, timeoutMs: 10_000, onPark() {
      if (!reportedPark) { reportedPark = true; send("parked"); }
    } }, register() {}, onReady: publish });
  await frontend.runtime.session.bindExtensions({ uiContext: { notify() {}, setStatus() {} } });
  send("ready", { nativeSessionId: sessionManager.getSessionId(), nativeSessionFile: sessionManager.getSessionFile(),
    environmentKeys: Object.keys(process.env).sort() });
}

async function close() {
  if (closing) return;
  closing = true;
  await frontend?.close();
  await prompt;
  send("closed");
  process.removeListener("message", dispatch);
  process.disconnect?.();
}

function dispatch(message) {
  void (async () => {
    if (message?.schema !== schema) throw new Error("Invalid fixture IPC envelope");
    if (message.type === "initialize") return initialize(message.options);
    if (message.type === "close") return close();
    if (message.type !== "prompt" || !frontend || closing || prompt || typeof message.text !== "string") {
      throw new Error("Invalid fixture IPC command");
    }
    prompt = frontend.runtime.session.prompt(message.text).then(() => {
      send("prompt-settled", { finalResponse: frontend.finalResponse });
    });
    prompt.catch(fail);
  })().catch(fail);
}

function fail(error) {
  send("failure", { error: String(error?.message ?? error) });
  process.exitCode = 1;
  void close().catch(() => { process.disconnect?.(); });
}

process.on("message", dispatch);
