import { EventEmitter } from "node:events";
import {
  isStateBoundaryItem,
  normalizeCatalog,
  normalizeToolName,
  parseMcpJsonResult,
  resolveFallbackRoute,
  resolveStateRoute,
} from "./model-routing.mjs";
import { StateBudgetLedger } from "./token-budget.mjs";

class NotificationQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
  }

  push(item) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  next() {
    if (this.items.length > 0) return Promise.resolve(this.items.shift());
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function textInput(text) {
  return [{ type: "text", text }];
}

function stateSummary(state) {
  return {
    state: state?.state ?? null,
    is_final: state?.is_final ?? false,
    pending_approval: Boolean(state?.pending_approval?.approval_id),
  };
}

export class StatewrightCodexOrchestrator extends EventEmitter {
  constructor({
    client,
    workflow,
    prompt,
    cwd,
    threadId = null,
    resumeWorkflow = false,
    projectId = null,
    fallbackModel = "luna",
    fallbackEffort = "medium",
    approvalPolicy = "on-request",
    approvalsReviewer = "auto_review",
    sandbox = "workspace-write",
    allowReroute = false,
    maxIdleTurns = 3,
    transportSessionId = null,
    telemetry = async () => {},
    runtimeUsageControlToken = process.env.STATEWRIGHT_USAGE_CONTROL_TOKEN ?? null,
    stdout = process.stdout,
    stderr = process.stderr,
  }) {
    super();
    this.client = client;
    this.workflow = workflow;
    this.prompt = prompt;
    this.cwd = cwd;
    this.requestedThreadId = threadId;
    this.resumeWorkflow = resumeWorkflow;
    this.projectId = projectId;
    this.fallbackModel = fallbackModel;
    this.fallbackEffort = fallbackEffort;
    this.approvalPolicy = approvalPolicy;
    this.approvalsReviewer = approvalsReviewer;
    this.sandbox = sandbox;
    this.allowReroute = allowReroute;
    this.maxIdleTurns = maxIdleTurns;
    this.transportSessionId = transportSessionId;
    this.telemetry = telemetry;
    this.runtimeUsageControlToken = runtimeUsageControlToken;
    this.runtimeUsageSequence = 0;
    this.stdout = stdout;
    this.stderr = stderr;
    this.queue = new NotificationQueue();
    this.thread = null;
    this.serverName = null;
    this.catalog = [];
    this.route = null;
    this.lastState = null;
    this.budgetLedger = new StateBudgetLedger();
  }

  async run() {
    this.client.on("notification", (message) => this.queue.push(message));
    this.client.on("request", (message) => void this.handleServerRequest(message));
    await this.client.start();
    await this.client.request("initialize", {
      clientInfo: { name: "statewright-codex", title: "Statewright Codex Adapter", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.client.notify("initialized");

    this.catalog = normalizeCatalog(await this.listModels());
    this.route = resolveFallbackRoute(
      this.catalog,
      this.fallbackModel,
      this.fallbackEffort,
    );
    this.thread = await this.openThread();
    await this.telemetry("session_started", {
      thread_id: this.thread.id,
      session_id: this.thread.sessionId ?? null,
      mcp_session_id: this.transportSessionId,
      workflow: this.workflow,
      approval_policy: this.approvalPolicy,
      approvals_reviewer: this.approvalsReviewer,
      sandbox: this.sandbox,
    });
    this.stderr.write(`[statewright] thread ${this.thread.id}\n`);

    this.serverName = await this.findStatewrightServer();
    const bootstrap = await this.runTurn({
      prompt: this.bootstrapPrompt(),
      route: this.route,
      purpose: "bootstrap",
      suppressOutput: true,
    });
    if (!["statewright_load_workflow", "statewright_start"].includes(bootstrap.boundaryTool)) {
      throw new Error(
        "The bootstrap turn ended without loading the Statewright workflow. No task work was started.",
      );
    }

    let state = await this.getState();
    this.lastState = state;
    await this.observeStateBudget(state);
    let gate = await this.stopAtGate(state);
    if (gate) return gate;
    this.route = await this.selectRoute(state);

    let nextPrompt = this.prompt;
    let idleTurns = 0;
    while (true) {
      this.reportRoute(state, this.route);
      const result = await this.runTurn({
        prompt: nextPrompt,
        route: this.route,
        purpose: idleTurns === 0 ? "workflow" : "continuation",
      });
      state = await this.getState();
      gate = await this.stopAtGate(state);
      if (gate) return gate;

      const previousState = this.lastState?.state ?? null;
      this.lastState = state;
      await this.observeStateBudget(state);
      this.route = await this.selectRoute(state);

      if (result.boundaryTool) {
        idleTurns = 0;
        nextPrompt =
          `Statewright entered '${state.state}'. Continue autonomously from the new state. ` +
          "Re-read statewright_get_state before acting, follow its instructions, and do not repeat completed work.";
      } else {
        idleTurns += 1;
        if (idleTurns > this.maxIdleTurns) {
          throw new Error(
            `Codex completed ${idleTurns} turns in Statewright state '${state.state}' without a transition.`,
          );
        }
        nextPrompt =
          `You stopped without transitioning from Statewright state '${state.state}'. ` +
          "Continue the state now and emit an allowed transition when its exit criteria are satisfied.";
      }

      await this.telemetry("state_observed", {
        thread_id: this.thread.id,
        previous_state: previousState,
        ...stateSummary(state),
      });
    }
  }

  async listModels() {
    const all = [];
    let cursor = null;
    do {
      const response = await this.client.request("model/list", {
        cursor,
        includeHidden: true,
        limit: 100,
      });
      all.push(...(response.data ?? []));
      cursor = response.nextCursor ?? null;
    } while (cursor);
    return all;
  }

  async openThread() {
    const common = {
      cwd: this.cwd,
      model: this.route.model,
      approvalPolicy: this.approvalPolicy,
      approvalsReviewer: this.approvalsReviewer,
      sandbox: this.sandbox,
    };
    const response = this.requestedThreadId
      ? await this.client.request("thread/resume", {
          ...common,
          threadId: this.requestedThreadId,
        })
      : await this.client.request("thread/start", common);
    return response.thread;
  }

  async findStatewrightServer() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let cursor = null;
      do {
        const response = await this.client.request("mcpServerStatus/list", {
          threadId: this.thread.id,
          cursor,
          limit: 100,
          detail: "full",
        });
        for (const server of response.data ?? []) {
          const tools = Object.keys(server.tools ?? {});
          if (tools.some((tool) => tool.endsWith("statewright_get_state"))) return server.name;
        }
        cursor = response.nextCursor ?? null;
      } while (cursor);
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      "No Statewright MCP server is attached to the app-server thread. Install or configure the Statewright Codex plugin first.",
    );
  }

  bootstrapPrompt() {
    const args = { name: this.workflow };
    if (this.projectId) args.project_id = this.projectId;
    else args.session_id = this.thread.id;
    if (this.resumeWorkflow) args.resume = true;
    return (
      `Call statewright_load_workflow exactly once with these JSON arguments: ${JSON.stringify(args)}. ` +
      "Do not inspect the repository or begin the user's task. Stop immediately after the tool succeeds."
    );
  }

  async getState() {
    const result = await this.client.request("mcpServer/tool/call", {
      threadId: this.thread.id,
      server: this.serverName,
      tool: "statewright_get_state",
      arguments: {},
    });
    return parseMcpJsonResult(result);
  }

  async getUsage() {
    const result = await this.client.request("mcpServer/tool/call", {
      threadId: this.thread.id,
      server: this.serverName,
      tool: "statewright_get_usage",
      arguments: {},
    });
    return parseMcpJsonResult(result);
  }

  async selectRoute(state) {
    const route = resolveStateRoute(state, this.catalog, this.route);
    await this.telemetry("route_selected", {
      thread_id: this.thread.id,
      state: state.state ?? null,
      requested_model: route.requestedModel,
      selected_model: route.model,
      requested_effort: route.requestedEffort,
      selected_effort: route.effort,
      source: route.source,
    });
    return route;
  }

  reportRoute(state, route) {
    this.stderr.write(
      `[statewright] state=${state.state} model=${route.model} effort=${route.effort ?? "default"}\n`,
    );
  }

  async stopAtGate(state) {
    if (state?.is_final) {
      await this.telemetry("workflow_completed", {
        thread_id: this.thread.id,
        workflow: this.workflow,
        state: state.state ?? null,
      });
      this.stderr.write(`[statewright] workflow complete in '${state.state}'\n`);
      return { status: "complete", threadId: this.thread.id, state };
    }
    if (state?.pending_approval?.approval_id) {
      await this.telemetry("approval_gate", {
        thread_id: this.thread.id,
        workflow: this.workflow,
        state: state.state ?? null,
        approval_id: state.pending_approval.approval_id,
      });
      this.stderr.write(
        `[statewright] approval required in '${state.state}': ` +
          `${state.pending_approval.message ?? state.pending_approval.approval_id}\n`,
      );
      return { status: "approval_required", threadId: this.thread.id, state };
    }
    return null;
  }

  async observeStateBudget(state) {
    if (this.budgetLedger.state === (state?.state ?? null)) return;
    const snapshot = this.budgetLedger.enterState(state);
    await this.telemetry("state_budget_started", {
      thread_id: this.thread.id,
      state: state?.state ?? null,
      state_budget: snapshot,
    });
    try {
      const stateUsage = await this.getUsage();
      await this.telemetry("gateway_usage_snapshot", {
        thread_id: this.thread.id,
        workflow: this.workflow,
        state: state?.state ?? null,
        state_usage: Array.isArray(stateUsage) ? stateUsage : [],
      });
    } catch (error) {
      await this.telemetry("gateway_usage_snapshot_failed", {
        thread_id: this.thread.id,
        state: state?.state ?? null,
        error: String(error?.message ?? error).slice(0, 240),
      });
    }
  }

  async reportRuntimeUsage(kind, report) {
    if (!this.runtimeUsageControlToken || !this.thread || !this.serverName) return;
    try {
      await this.client.request("mcpServer/tool/call", {
        threadId: this.thread.id,
        server: this.serverName,
        tool: "statewright_report_runtime_usage",
        arguments: {
          control_token: this.runtimeUsageControlToken,
          kind,
          report: { sequence: ++this.runtimeUsageSequence, ...report },
        },
      });
    } catch (error) {
      await this.telemetry("runtime_usage_report_failed", {
        thread_id: this.thread.id,
        state: this.lastState?.state ?? null,
        kind,
        error: String(error?.message ?? error).slice(0, 240),
      });
    }
  }

  async emitBudgetThresholds(turnId, state) {
    for (const [threshold, event] of [[90, "context_budget_warning"], [100, "context_budget_exceeded"]]) {
      if (!this.budgetLedger.thresholdCrossed(state, threshold)) continue;
      await this.telemetry(event, {
        thread_id: this.thread.id,
        turn_id: turnId,
        state: state?.state ?? null,
        state_budget: this.budgetLedger.snapshot(state),
      });
    }
  }

  async runTurn({ prompt, route, purpose, suppressOutput = false }) {
    const response = await this.client.request("turn/start", {
      threadId: this.thread.id,
      input: textInput(prompt),
      model: route.model,
      effort: route.effort,
    });
    const turnId = response.turn.id;
    await this.telemetry("turn_started", {
      thread_id: this.thread.id,
      turn_id: turnId,
      state: this.lastState?.state ?? null,
      purpose,
      model: route.model,
      effort: route.effort,
    });

    let boundaryTool = null;
    let interrupted = false;
    while (true) {
      const message = await this.queue.next();
      const params = message.params ?? {};
      if (params.threadId && params.threadId !== this.thread.id) continue;
      if (params.turnId && params.turnId !== turnId) continue;

      if (message.method === "item/agentMessage/delta" && !suppressOutput) {
        this.stdout.write(params.delta ?? "");
      } else if (message.method === "model/rerouted") {
        await this.telemetry("model_rerouted", {
          thread_id: this.thread.id,
          turn_id: turnId,
          state: this.lastState?.state ?? null,
          from_model: params.fromModel,
          to_model: params.toModel,
          reason: params.reason,
        });
        if (!this.allowReroute) {
          await this.interruptTurn(turnId);
          throw new Error(
            `Codex rerouted '${params.fromModel}' to '${params.toModel}'. ` +
              "The adapter is fail-closed; pass --allow-reroute to accept provider reroutes.",
          );
        }
      } else if (message.method === "thread/tokenUsage/updated") {
        const observed = this.budgetLedger.observeTokenUsage(
          turnId,
          params.tokenUsage,
          this.lastState,
        );
        await this.telemetry("token_usage", {
          thread_id: this.thread.id,
          turn_id: turnId,
          state: this.lastState?.state ?? null,
          provider: "codex",
          model: route.model ?? null,
          effort: route.effort ?? null,
          precision: observed.available ? "exact" : "unavailable",
          token_usage: observed.usage,
          token_usage_delta: observed.delta,
          state_budget: observed.ledger,
        });
        if (observed.available && observed.ledger.state) {
          await this.reportRuntimeUsage("usage", {
            state: observed.ledger.state,
            state_epoch: observed.ledger.state_epoch,
            provider: "codex",
            model: route.model ?? null,
            effort: route.effort ?? null,
            precision: "exact",
            token_usage: observed.ledger.token_usage,
          });
        }
      } else if (message.method === "item/completed") {
        const observed = this.budgetLedger.observeToolItem(params.item, this.lastState);
        await this.telemetry("tool_output_observed", {
          thread_id: this.thread.id,
          turn_id: turnId,
          state: this.lastState?.state ?? null,
          tool: observed.tool,
          state_budget: observed.ledger,
        });
        const isGatewayTool = params.item?.server === this.serverName;
        const isTool = /tool/i.test(String(params.item?.type ?? ""));
        if (isTool && !isGatewayTool && observed.ledger.state) {
          await this.reportRuntimeUsage("tool", {
            state: observed.ledger.state,
            state_epoch: observed.ledger.state_epoch,
            invocation_id: params.item?.id ?? `${turnId}:${this.runtimeUsageSequence + 1}`,
            tool: observed.tool.tool,
            tool_type: observed.tool.type,
            source: "codex_adapter",
            result_bytes: observed.tool.result_bytes,
            estimated_input_tokens: observed.tool.estimated_input_tokens,
            is_error: params.item?.status === "failed",
          });
        }
        await this.emitBudgetThresholds(turnId, this.lastState);
        if (!isStateBoundaryItem(params.item, this.serverName)) continue;
        boundaryTool = normalizeToolName(params.item.tool);
        await this.telemetry("state_boundary", {
          thread_id: this.thread.id,
          turn_id: turnId,
          state: this.lastState?.state ?? null,
          tool: boundaryTool,
        });
        if (!interrupted) {
          interrupted = true;
          await this.interruptTurn(turnId);
        }
      } else if (message.method === "turn/completed") {
        if (!suppressOutput) this.stdout.write("\n");
        await this.telemetry("turn_completed", {
          thread_id: this.thread.id,
          turn_id: turnId,
          state: this.lastState?.state ?? null,
          status: params.turn?.status ?? null,
          duration_ms: params.turn?.durationMs ?? null,
          boundary_tool: boundaryTool,
        });
        if (params.turn?.status === "failed") {
          throw new Error(
            `Codex turn ${turnId} failed: ${params.turn.error?.message ?? "unknown error"}`,
          );
        }
        return { boundaryTool, status: params.turn?.status ?? null };
      }
    }
  }

  async interruptTurn(turnId) {
    try {
      await this.client.request("turn/interrupt", {
        threadId: this.thread.id,
        turnId,
      });
    } catch (error) {
      this.stderr.write(`[statewright] turn interrupt raced completion: ${error.message}\n`);
    }
  }

  async handleServerRequest(message) {
    const method = message.method;
    this.stderr.write(`[statewright] app-server request '${method}' reached the adapter\n`);
    if (method === "item/commandExecution/requestApproval") {
      this.client.respond(message.id, { decision: "decline" });
    } else if (method === "item/fileChange/requestApproval") {
      this.client.respond(message.id, { decision: "decline" });
    } else if (method === "execCommandApproval" || method === "applyPatchApproval") {
      this.client.respond(message.id, { decision: "denied" });
    } else if (method === "item/tool/requestUserInput") {
      this.client.respond(message.id, { answers: {} });
    } else if (method === "mcpServer/elicitation/request") {
      this.client.respond(message.id, { action: "decline" });
    } else {
      this.client.respondError(message.id, -32601, `Unsupported adapter request: ${method}`);
    }
  }
}
