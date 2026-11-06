import { randomUUID } from "node:crypto";

function reviewerLabel(reviewer) {
  const name = typeof reviewer?.display_name === "string" ? reviewer.display_name.trim() : "";
  const email = typeof reviewer?.email === "string" ? reviewer.email.trim() : "";
  const id = typeof reviewer?.user_id === "string" ? reviewer.user_id.trim() : "";
  const identity = name ? `${name}${email ? ` <${email}>` : ""}` : email || id || "unknown reviewer";
  return `${identity}${reviewer?.role === "workflow_creator" ? " (workflow creator)" : ""}`;
}

export function approvalRequirementText(requirement) {
  const reviewers = Array.isArray(requirement?.reviewers) ? requirement.reviewers : [];
  if (!reviewers.length) return "Approval required by: an authorized Statewright reviewer";
  const required = Number.isSafeInteger(requirement?.required_approvals) && requirement.required_approvals > 0
    ? requirement.required_approvals : 1;
  if (reviewers.length === 1) return `Approval required by: ${reviewerLabel(reviewers[0])}`;
  return `Approval requires ${required} of ${reviewers.length} reviewers:\n${reviewers.map(value => `- ${reviewerLabel(value)}`).join("\n")}`;
}

function deniedCapabilityText(result) {
  switch (result?.authorization?.reason) {
    case "origin_session_unverified":
      return "This connection cannot prove it is the workflow's originating session. The request remains pending. Cancel this dialog or safely deactivate the owned run; an eligible remote reviewer can use its approval page.";
    case "enterprise_reviewer_entitlement_required":
      return "Approval by a different designated reviewer requires the workflow owner's Enterprise entitlement. The request remains pending; the reviewer requirement has not changed.";
    case "approval_queue_entitlement_required":
      return "The workflow owner does not currently have a verified plan with approval queues. Check the owner's billing and subscription configuration; the request remains pending.";
    case "pro_entitlement_required":
      return "This Statewright account needs an active Pro entitlement to decide the request.";
    case "reviewer_mismatch":
      return "This terminal's Statewright account is not an authorized reviewer for this request.";
    case "unverified_reviewer":
      return "The authorized Statewright reviewer must verify their account before deciding this request.";
    case "unresolved_reviewer":
      return "The configured reviewer could not be resolved to a verified Statewright account.";
    default:
      return "This terminal cannot decide the request with its current Statewright credentials.";
  }
}

export function pendingApprovalSnapshot(item) {
  if (!["mcpToolCall", "McpToolCall"].includes(item?.type) || item.server !== "statewright"
      || (item.status !== undefined && item.status !== "completed")
      || item.error || item.result?.isError === true
      || !["statewright_transition", "statewright_get_state"].includes(item.tool)) return null;
  const result = item.result;
  const content = Array.isArray(result?.content) ? result.content : [];
  const candidates = [result?.structuredContent, ...content.filter(x => x?.type === "text").map(x => {
    try { return JSON.parse(x.text); } catch { return null; }
  })];
  for (const x of candidates) {
    if (typeof x?.pending_approval?.approval_id === "string") return x;
    if (x?.status === "pending_approval" && typeof x.approval_id === "string") return {
      run_id: x.run_id, run_session_id: x.run_session_id, state: x.from,
      pending_approval: {approval_id: x.approval_id, from_state: x.from, to_state: x.to, message: x.message},
    };
  }
  return null;
}

export const isPendingApprovalItem = item => pendingApprovalSnapshot(item) !== null;

// This controller receives trusted gateway tickets, never assistant prose.
// The resolver is a host capability; it must not be exposed as an agent tool.
export class HumanApprovalController {
  constructor({ send, read, resolve, openReview = async () => {}, record = async () => {}, pollMs = 2000 }) {
    Object.assign(this, { send, read, resolve, openReview, record, pollMs });
    this.requests = new Map();
    this.tickets = new Map();
  }

  recordSafely(event) {
    void Promise.resolve().then(() => this.record(event)).catch(() => {});
  }

  // Delivery failure must neither grant approval nor strand promise cleanup.
  notify(message) {
    try { void Promise.resolve(this.send(message)).catch(() => {}); } catch {}
  }

