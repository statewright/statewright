"use strict";

const { createHash } = require("node:crypto");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const { artifactName, receiptContract } = require("./canary-step-receipt.cjs");
const MAX_BYTES = 64 * 1024;

function decodeReceiptArchive(bytes, digest) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES ||
      !/^sha256:[a-f0-9]{64}$/.test(digest ?? "") ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest) {
    throw new Error("Canary artifact size or SHA-256 digest mismatch.");
  }
  const directory = mkdtempSync(join(tmpdir(), "statewright-canary-receipt-"));
  try {
    const archive = join(directory, "receipt.zip");
    writeFileSync(archive, bytes, { flag: "wx", mode: 0o600 });
    const options = { encoding: "utf8", maxBuffer: MAX_BYTES, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] };
    // No extraction to disk and no archive-controlled paths or executable code.
    const names = execFileSync("unzip", ["-Z1", archive], options);
    if (names !== "canary-steps.json\n") throw new Error("Unexpected canary archive members.");
    return JSON.parse(execFileSync("unzip", ["-p", archive, "canary-steps.json"], options));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function readCanaryReceipt({ github, context, requirement, run, job, sourceSha }) {
  const repo = context.repo;
  const contract = receiptContract(requirement.workflowId, job.name);
  const attempt = job.run_attempt;
  if (job.run_id !== run.id || job.head_sha !== sourceSha ||
      !Number.isSafeInteger(attempt) || attempt < 1 || attempt > run.run_attempt) {
    throw new Error("Canary job source/run/attempt mismatch.");
  }
  const name = artifactName(requirement.workflowId, job.name, attempt);
  const artifacts = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await github.rest.actions.listWorkflowRunArtifacts({
      ...repo, run_id: run.id, name, per_page: 100, page,
    });
    artifacts.push(...(data.artifacts ?? []));
    if ((data.artifacts ?? []).length < 100) break;
    if (page === 10) throw new Error("Canary artifact pagination exceeded bound.");
  }
  const matches = artifacts.filter(a => a.name === name);
  if (matches.length !== 1) throw new Error(`Required canary receipt ${name} is missing or ambiguous.`);
  const artifact = matches[0];
  if (artifact.expired !== false || !Number.isSafeInteger(artifact.id) || artifact.id < 1 ||
      artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== sourceSha ||
      artifact.workflow_run?.head_branch !== "main" ||
      !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > MAX_BYTES) {
    throw new Error("Canary artifact expired or source/run metadata mismatched.");
  }
  const download = await github.rest.actions.downloadArtifact({ ...repo, artifact_id: artifact.id, archive_format: "zip" });
  const receipt = decodeReceiptArchive(Buffer.from(download.data), artifact.digest);
  const expected = {
    schema: "statewright.canary-steps.v1", repository: `${repo.owner}/${repo.repo}`,
    sourceSha, event: "push", ref: "refs/heads/main", workflow: requirement.workflowId,
    workflowRef: `${repo.owner}/${repo.repo}/.github/workflows/${requirement.workflowId}@refs/heads/main`,
    runId: run.id, attempt, jobKey: contract.jobKey, jobName: job.name,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (receipt?.[key] !== value) throw new Error(`Canary receipt ${key} mismatch.`);
  }
  if (!Array.isArray(receipt.steps) || receipt.steps.length !== Object.keys(contract.steps).length) {
    throw new Error("Canary receipt required step set mismatch.");
  }
  for (const [id, name] of Object.entries(contract.steps)) {
    const matches = receipt.steps.filter(step => step?.id === id && step?.name === name);
    if (matches.length !== 1 || matches[0].outcome !== "success" || matches[0].conclusion !== "success") {
      throw new Error(`Canary receipt lacks successful step ${name}.`);
    }
  }
  return { artifactId: artifact.id, digest: artifact.digest, attempt, job: job.name };
}

module.exports = { readCanaryReceipt, decodeReceiptArchive };
