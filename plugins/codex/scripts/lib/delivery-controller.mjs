import { appendFile, chmod, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, resolve } from "node:path";
import {
  hookEnvironment,
  runHookProcess,
} from "./hook-process.mjs";

function workflowPolicy(state) {
  return {
    workspace: state?.meta?.workspace ?? null,
    preview: state?.meta?.preview ?? null,
    promotion: state?.meta?.promotion ?? null,
    failureStates: new Set(state?.meta?.failure_states ?? ["blocked"]),
  };
}

function requireVersionOne(value, field) {
  if (!value || value.version !== 1) {
    throw new Error(`workflow ${field} policy version must be 1.`);
  }
}

function validateWorkflowPolicy(policy, session) {
  requireVersionOne(policy.workspace, "workspace");
  if (policy.workspace.mode !== "git_worktree") {
    throw new Error("workflow workspace.mode must be 'git_worktree'.");
  }
  requireVersionOne(policy.preview, "preview");
  if (policy.preview.mode !== "taskfile") {
    throw new Error("workflow preview.mode must be 'taskfile'.");
  }
  for (const field of ["prepare_state", "deploy_state", "validate_state"]) {
    if (typeof policy.preview[field] !== "string" || !policy.preview[field]) {
      throw new Error(`workflow preview.${field} is required.`);
    }
  }
  if (policy.promotion) {
    requireVersionOne(policy.promotion, "promotion");
    if (!["manual", "squash"].includes(policy.promotion.mode)) {
      throw new Error("workflow promotion.mode must be 'manual' or 'squash'.");
    }
    if (policy.promotion.mode !== session.config.promotion.mode) {
      throw new Error(
        `workflow promotion mode '${policy.promotion.mode}' does not match delivery config `
        + `'${session.config.promotion.mode}'.`,
      );
    }
    if (
      typeof policy.promotion.promote_state !== "string"
      || !policy.promotion.promote_state
    ) {
      throw new Error("workflow promotion.promote_state is required.");
    }
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await import("node:fs/promises").then(({ rename }) => rename(temporary, path));
}

export class DeliveryController {
  constructor(session, options = {}) {
    this.session = session;
    this.telemetry = options.telemetry ?? (async () => {});
    this.stderr = options.stderr ?? process.stderr;
    this.policy = null;
    this.actionPath = resolve(session.manifest.evidence_path, "delivery-actions.json");
    this.actionLogPath = resolve(session.manifest.evidence_path, "delivery-actions.jsonl");
    this.actions = {};
    this.successfulFinal = false;
  }

  async initialize() {
    const exists = await stat(this.actionPath).catch(() => null);
    if (exists) this.actions = JSON.parse(await readFile(this.actionPath, "utf8"));
    return this;
  }

  async observeState(state) {
    if (!this.policy) {
      this.policy = workflowPolicy(state);
      validateWorkflowPolicy(this.policy, this.session);
      await this.telemetry("delivery_policy_validated", {
        run_id: this.session.manifest.run_id,
        manifest_digest: this.session.manifest.manifest_digest,
        workspace_mode: this.policy.workspace.mode,
        preview_mode: this.policy.preview.mode,
        promotion_mode: this.policy.promotion?.mode ?? "none",
      });
    }

    const actions = [];
    if (state?.state === this.policy.preview.prepare_state) actions.push("prepare");
    if (state?.state === this.policy.preview.deploy_state) actions.push("deploy");
    if (state?.state === this.policy.preview.validate_state) actions.push("validate");
    if (state?.state === this.policy.promotion?.promote_state) actions.push("promote");
    if (actions.includes("prepare") || actions.includes("deploy")) {
      await this.session.checkpoint();
    }
    for (const action of [...new Set(actions)]) await this.runAction(action, state.state);

    if (state?.is_final && !this.policy.failureStates.has(state.state)) {
      this.successfulFinal = true;
    }
  }

  async runAction(action, state) {
    const fingerprint = action === "prepare" ? "run" : await this.session.fingerprint();
    const key = `${action}:${fingerprint}`;
    if (this.actions[key]?.status === "complete") return this.actions[key].result;
    if (action === "validate" && this.actions[`deploy:${fingerprint}`]?.status !== "complete") {
      throw new Error(
        `refusing preview validation without a matching deploy for fingerprint ${fingerprint}.`,
      );
    }
    if (action === "promote" && this.actions[`validate:${fingerprint}`]?.status !== "complete") {
      throw new Error(
        `refusing promotion without matching preview validation for fingerprint ${fingerprint}.`,
      );
    }
    const startedAt = new Date().toISOString();
    this.actions[key] = { status: "running", state, fingerprint, started_at: startedAt };
    await writeJsonAtomic(this.actionPath, this.actions);

    let promotionLockHeld = false;
    let promotionExecutionToken = null;
    let renewalTimer = null;
    let renewalChain = Promise.resolve();
    let renewalError = null;
    try {
      let result;
      if (action === "promote") {
        promotionExecutionToken = randomUUID();
        await this.invokeHook("lock", fingerprint, {
          promotionExecutionToken,
          timeoutMs: 60_000,
        });
        promotionLockHeld = true;
        renewalTimer = setInterval(() => {
          renewalChain = renewalChain
            .then(() =>
              this.invokeHook("renew", fingerprint, {
                promotionExecutionToken,
                timeoutMs: 60_000,
              }))
            .catch((error) => {
              renewalError ??= error;
            });
        }, 60_000);
        await this.invokeHook("preflight-promote", fingerprint, {
          promotionExecutionToken,
          timeoutMs: 120_000,
        });
        await this.session.promote();
        if (renewalError) throw renewalError;
        result = await this.invokeHook(action, fingerprint, { promotionExecutionToken });
        clearInterval(renewalTimer);
        renewalTimer = null;
        await renewalChain;
        if (renewalError) throw renewalError;
        await this.invokeHook("unlock", fingerprint, {
          promotionExecutionToken,
          timeoutMs: 60_000,
        });
        promotionLockHeld = false;
      } else {
        result = await this.invokeHook(action, fingerprint);
      }
      const completed = {
        status: "complete",
        state,
        fingerprint,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        result,
      };
      this.actions[key] = completed;
      await writeJsonAtomic(this.actionPath, this.actions);
      await appendFile(
        this.actionLogPath,
        `${JSON.stringify({ action, ...completed })}\n`,
        { mode: 0o600 },
      );
      await this.telemetry("delivery_action_completed", {
        run_id: this.session.manifest.run_id,
        action,
        state,
        fingerprint,
      });
      this.stderr.write(`[statewright] delivery ${action} complete\n`);
      return result;
    } catch (error) {
      if (renewalTimer) clearInterval(renewalTimer);
      await renewalChain;
      let finalError = error;
      if (promotionLockHeld) {
        try {
          await this.invokeHook("unlock", fingerprint, {
            promotionExecutionToken,
            timeoutMs: 60_000,
          });
          promotionLockHeld = false;
        } catch (unlockError) {
          finalError = new AggregateError(
            [error, unlockError],
            `delivery '${action}' failed and its promotion lock could not be released`,
          );
        }
      }
      const failed = {
        status: "failed",
        state,
        fingerprint,
        started_at: startedAt,
        failed_at: new Date().toISOString(),
        error: String(finalError?.message ?? finalError).slice(0, 1000),
      };
      this.actions[key] = failed;
      await writeJsonAtomic(this.actionPath, this.actions);
      await appendFile(
        this.actionLogPath,
        `${JSON.stringify({ action, ...failed })}\n`,
        { mode: 0o600 },
      );
      throw finalError;
    }
  }

  async invokeHook(action, fingerprint, options = {}) {
    const task = this.session.config.hooks.actions[action];
    if (!task) throw new Error(`no Taskfile hook is configured for '${action}'.`);
    const adapter = this.session.adapterPath();
    const args = [action, "--manifest", this.session.manifestPath];
    const command = [".js", ".mjs", ".cjs"].includes(extname(adapter))
      ? process.execPath
      : adapter;
    const commandArgs = command === process.execPath ? [adapter, ...args] : args;
    const { stdout } = await runHookProcess(command, commandArgs, {
      cwd: this.session.primaryCwd,
      env: hookEnvironment(this.session, {
        STATEWRIGHT_DELIVERY_ACTION: action,
        STATEWRIGHT_DELIVERY_FINGERPRINT: fingerprint,
        STATEWRIGHT_DELIVERY_TASK: task,
        ...(options.promotionExecutionToken
          ? { STATEWRIGHT_DELIVERY_EXECUTION_TOKEN: options.promotionExecutionToken }
          : {}),
      }),
      timeoutMs:
        options.timeoutMs ?? this.session.config.hooks.actionTimeoutMs,
    });
    const text = stdout.trim();
    if (!text) return { ok: true };
    try {
      return JSON.parse(text.split("\n").at(-1));
    } catch {
      throw new Error(`Taskfile delivery adapter returned non-JSON output for '${action}'.`);
    }
  }

  async finalizeAfterClientClose() {
    if (!this.successfulFinal) return;
    if (!this.policy?.promotion?.teardown_on_final) return;
    if (!this.completedAction("promote")) {
      throw new Error("refusing final cleanup because promotion did not complete.");
    }
    await this.session.preflightCleanup();
    await this.runAction("teardown", "finalize");
    if (this.policy.workspace.cleanup === "after_promoted") {
      await this.session.cleanup();
    }
  }

  completedAction(action) {
    return Object.entries(this.actions).some(
      ([key, value]) => key.startsWith(`${action}:`) && value.status === "complete",
    );
  }
}

export { validateWorkflowPolicy, workflowPolicy };