  remind(ticket) {
    const key = JSON.stringify([ticket.threadId, ticket.run_id, ticket.approval_id, ticket.run_session_id ?? null]);
    const entry = this.tickets.get(key);
    if (!entry || entry.lastResult?.status !== "pending" || entry.lastResult.can_decide === true) return false;
    void entry.present(entry.lastResult, true).catch(() => {});
    return true;
  }

  wait(ticket, { signal }) {
    for (const key of ["approval_id", "run_id", "threadId", "from_state", "to_state"]) {
      if (typeof ticket[key] !== "string" || !ticket[key]) throw new Error(`Missing approval identity: ${key}`);
    }
    if (ticket.run_session_id !== undefined
        && (typeof ticket.run_session_id !== "string" || !ticket.run_session_id)) {
      throw new Error("Invalid approval identity: run_session_id");
    }
    signal.throwIfAborted();
    const key = JSON.stringify([ticket.threadId, ticket.run_id, ticket.approval_id, ticket.run_session_id ?? null]);
    if (this.tickets.has(key)) {
      const existing = this.tickets.get(key);
      this.remind(ticket);
      return existing.promise;
    }
    const entry = { ticket: Object.freeze({ ...ticket }), signal, settled: false };
    entry.promise = new Promise((resolve, reject) => Object.assign(entry, { accept: resolve, reject }));
    const finish = (error, value) => {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      signal.removeEventListener("abort", entry.abort);
      if (entry.requestId) this.requests.delete(entry.requestId);
      this.tickets.delete(key);
      if (entry.presented && entry.requestId) {
        this.notify({ method: "serverRequest/resolved", params: { threadId: ticket.threadId, requestId: entry.requestId } });
      }
      if (error) entry.reject(error); else entry.accept(value);
    };
    entry.finish = finish;
    entry.abort = () => finish(signal.reason ?? new Error("Approval wait cancelled"));
    signal.addEventListener("abort", entry.abort, { once: true });
    this.tickets.set(key, entry);
    const present = async (result, force = false) => {
      if (entry.settled || entry.presenting) return;
      const canDecide = result.can_decide === true;
      const requirement = approvalRequirementText(result.approval_requirement);
      const fingerprint = JSON.stringify([canDecide, result?.authorization?.reason ?? null, requirement]);
      if (!force && entry.presented && entry.presentationFingerprint === fingerprint) return;
      if (entry.presented && entry.requestId) {
        this.notify({method: "serverRequest/resolved", params: {threadId: ticket.threadId, requestId: entry.requestId}});
        this.requests.delete(entry.requestId);
      }
      entry.canDecide = canDecide;
      entry.approvalRequirement = result.approval_requirement;
      entry.presentationFingerprint = null;
      entry.presented = false;
      entry.presenting = true;
      try {
      if (!canDecide) {
        entry.requestId = null;
        await this.send({ method: "warning", params: { threadId: ticket.threadId,
          message: `Statewright approval ${ticket.approval_id} remains parked.\n${requirement}\n${deniedCapabilityText(result)}` } });
        if (!entry.settled) {
          entry.presented = true;
          entry.presentationFingerprint = fingerprint;
        }
        return;
      }
      entry.requestId = `statewright-approval-${randomUUID()}`;
      this.requests.set(entry.requestId, entry);
      if (!entry.reviewOpened && result.remote_can_decide === true && typeof result.review_url === "string" && result.review_url) {
        entry.reviewOpened = true;
        void this.openReview(result.review_url).catch(() => {});
      }
      const review = typeof result.review_url === "string" && result.review_url
        ? `\nReview evidence: ${result.review_url}` : "";
      // Register before sending: a real native reply can race its send callback.
      entry.presented = true;
      await this.send({ id: entry.requestId, method: "mcpServer/elicitation/request", params: {
        threadId: ticket.threadId, turnId: ticket.turnId ?? null, serverName: "statewright", mode: "form",
        message: `Statewright approval ${ticket.approval_id}\n${ticket.from_state} -> ${ticket.to_state}\n${ticket.message ?? "Approve this workflow transition?"}\n${requirement}${review}\nThe active Statewright identity is authorized to decide this request.`,
        requestedSchema: { type: "object", properties: {} },
      } });
      if (!entry.settled) entry.presentationFingerprint = fingerprint;
      else this.notify({ method: "serverRequest/resolved", params: {
        threadId: ticket.threadId, requestId: entry.requestId,
      } });
      } catch (error) {
        entry.presented = false;
        if (entry.requestId) this.requests.delete(entry.requestId);
        entry.requestId = null;
        throw error;
      } finally {
        entry.presenting = false;
      }
    };
    entry.present = present;
    const poll = async () => {
      if (entry.settled) return;
      try {
        const result = await this.read(entry.ticket, { signal });
        this.verify(entry.ticket, result);
        entry.reportedReadError = false;
        entry.lastResult = result;
        if (entry.settled) return;
        if (result.status !== "pending") { finish(null, result); return; }
        // Native transport progress must not gate authoritative website decisions.
        // present() serializes delivery; replies still revalidate current authority.
        void present(result).then(() => {
          entry.reportedPresentationError = false;
        }).catch(() => {
          if (!entry.reportedPresentationError) {
            entry.reportedPresentationError = true;
            this.recordSafely({ type: "approval_notification_unavailable", threadId: ticket.threadId,
              approval_id: ticket.approval_id });
          }
          // Retry delivery on the existing poll, after reading current authority.
          // Never remember an unacknowledged send as a displayed prompt.
        });
      } catch (error) {
        if (signal.aborted) { finish(signal.reason); return; }
        // Transport loss is not permission. Keep waiting without inference.
        if (!entry.reportedReadError) {
          entry.reportedReadError = true;
          this.recordSafely({ type: "approval_read_unavailable", threadId: ticket.threadId, approval_id: ticket.approval_id });
          const missingSession = /Approval service HTTP 404/.test(String(error?.message));
          this.notify({ method: "warning", params: { threadId: ticket.threadId,
            message: `Statewright approval ${ticket.approval_id} remains parked. ${missingSession
              ? "The gateway no longer has this approval session; restore its authoritative checkpoint before deciding."
              : "The approval service is unavailable; no decision can be made until it responds."}` } });
        }
      }
      if (!entry.settled) entry.timer = setTimeout(poll, this.pollMs);
    };
    void poll().catch(error => finish(error));
    return entry.promise;
  }

