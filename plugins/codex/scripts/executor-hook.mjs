#!/usr/bin/env node

const TIMEOUT_MS = 5_000;

function stateContext(state) {
  const executionPreference = "Execution preference: use one bounded native operation at a time; avoid heredocs, inline interpreters, and compound blobs unless structurally necessary and authorized.";
  if (state.isFinal) {
    return `[statewright] Workflow complete. Final state: ${state.state}.`;
  }
  if (state.additionalContext) return `${state.additionalContext} ${executionPreference}`;
  const parts = [`[statewright] Workflow active. Phase: ${state.state}.`];
  parts.push(executionPreference);
  if (state.instructions) parts.push(`Instructions: ${state.instructions}`);
  if (state.transitions?.length) {
    parts.push(`Transitions: ${state.transitions.map((item) => item.event).join(", ")}.`);
  }
  return parts.join(" ");
}

function deliveryOwned(state) {
  return Boolean(state.executor?.active && state.executor?.delivery);
}

function toolResponse(input) {
  if (typeof input.tool_response === "string") return input.tool_response;
  if (typeof input.tool_result === "string") return input.tool_result;
  return JSON.stringify(input.tool_response ?? input.tool_result ?? "");
}

function isStatewrightTool(toolName) {
  return /(?:^|[_:/.-])statewright_(?:[a-z0-9_]+)$/i.test(toolName);
}

export function formatGuardDenial(result) {
  const risk = result?.risk_assessment ?? result?.riskAssessment;
  if (!risk || typeof risk !== "object") {
    return {
      display: result?.reason ?? "Blocked by Statewright.",
      machine: result?.reason ?? "Blocked by Statewright.",
    };
  }

  const basis = String(risk.final_denial_basis ?? risk.resolution_basis ?? "unknown");
  const required = String(risk.required_authority ?? "approved execution path");
  const delegationDenied = risk.deterministic_source === "unmanaged_agent_delegation";
  const delegation = result?.delegation;
  let display;
  if (delegationDenied) {
    const managedEvents = Array.isArray(delegation?.managed_transition_candidates)
      ? delegation.managed_transition_candidates
        .map(item => item?.event && `${item.event} (${item.kind ?? "managed"})`).filter(Boolean).join(", ")
      : "";
    if (delegation?.recommendation === "statewright_managed_fork") {
      display = managedEvents
        ? `Statewright guard: denied · this delegated task requests a different model or reasoning route. Candidate workflow-managed child transitions: ${managedEvents}. Use one only when its declared child route matches the request; the child remains attached to the parent workflow evidence.`
        : "Statewright guard: denied · this delegated task requests a different model or reasoning route, but the current state declares no managed fork or subworkflow transition. Continue inline or transition to a state that declares one.";
    } else {
      display = "Statewright guard: denied · continue inline by default so evidence stays attached to the current workflow. A raw delegated agent would receive a separate, unbounded tool surface.";
    }
  } else if ([
    "semantic_threshold_not_met",
    "incomplete_structural_evidence",
    "semantic_vector_unavailable",
    "semantic_assessment_incomplete",
  ].includes(basis)) {
    display = "Statewright guard: denied · command intent is not yet proven. Next: prefer one bounded native operation instead of a heredoc or inline interpreter; use the approved execution path when code must run.";
  } else if (basis === "deterministic_nonlocal_risk") {
    display = "Statewright guard: denied · known non-local effect. Next: use the approved execution path.";
  } else if (basis.startsWith("workflow_capability_")) {
    display = `Statewright guard: denied · this phase does not allow the resolved effect. Next: transition to a phase that grants ${required}.`;
  } else if (basis.startsWith("classifier_policy_")) {
    display = `Statewright guard: denied · this workflow risk band is too narrow. Next: use a workflow state with ${required}.`;
  } else {
    display = `Statewright guard: denied · classifier policy requires ${required}.`;
  }
  const vector = risk.semantic_vector;
  if (risk.semantic_status === "Assessed" && vector && typeof vector === "object") {
    const percent = value => `${Math.round((Number.isFinite(value) ? value : 0) * 100)}%`;
    display += ` System One signals: read-only ${percent(vector.read_only)}, write ${percent(vector.may_write)}, destructive ${percent(vector.destructive)}, external ${percent(vector.external_or_account_effect)}.`;
  }
  const rework = result?.classifier_rework ?? result?.classifierRework;
  if (!delegationDenied && rework?.action === "rework") {
    display += ` Rework attempt ${rework.attempts}/${rework.max_reworks}; after this budget, the same classified intent must be sent for human approval.`;
  } else if (!delegationDenied && rework?.action === "approval_required") {
    display += " Rework budget exhausted; this exact classified intent now requires native human approval.";
  }
  return {
    display,
    machine: JSON.stringify({
      classifier_receipt: redactClassifierReceipt(risk),
      ...(delegation ? { managed_delegation: redactClassifierReceipt(delegation) } : {}),
      ...(rework ? { classifier_rework: redactClassifierReceipt(rework) } : {}),
    }),
  };
}

