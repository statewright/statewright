// Agent guidance only: no tool remapping, workflow activation or permission change.
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolveWindowsLaunch} from "./windows-command-resolution.mjs";

export async function warnCodexCompatibility(command, {environment = process.env, output = process.stderr,
  probe = promisify(execFile)} = {}) {
  try {
    const launch = await resolveWindowsLaunch(command);
    const {stdout} = await probe(launch.command, [...launch.prefixArgs, "--version"], {
      env: environment, encoding: "utf8", timeout: 2000, maxBuffer: 8192, windowsHide: true, shell: launch.shell,
    });
    const warning = codexCompatibilityNotice(String(stdout).trim().replace(/^codex-cli\s+/, "codex/"));
    if (warning) output.write(`[statewright] ${warning}\n`);
  } catch { /* A version notice must never prevent the native client starting. */ }
}

export function codexCompatibilityNotice(userAgent) {
  if (typeof userAgent !== "string" || userAgent.length > 1024) return null;
  const match = userAgent.match(/(?:^|\s)codex[a-z_-]*\/(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?(?:\s|$)/i);
  if (!match) return null;
  const [major, minor] = match.slice(1).map(Number);
  if (major > 0 || minor >= 167) return null;
  return `Statewright may not work properly with Codex ${match.slice(1).join(".")}. Update Codex to 0.167.0 or newer, and keep it up to date.`;
}

export const NATIVE_STATEWRIGHT_GUIDANCE = "Statewright connector selection for terminal and Desktop: use only the advertised local/native MCP server named statewright for this conversation (mcp__statewright__statewright_* or mcp__plugin_statewright_statewright__statewright_*; the UI may display statewright.statewright_*). Do not use codex_apps.statewright_ai.*, mcp__codex_apps__statewright_*, or the web/marketplace Statewright connector here, even for workflow listing or status. The web connector is a separate session, not a fallback for native workflow state, model routing, permissions or approvals. If the local tool is absent, fails, or requires login, report that exact local failure and park dependent workflow actions; use only supported local discovery/recovery. Never substitute the web connector, infer live state from saved files, or run MCP tool names as shell commands. This guidance does not activate a workflow or authorize login, retry, approval or policy bypass.";

export function nativeWorkflowEntryPrompt(state) {
  return `Statewright entered '${state}'. ${NATIVE_STATEWRIGHT_GUIDANCE} Call the advertised local statewright_get_state tool first, then follow the current phase's tools and transitions.`;
}

// Only a release already verified by CodexApprovalGate may call this formatter.
// This reports a decision; it does not authorize another invocation or workflow.
export function nativeApprovalResultPrompt({approvalId, state, fromState}) {
  if (![approvalId, state?.run_id, state?.run_session_id, fromState, state?.state]
      .every(value => typeof value === "string" && value.length > 0) || state.pending_approval) {
    throw new Error("Approval continuation has no verified applied decision identity");
  }
  const outcome = {type:"statewright_approval_result", approval_id:approvalId,
    run_id:state.run_id, run_session_id:state.run_session_id, status:"approved",
    applied:true, pending:false, from_state:fromState, to_state:state.state};
  return `Verified Statewright human-review result: ${JSON.stringify(outcome)}\n` +
    "This exact human review was approved and applied; it is no longer pending, including when the transition returns to the same state. " +
    "Do not infer an unresolved approval from earlier conversation. Approval does not complete the task or expand its authorized scope. " +
    nativeWorkflowEntryPrompt(state.state);
}