  verify(ticket, result) {
    if (!result || ["approval_id", "run_id", "from_state", "to_state"].some(key => result[key] !== ticket[key])
        || (ticket.run_session_id !== undefined && result.run_session_id !== undefined
          && result.run_session_id !== ticket.run_session_id)
        || !["pending", "approved", "rejected"].includes(result.status)) {
      throw new Error("Approval resolver returned a foreign or malformed ticket");
    }
  }

  handleReply(reply) {
    if (reply.method || typeof reply.id !== "string" || !reply.id.startsWith("statewright-approval-")) return false;
    // Swallow late replies to our own requests; never forward them upstream.
    const entry = this.requests.get(reply.id);
    if (!entry || entry.submitting || !entry.presented) return true;
    const action = reply.result?.action;
    if (!entry.canDecide) {
      entry.finish(new Error("Approval notice dismissed; workflow remains pending"));
      return true;
    }
    if (reply.error || action === "cancel") {
      entry.finish(new Error("Approval dialog dismissed; workflow remains pending"));
      return true;
    }
    if (!["accept", "decline"].includes(action)) {
      entry.finish(new Error("Invalid approval reply; workflow remains pending"));
      return true;
    }
    entry.submitting = true;
    void (async () => {
      try {
        // Recheck before submitting: a website decision may already have won.
        let result = await this.read(entry.ticket, { signal: entry.signal });
        this.verify(entry.ticket, result);
        if (entry.settled) return;
        if (result.status === "pending") {
          if (result.can_decide !== true) { entry.canDecide = false; entry.submitting = false; return; }
          result = await this.resolve(entry.ticket, action === "accept" ? "approved" : "rejected", { signal: entry.signal });
          this.verify(entry.ticket, result);
        }
        if (result.status === "pending") throw new Error("Approval decision was not acknowledged");
        entry.finish(null, result);
      } catch {
        entry.finish(new Error("Approval resolution failed; workflow remains parked"));
      }
    })();
    return true;
  }
}
