import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { ClassifierReworkGate } from "./classifier-rework-gate.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;

function boundedError(error) {
  return String(error?.message ?? error ?? "unknown adapter error")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/\bsw_(?:live|test)_[A-Za-z0-9_-]+\b/g, "sw_[redacted]")
    .slice(0, MAX_ERROR_BYTES);
}

function camelState(raw, executor) {
  return {
    ...raw,
    state: raw.state,
    isFinal: Boolean(raw.is_final),
    iteration: raw.iteration ?? 0,
    maxIterations: raw.max_iterations ?? null,
    allowedTools: raw.allowed_tools ?? [],
    disallowedTools: raw.disallowed_tools ?? [],
    allowedCommands: raw.allowed_commands ?? [],
    instructions: raw.instructions ?? null,
    transitions: raw.transitions ?? [],
    model: raw.model ?? null,
    defaultModel: raw.default_model ?? null,
    thinkingLevel: raw.thinking_level ?? null,
    pendingApproval: raw.pending_approval ?? null,
    deliveryRequired: Boolean(
      raw.meta?.workspace?.required
      || raw.meta?.preview?.required
      || raw.meta?.promotion?.required
    ),
    executor,
    additionalContext: [
      `Statewright workflow active. Phase: ${raw.state}.`,
      raw.instructions ? `Instructions: ${raw.instructions}` : null,
      raw.transitions?.length
        ? `Transitions: ${raw.transitions.map((item) => item.event).join(", ")}.`
        : null,
    ].filter(Boolean).join(" "),
  };
}

