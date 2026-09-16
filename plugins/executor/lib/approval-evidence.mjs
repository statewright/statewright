import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";

const mediaTypes = new Map([
  [".pdf", "application/pdf"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".txt", "text/plain"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

function packetArtifacts(receipt) {
  const packet = receipt?.context_snapshot?.evidence_packet;
  if (!packet) return [];
  if (packet.schema !== "statewright/evidence-packet/v1" || !Array.isArray(packet.artifacts)) {
    throw new Error("Approval evidence packet is malformed.");
  }
  if (packet.artifacts.length > 8) throw new Error("Approval evidence packet exceeds eight artifacts.");
  return packet.artifacts;
}

export async function uploadApprovalEvidence({ receipt, apiKey, pbUrl, cwd, fetchImpl = fetch }) {
  const artifacts = packetArtifacts(receipt);
  if (!artifacts.length) return [];
  const root = await realpath(cwd);
  const uploaded = [];
  for (const artifact of artifacts) {
    if (typeof artifact?.local_path !== "string" || !artifact.local_path.trim()) {
      throw new Error("Approval evidence artifact has no local_path.");
    }
    const candidate = await realpath(isAbsolute(artifact.local_path)
      ? artifact.local_path
      : resolve(root, artifact.local_path));
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      throw new Error("Approval evidence must stay inside the project root.");
    }
    const info = await stat(candidate);
    if (!info.isFile() || info.size <= 0 || info.size > 20 * 1024 * 1024) {
      throw new Error("Approval evidence file must be 1 byte to 20 MiB.");
    }
    const mediaType = mediaTypes.get(extname(candidate).toLowerCase());
    if (!mediaType) throw new Error(`Unsupported approval evidence type: ${extname(candidate)}`);
    const bytes = await readFile(candidate);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const form = new FormData();
    form.set("approval_id", receipt.approval_id);
    form.set("run_id", receipt.run_id);
    form.set("digest", digest);
    form.set("label", String(artifact.label || basename(candidate)).slice(0, 255));
    form.set("description", String(artifact.description || "").slice(0, 2000));
    form.set("media_type", mediaType);
    form.set("classification", ["internal", "confidential", "restricted"].includes(artifact.classification)
      ? artifact.classification
      : "internal");
    form.set("file", new Blob([bytes], { type: mediaType }), basename(candidate));
    const response = await fetchImpl(`${pbUrl.replace(/\/$/, "")}/api/runtime-approval-evidence`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Approval evidence upload HTTP ${response.status}`);
    uploaded.push(await response.json());
  }
  return uploaded;
}

export async function prepareManagedApproval({ request, apiKey, gatewayUrl, pbUrl, cwd, clientId, fetchImpl = fetch }) {
  for (const field of ["approval_id", "run_id", "run_session_id"]) {
    if (typeof request?.[field] !== "string" || !request[field]) {
      throw new Error(`Managed approval request is missing ${field}.`);
    }
  }
  if (request.client_id !== clientId) throw new Error("Managed approval request has a mismatched client identity.");
  const response = await fetchImpl(`${gatewayUrl.replace(/\/$/, "")}/api/runtime-approval`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-statewright-client-id": clientId,
    },
    body: JSON.stringify({
      approval_id: request.approval_id,
      run_id: request.run_id,
      run_session_id: request.run_session_id,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Approval service HTTP ${response.status}`);
  const receipt = await response.json();
  if (receipt?.status !== "pending" || receipt.approval_id !== request.approval_id
      || receipt.run_id !== request.run_id) {
    throw new Error("Approval service returned a mismatched or inactive receipt.");
  }
  await uploadApprovalEvidence({ receipt, apiKey, pbUrl, cwd, fetchImpl });
  if (!receipt.record_id) throw new Error("Approval receipt has no browser record identity.");
  return {
    receipt,
    reviewUrl: `${pbUrl.replace(/\/$/, "")}/approvals/${encodeURIComponent(receipt.record_id)}`,
  };
}

export function openExternalUrl(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const command = platform === "darwin" ? ["open", [url]]
    : platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawnImpl(command[0], command[1], { detached: true, stdio: "ignore" });
  child.unref?.();
  return child;
}
