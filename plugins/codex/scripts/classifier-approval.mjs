#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_INPUT_BYTES = 32 * 1024;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

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
    schema: "statewright/classifier-approval-request/v1",
    thread_id: printable(value.thread_id) ? value.thread_id : null,
    run_id: printable(value.run_id) ? value.run_id : null,
    state: printable(value.state) ? value.state : null,
    classifier_receipt: {
      intent_fingerprint: fingerprint(receipt?.intent_fingerprint, "intent_v1_"),
      invocation_fingerprint: fingerprint(receipt?.invocation_fingerprint, "invocation_v1_"),
      final_denial_basis: printable(basis) ? basis : null,
      required_authority: printable(receipt?.required_authority)
        ? receipt.required_authority : "approved execution path",
    },
  };
  return request.thread_id && request.run_id && request.state
    && request.classifier_receipt.intent_fingerprint
    && request.classifier_receipt.invocation_fingerprint
    && request.classifier_receipt.final_denial_basis ? request : null;
}

function runDirectory(environment) {
  if (printable(environment.LOCAL_MODELS_RUN_DIR, 4096)) return environment.LOCAL_MODELS_RUN_DIR;
  if (printable(environment.CODEX_HOME, 4096) && /(?:^|\/)codex-home\/?$/.test(environment.CODEX_HOME)) {
    return dirname(environment.CODEX_HOME);
  }
  throw new Error("local_models_runtime_unavailable");
}

export async function requestClassifierApproval(value, options = {}) {
  const request = redactedApprovalRequest(value);
  if (!request) return {schema: "statewright/classifier-approval/v1",
    action: "deny", reason: "invalid_redacted_classifier_receipt"};
  const environment = options.environment ?? process.env;
  const runtime = JSON.parse(await (options.readFile ?? readFile)(
    join(runDirectory(environment), "runtime.json"), "utf8"));
  if (!printable(runtime.proxyUrl, 4096) || !printable(runtime.proxyToken, 4096)) {
    throw new Error("local_models_runtime_receipt_incomplete");
  }
  const endpoint = new URL(runtime.proxyUrl);
  if (!/^wss?:$/.test(endpoint.protocol) || !["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)) {
    throw new Error("local_models_runtime_not_loopback");
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
    throw new Error(`local_models_classifier_approval_http_${response.status}`);
  }
  if (!['rework', 'allow_once', 'deny'].includes(result.action)) {
    throw new Error("local_models_classifier_approval_invalid_action");
  }
  if (result.action === "allow_once"
      && result.invocation_fingerprint !== request.classifier_receipt.invocation_fingerprint) {
    throw new Error("local_models_classifier_approval_identity_mismatch");
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
    schema: "statewright/classifier-approval/v1", action: "unavailable",
    reason: String(error?.message ?? error).slice(0, 128),
  })}\n`));
}