function adapterResult(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const result = { ...raw };
  if (raw.additional_context != null && result.additionalContext == null) {
    result.additionalContext = raw.additional_context;
  }
  if (
    raw.previous_state
    && raw.state
    && raw.previous_state !== raw.state
    && result.transition == null
  ) {
    result.transition = `${raw.previous_state} => ${raw.state}`;
  }
  return result;
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("adapter request body exceeds 2 MiB");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(request, token) {
  const candidate = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const left = Buffer.from(candidate);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class AdapterBridge {
  constructor(client, options = {}) {
    this.client = client;
    this.sessionOwner = options.sessionOwner ?? null;
    this.requestController = options.requestController ?? null;
    this.nativeReadiness = options.nativeReadiness ?? null;
    this.host = options.host ?? "unknown";
    if (this.requestController && (!this.sessionOwner || this.host !== "pi")) throw new Error("Native request protocol requires an owned Pi bridge");
    if (this.nativeReadiness && (!this.requestController || !this.nativeReadiness.isBoundTo?.(this.sessionOwner, this.requestController))) {
      throw new Error("Native readiness requires the same owned Pi request controller");
    }
    this.telemetry = options.telemetry ?? (async () => {});
    this.executor = {
      active: true,
      id: options.executorId,
      delivery: Boolean(options.deliveryActive),
    };
    this.classifierReworkGate = options.classifierReworkGate ?? new ClassifierReworkGate();
    this.token = options.token ?? randomUUID();
    this.server = null;
    this.url = null;
    this.activeRequests = 0;
    this.lastRequestAt = 0;
    this.terminalStopObserved = false;
    this.adapterReady = false;
    this.adapterIdentity = null;
  }

  async record(event, fields = {}) {
    try {
      await this.telemetry(event, { host: this.host, ...fields });
    } catch (error) {
      process.stderr.write(
        `[statewright] Could not record adapter telemetry: ${error.message}\n`,
      );
    }
  }

  async assertOwnedState() {
    if (!this.sessionOwner) return;
    const live = await this.client.call("statewright_get_state");
    await this.sessionOwner.assertOwner();
    this.sessionOwner.assertGateway(live);
  }

  assertNativeDispatch() {
    if (this.nativeReadiness && !this.nativeReadiness.ready) throw new Error("Native readiness unavailable; continuation denied");
  }

  async start() {
    this.server = createServer(async (request, response) => {
      this.activeRequests += 1;
      this.lastRequestAt = Date.now();
      try {
        if (!authorized(request, this.token)) {
          json(response, 401, { error: "unauthorized" });
          return;
        }
        await this.sessionOwner?.assertOwner();
        const url = new URL(request.url ?? "/", "http://localhost");
        if (request.method === "GET" && url.pathname === "/hooks/state") {
          const state = await this.client.call("statewright_get_state");
          await this.sessionOwner?.assertOwner();
          this.sessionOwner?.assertGateway(state);
          json(response, 200, camelState(state, this.executor));
          return;
        }
        if (request.method !== "POST") {
          json(response, 404, { error: "not found" });
          return;
        }
        const body = await requestBody(request);
        if (url.pathname.startsWith("/hooks/request/")) {
          if (!this.requestController || this.host !== "pi") {
            json(response, 404, { error: "native request protocol unavailable" });
            return;
          }
          const action = url.pathname.slice("/hooks/request/".length);
          let result;
          if (action === "ready" && this.nativeReadiness) result = await this.nativeReadiness.accept(body);
          else {
            if (action !== "cancel") await this.nativeReadiness?.assertReady();
            if (action === "begin") result = await this.requestController.begin(body);
            else if (action === "consume") result = await this.requestController.consume(body);
            else if (action === "cancel") result = await this.requestController.cancel(body);
            else if (action === "status" && Object.keys(body).length === 1 && Object.hasOwn(body, "reference")) {
              result = await this.requestController.status(body.reference);
            } else {
              json(response, 400, { error: "invalid native request action or fields" });
              return;
            }
          }
          await this.sessionOwner?.assertOwner();
          if (action !== "cancel") await this.nativeReadiness?.assertReady();
          if (action !== "cancel") this.assertNativeDispatch();
          json(response, 200, result);
          return;
        }
        if (url.pathname === "/hooks/ready") {
          const pluginName = typeof body.plugin_name === "string" ? body.plugin_name : "";
          const pluginVersion = typeof body.plugin_version === "string" ? body.plugin_version : "";
          if (!pluginName || !pluginVersion) {
            json(response, 400, { error: "plugin_name and plugin_version are required" });
            return;
          }
          if (pluginName !== this.host) {
            json(response, 409, {
              error: `plugin '${pluginName}' cannot attest for executor host '${this.host}'`,
            });
            return;
          }
          this.adapterIdentity = { pluginName, pluginVersion };
          this.adapterReady = !this.nativeReadiness;
          await this.record("executor_adapter_ready", {
            plugin_name: pluginName,
            plugin_version: pluginVersion,
          });
          json(response, 200, { ready: this.adapterReady });
          return;
        }
        if (url.pathname === "/mcp") {
          const method = body.method;
          const id = body.id ?? null;
          if (typeof method !== "string") {
            json(response, 200, {
              jsonrpc: "2.0",
              id,
              error: { code: -32600, message: "Invalid MCP request." },
            });
            return;
          }
          if (method.startsWith("notifications/")) {
            response.writeHead(204);
            response.end();
            return;
          }
          if (!["initialize", "tools/list", "tools/call"].includes(method)) {
            json(response, 200, {
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Unsupported MCP method '${method}'.` },
            });
            return;
          }
          try {
            if (this.sessionOwner && method === "tools/call") {
              if (body.params?.name !== "statewright_get_state") await this.nativeReadiness?.assertReady();
              await this.assertOwnedState();
              if (body.params?.name === "statewright_load_workflow") throw new Error("The executor owns an immutable workflow run; host replacement denied");
              if (this.requestController && body.params?.name !== "statewright_get_state") {
                const status = await this.requestController.status(body.request_reference);
                if (status.phase !== "active") throw new Error("Native request is awaiting approval; tool traffic denied");
              }
            }
            if (method === "tools/call" && body.params?.name !== "statewright_get_state") this.assertNativeDispatch();
            const result = await this.client.request(method, body.params ?? {});
            await this.sessionOwner?.assertOwner();
            if (method === "tools/call") await this.assertOwnedState();
            if (this.requestController && method === "tools/call" && body.params?.name !== "statewright_get_state") {
              await this.sessionOwner.assertRequest(body.request_reference);
              await this.nativeReadiness?.assertReady();
              this.assertNativeDispatch();
            }
            json(response, 200, { jsonrpc: "2.0", id, result });
          } catch (error) {
            json(response, 200, {
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: error.message },
            });
          }
          return;
        }
        if (url.pathname === "/hooks/pre-tool") {
          await this.nativeReadiness?.assertReady();
          await this.assertOwnedState();
          if (this.requestController && (await this.requestController.status(body.request_reference)).phase !== "active") {
            throw new Error("Native request is awaiting approval; tool traffic denied");
          }
          this.assertNativeDispatch();
          let result = adapterResult(await this.client.call("statewright_adapter_pre_tool", {
            tool_name: body.tool_name ?? "",
            tool_input: body.tool_input ?? {},
          }));
          const classifierScope = {
            runId: result?.run_id ?? null,
            state: result?.state ?? null,
            hostSessionId: this.executor.id ?? this.host,
          };
          const riskAssessment = result?.risk_assessment ?? result?.riskAssessment;
          const denied = result?.decision === "deny" || result?.decision === "block";
          const classifierRework = denied
            ? this.classifierReworkGate.observeDenial({ receipt: riskAssessment, scope: classifierScope })
            : (this.classifierReworkGate.observeSuccess({ receipt: riskAssessment, scope: classifierScope }), null);
          if (classifierRework) result = { ...result, classifier_rework: classifierRework };
          await this.sessionOwner?.assertOwner();
          await this.assertOwnedState();
          if (this.requestController) await this.sessionOwner.assertRequest(body.request_reference);
          await this.nativeReadiness?.assertReady();
          await this.record("executor_adapter_pre_tool", {
            tool_name: body.tool_name ?? "",
            policy_tool_name: result?.policy_tool_name ?? null,
            decision: result?.decision ?? null,
            state: result?.state ?? null,
            classifier_rework_attempts: classifierRework?.attempts ?? null,
            classifier_rework_action: classifierRework?.action ?? null,
          });
          this.assertNativeDispatch();
          json(response, 200, result);
          return;
        }
        if (url.pathname === "/hooks/post-tool") {
          await this.nativeReadiness?.assertReady();
          await this.assertOwnedState();
          if (this.requestController && (await this.requestController.status(body.request_reference)).phase !== "active") {
            throw new Error("Native request is awaiting approval; tool traffic denied");
          }
          this.assertNativeDispatch();
          const result = adapterResult(await this.client.call("statewright_adapter_post_tool", {
            tool_name: body.tool_name ?? "",
            tool_input: body.tool_input ?? {},
            tool_response: body.tool_response ?? "",
            is_error: Boolean(body.is_error),
          }));
          await this.sessionOwner?.assertOwner();
          await this.assertOwnedState();
          if (this.requestController) await this.sessionOwner.assertRequest(body.request_reference);
          await this.nativeReadiness?.assertReady();
          await this.record("executor_adapter_post_tool", {
            tool_name: body.tool_name ?? "",
            policy_tool_name: result?.policy_tool_name ?? null,
            state: result?.state ?? null,
            previous_state: result?.previous_state ?? null,
            transition: result?.transition ?? null,
            completed: Boolean(result?.completed),
            is_error: Boolean(body.is_error),
          });
          this.assertNativeDispatch();
          json(response, 200, result);
          return;
        }
        if (url.pathname === "/hooks/stop") {
          await this.nativeReadiness?.assertReady();
          this.assertNativeDispatch();
          const result = adapterResult(await this.client.call("statewright_adapter_stop"));
          await this.nativeReadiness?.assertReady();
          if (result?.decision === "allow") this.terminalStopObserved = true;
          await this.record("executor_adapter_stop", {
            decision: result?.decision ?? null,
            state: result?.state ?? null,
            active: Boolean(result?.active),
          });
          this.assertNativeDispatch();
          json(response, 200, result);
          return;
        }
        json(response, 404, { error: "not found" });
      } catch (error) {
        const message = boundedError(error);
        await this.record("executor_adapter_error", {
          method: request.method ?? null,
          route: new URL(request.url ?? "/", "http://localhost").pathname,
          error: message,
        });
        json(response, 502, { error: message });
      } finally {
        this.activeRequests -= 1;
        this.lastRequestAt = Date.now();
      }
    });
    await new Promise((resolveStart, rejectStart) => {
      this.server.once("error", rejectStart);
      this.server.listen(0, "127.0.0.1", resolveStart);
    });
    const address = this.server.address();
    this.url = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async waitForShutdown(options = {}) {
    const quietMs = options.quietMs ?? 500;
    const timeoutMs = options.timeoutMs ?? 3_000;
    const pollMs = options.pollMs ?? 25;
    const requireTerminalStop = Boolean(options.requireTerminalStop);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const quietSince = Math.max(startedAt, this.lastRequestAt);
      const terminalReady = !requireTerminalStop || this.terminalStopObserved;
      if (
        terminalReady
        && this.activeRequests === 0
        && Date.now() - quietSince >= quietMs
      ) {
        return true;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    }
    return false;
  }

  async waitForReady(options = {}) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 25;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.nativeReadiness) {
        if (this.nativeReadiness.ready) { await this.nativeReadiness.assertReady(); return this.nativeReadiness.ready; }
      } else if (this.adapterReady) return true;
      await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
    }
    return this.nativeReadiness ? false : this.adapterReady;
  }

  async close() {
    try { await this.nativeReadiness?.close(); } finally {
      if (this.server) {
        await new Promise((resolveClose, rejectClose) => {
          this.server.close((error) => error ? rejectClose(error) : resolveClose());
        });
        this.server = null;
      }
    }
  }
}