function redactClassifierReceipt(value) {
  if (Array.isArray(value)) return value.map(redactClassifierReceipt);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["command", "raw_command", "tool_input", "input", "arguments"].includes(key))
      .map(([key, nested]) => [key, redactClassifierReceipt(nested)]),
  );
}

export async function adapterCall(endpoint, body, options = {}) {
  const adapterUrl = options.adapterUrl ?? process.env.STATEWRIGHT_ADAPTER_URL;
  const adapterToken = options.adapterToken ?? process.env.STATEWRIGHT_ADAPTER_TOKEN;
  if (!adapterUrl) throw new Error("Statewright executor bridge is not configured");
  const response = await (options.fetch ?? fetch)(
    `${adapterUrl.replace(/\/$/, "")}/hooks/${endpoint}`,
    {
      method: body == null ? "GET" : "POST",
      headers: {
        ...(body == null ? {} : { "Content-Type": "application/json" }),
        Authorization: `Bearer ${adapterToken ?? ""}`,
      },
      ...(body == null ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  const responseText = await response.text();
  let payload = null;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const detail = typeof payload?.error === "string"
      ? `: ${payload.error.slice(0, 512)}`
      : "";
    throw new Error(
      `Statewright executor bridge ${endpoint} failed with HTTP ${response.status}${detail}`,
    );
  }
  if (!payload) {
    throw new Error(`Statewright executor bridge ${endpoint} returned invalid JSON`);
  }
  return payload;
}

export async function handleExecutorHook(endpoint, input, options = {}) {
  try {
    if (endpoint === "user-prompt") {
      const state = await adapterCall("state", null, options);
      if (state.deliveryRequired && !deliveryOwned(state)) {
        return {
          decision: "block",
          reason: "This workflow requires isolated delivery, but the Statewright executor does not own it.",
        };
      }
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: stateContext(state),
        },
      };
    }

    if (endpoint === "pre-tool") {
      if (isStatewrightTool(input.tool_name ?? "")) return null;
      const result = await adapterCall("pre-tool", {
        tool_name: input.tool_name ?? "",
        tool_input: input.tool_input ?? {},
      }, options);
      if (result.decision === "deny" || result.decision === "block") {
        const denial = formatGuardDenial(result);
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: denial.display,
            additionalContext: `[statewright] Machine classifier receipt: ${denial.machine}`,
          },
        };
      }
      const additionalContext = result.additional_context ?? result.additionalContext;
      return additionalContext
        ? { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext } }
        : null;
    }

    if (endpoint === "post-tool") {
      const toolName = input.tool_name ?? "";
      if (isStatewrightTool(toolName)) {
        const state = await adapterCall("state", null, options);
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: stateContext(state),
          },
        };
      }
      const result = await adapterCall("post-tool", {
        tool_name: toolName,
        tool_input: input.tool_input ?? {},
        tool_response: toolResponse(input),
        is_error: Boolean(input.is_error),
      }, options);
      let additionalContext = result.additional_context ?? result.additionalContext;
      if (result.interrupt?.to) {
        additionalContext = `[statewright] Validation interrupt entered: ${result.interrupt.to}. Continue under the new Statewright phase.`;
      } else if (result.completed) {
        additionalContext = "[statewright] Workflow complete.";
      }
      return additionalContext
        ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }
        : null;
    }

    if (endpoint === "stop") {
      const result = await adapterCall("stop", {}, options);
      if (result.decision === "deny" || result.decision === "block") {
        return {
          decision: "block",
          reason: result.reason ?? "Continue the active Statewright workflow.",
        };
      }
      return null;
    }

    throw new Error(`Unknown Statewright hook endpoint '${endpoint}'.`);
  } catch (error) {
    const reason = `Statewright executor bridge unavailable: ${error.message}`;
    if (endpoint === "pre-tool") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    }
    if (endpoint === "post-tool") {
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `${reason}. Stop before issuing another tool call.`,
        },
      };
    }
    return { decision: "block", reason };
  }
}

async function main() {
  const endpoint = process.argv[2] ?? "user-prompt";
  let inputText = "";
  for await (const chunk of process.stdin) inputText += chunk.toString();
  const input = inputText.trim() ? JSON.parse(inputText) : {};
  const output = await handleExecutorHook(endpoint, input);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`[statewright] executor hook error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
