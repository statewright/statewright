import { HumanApprovalController } from "./human-approval.mjs";

export class CodexApprovalGate {
  constructor({ service, send, rpc, continueApproved, record = async () => {}, safety = new Map(), onParking = () => {} }) {
    Object.assign(this, { service, rpc, continueApproved, record, onParking });
    this.controller = new HumanApprovalController({ ...service, send, record,
      read: async (...args) => { await this.assertOwner(args[0].threadId); args[1]?.signal?.throwIfAborted(); return service.read(...args); },
      resolve: async (...args) => { await this.assertOwner(args[0].threadId); args[2]?.signal?.throwIfAborted(); return service.resolve(...args); },
    });
    this.pending = new Map();
    this.epochs = new Map();
    this.safety = safety;
    this.closed = false;
  }

  userActivity(threadId) {
    this.epochs.set(threadId, (this.epochs.get(threadId) ?? 0) + 1);
    this.pending.get(threadId)?.abort.abort(new Error("Approval continuation superseded by user activity"));
  }

  handleReply(reply) { return this.controller.handleReply(reply); }

  async assertOwner(threadId) {
    if (this.service.ownsThread && !await this.service.ownsThread(threadId)) {
      throw new Error("Approval belongs to a different root thread");
    }
  }

  async stateFor(threadId, hint = null) {
    const saved = await this.service.restore(threadId);
    if (this.service.ownsThread && !await this.service.ownsThread(threadId)) {
      if (saved || hint) throw new Error("Approval belongs to a different root thread");
      return null;
    }
    const state = await this.service.getState(threadId);
    for (const expected of [saved, hint].filter(Boolean)) {
      if (!state || state.run_id !== expected.run_id || state.run_session_id !== expected.run_session_id) {
        throw new Error("Approval checkpoint has no matching live workflow; work remains parked");
      }
    }
    const alreadyReleased = hint?.pending_approval && !state?.pending_approval
      && state?.state === hint.pending_approval.to_state;
    const pending = state?.pending_approval ? state : saved ?? (alreadyReleased ? hint : null);
    if (hint?.pending_approval && !alreadyReleased && state?.pending_approval?.approval_id !== hint.pending_approval.approval_id) {
      throw new Error("Approval identity changed; work remains parked");
    }
    return pending;
  }

  async approvedState(threadId, snapshot) {
    await this.assertOwner(threadId);
    const state = await this.service.getState(threadId);
    await this.assertOwner(threadId);
    if (state?.run_id !== snapshot.run_id || state.run_session_id !== snapshot.run_session_id
        || state.state !== snapshot.pending_approval.to_state || state.pending_approval) {
      throw new Error("Approved transition has not been applied to the owning workflow");
    }
    return state;
  }

  async park(threadId, snapshot, { turnId = null, autoContinue = false, retainCheckpoint = false } = {}) {
    const existing = this.pending.get(threadId);
    if (existing && !existing.abort.signal.aborted) return existing.promise;
    const entry = { abort: new AbortController(), epoch: this.epochs.get(threadId) ?? 0, snapshot, turnId };
    const check = () => {
      entry.abort.signal.throwIfAborted();
      if (this.closed || (this.epochs.get(threadId) ?? 0) !== entry.epoch) {
        throw new Error("Approval continuation superseded by user activity");
      }
    };
    this.pending.set(threadId, entry);
    const predecessor = this.safety.get(threadId);
    this.onParking(true);
    entry.safety = (async () => {
      // A replacement must not release while older parking RPCs can still pause it.
      if (predecessor) await predecessor.catch(() => {});
      await this.service.park(threadId, snapshot);
      // New input cancels release, never the safety work that parks inference.
      await this.assertOwner(threadId);
      const goal = (await this.rpc("thread/goal/get", { threadId })).goal;
      await this.assertOwner(threadId);
      if (goal?.status === "active") {
        const paused = (await this.rpc("thread/goal/set", { threadId, status: "paused" })).goal;
        await this.assertOwner(threadId);
        if (paused?.status !== "paused" || paused.objective !== goal.objective || paused.createdAt !== goal.createdAt) {
          throw new Error("Native goal did not pause for approval");
        }
        entry.goal = paused;
      } else if (goal?.status === "paused") entry.goal = goal;
      else if (goal) throw new Error("Approval belongs to a native goal that is no longer resumable");
      if (turnId) {
        const thread = (await this.rpc("thread/read", { threadId, includeTurns: false })).thread;
        await this.assertOwner(threadId);
        if (thread?.id !== threadId) throw new Error("Approval activity check returned a foreign thread");
        if (thread.status?.type !== "idle") await this.rpc("turn/interrupt", { threadId, turnId });
        await this.assertOwner(threadId);
      }
      await this.record({ type: "human_approval_parked", threadId, run_id: snapshot.run_id,
        approval_id: snapshot.pending_approval.approval_id });
    })().finally(() => this.onParking(false));
    this.safety.set(threadId, entry.safety);
    entry.promise = (async () => {
      await entry.safety;
      check();
      if (this.service.presentationEnabled === false) {
        throw new Error("Native approval presentation is disabled; workflow remains parked");
      }
      const ticket = { ...snapshot.pending_approval, run_id: snapshot.run_id,
        run_session_id: snapshot.run_session_id, threadId, turnId };
      const decision = await this.controller.wait(ticket, { signal: entry.abort.signal });
      check();
      if (decision.status !== "approved") {
        await this.service.clear(threadId, ticket.approval_id);
        throw new Error("Human rejected transition; autonomous work remains parked");
      }
      const state = await this.approvedState(threadId, snapshot);
      check();
      if (autoContinue && !state.is_final) {
        await this.assertOwner(threadId);
        await this.continueApproved({ threadId, state, goal: entry.goal, check });
        check();
      }
      if (!retainCheckpoint) await this.service.clear(threadId, ticket.approval_id);
      return state;
    })().finally(() => {
      if (this.pending.get(threadId) === entry) this.pending.delete(threadId);
      if (this.safety.get(threadId) === entry.safety) this.safety.delete(threadId);
    });
    return entry.promise;
  }

  async beforeTurn(threadId, { turnId = null } = {}) {
    const epoch = this.epochs.get(threadId) ?? 0;
    const snapshot = await this.stateFor(threadId);
    if (this.closed || (this.epochs.get(threadId) ?? 0) !== epoch) throw new Error("Approval request superseded by newer input");
    if (!snapshot) return;
    const state = await this.park(threadId, snapshot, { turnId, retainCheckpoint: true });
    return { state, approvalId: snapshot.pending_approval.approval_id };
  }

  async reopen(threadId) {
    const epoch = this.epochs.get(threadId) ?? 0;
    const snapshot = await this.stateFor(threadId);
    if (this.closed || (this.epochs.get(threadId) ?? 0) !== epoch) return;
    if (snapshot) await this.park(threadId, snapshot, { autoContinue: true });
  }

  async observe(threadId, hint, turnId) {
    const epoch = this.epochs.get(threadId) ?? 0;
    const snapshot = await this.stateFor(threadId, hint);
    if (this.closed || (this.epochs.get(threadId) ?? 0) !== epoch) return;
    if (snapshot) await this.park(threadId, snapshot, { turnId, autoContinue: true });
  }

  close() {
    this.closed = true;
    for (const entry of this.pending.values()) entry.abort.abort(new Error("Approval connection closed; ticket remains pending"));
  }
}
