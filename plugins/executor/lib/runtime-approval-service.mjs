import { approvalJournal } from "./approval-journal.mjs";
import { openExternalUrl, uploadApprovalEvidence } from "./approval-evidence.mjs";

function openEvidenceReview(url) {
  return new Promise((resolve, reject) => {
    const child = openExternalUrl(url);
    child.once("error", reject);
    child.once("spawn", resolve);
  });
}

export function createRuntimeApprovalService({ root, apiKey, gatewayUrl, pbUrl, cwd, clientId,
  fetchImpl = fetch, openReview = openEvidenceReview, ownsThread, presentationEnabled = true }) {
  const journal = approvalJournal(root, clientId);
  const prepared = new Set();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`,
    "x-statewright-client-id": clientId };
  const endpoint = gatewayUrl.replace(/\/+$/, "");
  const verify = (ticket, receipt) => {
    if (["approval_id", "run_id", "from_state", "to_state"].some(key => receipt?.[key] !== ticket[key])
        || receipt.run_session_id !== undefined && receipt.run_session_id !== ticket.run_session_id
        || !["pending", "approved", "rejected"].includes(receipt?.status)) {
      throw new Error("Approval service returned a foreign or malformed ticket");
    }
  };
  const request = async (ticket, decision, signal) => {
    signal?.throwIfAborted();
    if (!ticket?.run_session_id) throw new Error("Approval has no gateway session identity");
    if (ownsThread && !await ownsThread(ticket.threadId)) throw new Error("Approval belongs to a different root thread");
    signal?.throwIfAborted();
    const response = await fetchImpl(new URL("/api/runtime-approval", endpoint).href, {
      method: "POST", headers,
      body: JSON.stringify({ approval_id: ticket.approval_id, run_id: ticket.run_id,
        run_session_id: ticket.run_session_id, ...(decision ? { decision } : {}) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Approval service HTTP ${response.status}`);
    const receipt = await response.json();
    verify(ticket, receipt);
    if (!decision && receipt.status === "pending" && !prepared.has(receipt.approval_id)) {
      await uploadApprovalEvidence({ receipt, apiKey, pbUrl, cwd, fetchImpl });
      prepared.add(receipt.approval_id);
    }
    if (pbUrl && receipt.record_id) receipt.review_url = `${pbUrl.replace(/\/$/, "")}/approvals/${encodeURIComponent(receipt.record_id)}`;
    return receipt;
  };
  return {
    ownsThread,
    presentationEnabled,
    park: (threadId, state) => journal.save(threadId, state),
    restore: threadId => journal.load(threadId),
    clear: (threadId, id) => journal.clear(threadId, id),
    read: (ticket, { signal } = {}) => request(ticket, undefined, signal),
    resolve: (ticket, decision, { signal } = {}) => request(ticket, decision, signal),
    openReview: async url => {
      const result = openReview(url);
      if (typeof result?.once === "function") {
        await new Promise((resolve, reject) => {
          result.once("error", reject);
          result.once("spawn", resolve);
        });
      } else await result;
    },
    async getState() {
      const response = await fetchImpl(endpoint, { method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: "statewright-approval-state", method: "tools/call",
          params: { name: "statewright_get_state", arguments: {} } }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Approval state HTTP ${response.status}`);
      const result = await response.json();
      if (!result.error && result.result?.isError && result.result.content?.length === 1
          && result.result.content[0].type === "text"
          && result.result.content[0].text === "No active workflow. Load a workflow before requesting state.") return null;
      if (result.error || result.result?.isError) throw new Error("Approval state is unavailable");
      if (result.result?.structuredContent) return result.result.structuredContent;
      for (const block of result.result?.content ?? []) {
        if (block.type !== "text") continue;
        const value = JSON.parse(block.text);
        if (value && typeof value === "object") return value;
      }
      throw new Error("Approval state has no authoritative snapshot");
    },
  };
}
