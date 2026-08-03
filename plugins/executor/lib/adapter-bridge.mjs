import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

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
    this.host = options.host ?? "unknown";
    this.telemetry = options.telemetry ?? (async () => {});
    this.executor = {
      active: true,
      id: options.executorId,
      delivery: Boolean(options.deliveryActive),
    };
    this.token = options.token ?? randomUUID();
    this.server = null;
    this.url = null;
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

  async start() {
    this.server = createServer(async (request, response) => {
      if (!authorized(request, this.token)) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (request.method === "GET" && url.pathname === "/hooks/state") {
          json(response, 200, camelState(
            await this.client.call("statewright_get_state"),
            this.executor,
          ));
          return;
        }
        if (request.method !== "POST") {
          json(response, 404, { error: "not found" });
          return;
        }
        const body = await requestBody(request);
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
            const result = await this.client.request(method, body.params ?? {});
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
          const result = adapterResult(await this.client.call("statewright_adapter_pre_tool", {
            tool_name: body.tool_name ?? "",
            tool_input: body.tool_input ?? {},
          }));
          await this.record("executor_adapter_pre_tool", {
            tool_name: body.tool_name ?? "",
            policy_tool_name: result?.policy_tool_name ?? null,
            decision: result?.decision ?? null,
            state: result?.state ?? null,
          });
          json(response, 200, result);
          return;
        }
        if (url.pathname === "/hooks/post-tool") {
          const result = adapterResult(await this.client.call("statewright_adapter_post_tool", {
            tool_name: body.tool_name ?? "",
            tool_input: body.tool_input ?? {},
            tool_response: body.tool_response ?? "",
            is_error: Boolean(body.is_error),
          }));
          await this.record("executor_adapter_post_tool", {
            tool_name: body.tool_name ?? "",
            policy_tool_name: result?.policy_tool_name ?? null,
            state: result?.state ?? null,
            previous_state: result?.previous_state ?? null,
            transition: result?.transition ?? null,
            completed: Boolean(result?.completed),
            is_error: Boolean(body.is_error),
          });
          json(response, 200, result);
          return;
        }
        if (url.pathname === "/hooks/stop") {
          const result = adapterResult(await this.client.call("statewright_adapter_stop"));
          await this.record("executor_adapter_stop", {
            decision: result?.decision ?? null,
            state: result?.state ?? null,
            active: Boolean(result?.active),
          });
          json(response, 200, result);
          return;
        }
        json(response, 404, { error: "not found" });
      } catch (error) {
        json(response, 502, { error: error.message });
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

  async close() {
    if (!this.server) return;
    await new Promise((resolveClose, rejectClose) => {
      this.server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    this.server = null;
  }
}
