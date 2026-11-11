"use strict";

// Runner-owned steps context, never log parsing or a job-success inference.
const fs = require("node:fs");
const WINDOWS_JOB = "Codex and Claude managed-client bootstrap";
const WINDOWS_STEPS = Object.freeze({
  bootstrap: "Run managed-client bootstrap canary",
  route: "Run managed-client route canary",
  onboarding: "Prove secretless browser onboarding",
  production: "Run authenticated production gateway canary",
  codex_telemetry: "Submit Codex adoption telemetry event",
  claude_telemetry: "Submit Claude adoption telemetry event",
});

function receiptContract(workflow, jobName) {
  if (workflow === "windows-plugin-canary.yml" && jobName === WINDOWS_JOB) {
    return { jobKey: "managed-client-bootstrap", key: "windows", steps: WINDOWS_STEPS };
  }
  const match = /^(codex|claude|cursor|pi|opencode|omx) on (ubuntu-24\.04|macos-15)$/.exec(jobName);
  if (workflow === "plugin-production-canary.yml" && match) {
    return {
      jobKey: "production-gateway", key: `${match[1]}-${match[2]}`,
      steps: { telemetry: "Submit plugin adoption telemetry event" },
    };
  }
  throw new Error("Unsupported canary receipt workflow/job.");
}

function artifactName(workflow, jobName, attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid canary attempt.");
  return `canary-steps-${receiptContract(workflow, jobName).key}-attempt-${attempt}`;
}

function makeReceipt(env) {
  const contract = receiptContract(env.CANARY_WORKFLOW, env.CANARY_JOB_NAME);
  const steps = JSON.parse(env.CANARY_STEPS);
  const runId = Number(env.GITHUB_RUN_ID);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== "refs/heads/main" ||
      !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "") ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") || env.CANARY_SOURCE_SHA !== env.GITHUB_SHA ||
      env.GITHUB_WORKFLOW_REF !== `${env.GITHUB_REPOSITORY}/.github/workflows/${env.CANARY_WORKFLOW}@refs/heads/main` ||
      env.GITHUB_JOB !== contract.jobKey || !Number.isSafeInteger(runId) || runId < 1) {
    throw new Error("Canary receipt requires exact-source trusted main push identity.");
  }
  artifactName(env.CANARY_WORKFLOW, env.CANARY_JOB_NAME, attempt);
  const recorded = Object.entries(contract.steps).map(([id, name]) => {
    const step = steps[id];
    if (step?.outcome !== "success" || step?.conclusion !== "success") {
      throw new Error(`Required canary step did not succeed: ${name}`);
    }
    return { id, name, outcome: step.outcome, conclusion: step.conclusion };
  });
  return {
    schema: "statewright.canary-steps.v1", repository: env.GITHUB_REPOSITORY,
    sourceSha: env.GITHUB_SHA, event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
    workflow: env.CANARY_WORKFLOW, workflowRef: env.GITHUB_WORKFLOW_REF,
    runId, attempt, jobKey: env.GITHUB_JOB, jobName: env.CANARY_JOB_NAME, steps: recorded,
  };
}

if (require.main === module) {
  fs.writeFileSync("canary-steps.json", `${JSON.stringify(makeReceipt(process.env), null, 2)}\n`, { flag: "wx" });
}
module.exports = { receiptContract, artifactName, makeReceipt };
