#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_INPUT_BYTES = 32 * 1024;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const APPROVABLE_BASES = new Set([
  "semantic_threshold_not_met",
  "incomplete_structural_evidence",
  "semantic_vector_unavailable",
  "semantic_assessment_incomplete",
  "semantic_authorization_disabled",
]);

function printable(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function fingerprint(value, prefix) {
  return printable(value) && value.startsWith(prefix) ? value : null;
}

export function redactedApprovalRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value.classifier_receipt;
  const basis = receipt?.final_denial_basis ?? receipt?.resolution_basis;
  const request = {
    schema: "statewright/classifier-approval-request/v2",
    thread_id: printable(value.thread_id) ? value.thread_id : null,
    run_id: printable(value.run_id) ? value.run_id : null,
    run_session_id: printable(value.run_session_id) ? value.run_session_id : null,
    state: printable(value.state) ? value.state : null,
    state_epoch: Number.isSafeInteger(value.state_epoch) && value.state_epoch >= 0
      ? value.state_epoch : null,
    classifier_receipt: {
      intent_fingerprint: fingerprint(receipt?.intent_fingerprint, "intent_v1_"),
      invocation_fingerprint: fingerprint(receipt?.invocation_fingerprint, "invocation_v1_"),
      final_denial_basis: printable(basis) ? basis : null,
      required_authority: printable(receipt?.required_authority)
        ? receipt.required_authority : "approved execution path",
      reformulation_allowed: receipt?.reformulation_allowed === true,
      exact_invocation_retry_allowed: receipt?.exact_invocation_retry_allowed === false
        ? false : null,
      separate_approval_allowed: receipt?.separate_approval_allowed === true,
    },
  };
  return request.thread_id && request.run_id && request.run_session_id
    && request.state && request.state_epoch !== null
    && request.classifier_receipt.intent_fingerprint
    && request.classifier_receipt.invocation_fingerprint
    && request.classifier_receipt.final_denial_basis
    && APPROVABLE_BASES.has(request.classifier_receipt.final_denial_basis)
    && request.classifier_receipt.required_authority
      === "complete_structural_evidence_or_separate_approval"
    && request.classifier_receipt.reformulation_allowed
    && request.classifier_receipt.exact_invocation_retry_allowed === false
    && request.classifier_receipt.separate_approval_allowed ? request : null;
}

function runtimeReceiptPath(environment) {
  // An owning host may advertise one exact private receipt. Never infer host
  // mode from a shared route-directory shape or fall through after an explicit
  // owner fails: the companion and standalone resident both use `routes/`.
  if (printable(environment.STATEWRIGHT_CLASSIFIER_APPROVAL_RECEIPT, 4096)) {
    return environment.STATEWRIGHT_CLASSIFIER_APPROVAL_RECEIPT;
  }
  if (printable(environment.LOCAL_MODELS_RUN_DIR, 4096)) {
    return join(environment.LOCAL_MODELS_RUN_DIR, "runtime.json");
  }
  if (printable(environment.CODEX_HOME, 4096) && /(?:^|\/)codex-home\/?$/.test(environment.CODEX_HOME)) {
    return join(dirname(environment.CODEX_HOME), "runtime.json");
  }
  throw new Error("classifier_approval_runtime_unavailable");
}

export async function requestClassifierApproval(value, options = {}) {
  const request = redactedApprovalRequest(value);
  if (!request) return {schema: "statewright/classifier-approval/v2",
    action: "deny", reason: "invalid_redacted_classifier_receipt"};
  const environment = options.environment ?? process.env;
  const runtime = JSON.parse(await (options.readFile ?? readFile)(runtimeReceiptPath(environment), "utf8"));
  if (!printable(runtime.proxyUrl, 4096) || !printable(runtime.proxyToken, 4096)) {
    throw new Error("classifier_approval_runtime_receipt_incomplete");
  }
  const endpoint = new URL(runtime.proxyUrl);
  if (!/^wss?:$/.test(endpoint.protocol) || !["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)) {
    throw new Error("classifier_approval_runtime_not_loopback");
  }
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  endpoint.pathname = "/classifier-approval";
  endpoint.search = "";
  endpoint.hash = "";
  const response = await (options.fetch ?? fetch)(endpoint, {
    method: "POST",
    headers: {"Content-Type": "application/json", Authorization: `Bearer ${runtime.proxyToken}`},
    body: JSON.stringify(request),
    signal: options.signal ?? AbortSignal.timeout(APPROVAL_TIMEOUT_MS),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || typeof result !== "object") {
    throw new Error(`classifier_approval_http_${response.status}`);
  }
  if (!["rework", "allow_once", "deny"].includes(result.action)) {
    throw new Error("classifier_approval_invalid_action");
  }
  const expectedIdentity = {
    schema: "statewright/classifier-approval/v2",
    thread_id: request.thread_id,
    run_id: request.run_id,
    run_session_id: request.run_session_id,
    state: request.state,
    state_epoch: request.state_epoch,
    intent_fingerprint: request.classifier_receipt.intent_fingerprint,
    invocation_fingerprint: request.classifier_receipt.invocation_fingerprint,
    basis: request.classifier_receipt.final_denial_basis,
    required_authority: request.classifier_receipt.required_authority,
    reformulation_allowed: request.classifier_receipt.reformulation_allowed,
    exact_invocation_retry_allowed: request.classifier_receipt.exact_invocation_retry_allowed,
    separate_approval_allowed: request.classifier_receipt.separate_approval_allowed,
  };
  if (Object.entries(expectedIdentity).some(([key, expected]) => result[key] !== expected)) {
    throw new Error("classifier_approval_identity_mismatch");
  }
  return result;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error("classifier_approval_input_too_large");
  }
  const value = JSON.parse(input);
  process.stdout.write(`${JSON.stringify(await requestClassifierApproval(value))}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => process.stdout.write(`${JSON.stringify({
    schema: "statewright/classifier-approval/v2", action: "unavailable",
    reason: String(error?.message ?? error).slice(0, 128),
  })}\n`));
}
