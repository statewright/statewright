"use strict";

const { readCanaryReceipt } = require("./read-canary-receipt.cjs");

const UNIX_PLUGINS = Object.freeze(["codex", "claude", "cursor", "pi", "opencode", "omx"]);
const UNIX_OPERATING_SYSTEMS = Object.freeze(["ubuntu-24.04", "macos-15"]);
const WINDOWS_JOB = "Codex and Claude managed-client bootstrap";
const ADOPTION_TELEMETRY_STEP = "Submit plugin adoption telemetry event";
const WINDOWS_ONBOARDING_STEP = "Prove secretless browser onboarding";
const WINDOWS_PRODUCTION_STEP = "Run authenticated production gateway canary";
const WINDOWS_BOOTSTRAP_STEP = "Run managed-client bootstrap canary";
const WINDOWS_ROUTE_STEP = "Run managed-client route canary";
const WINDOWS_CODEX_TELEMETRY_STEP = "Submit Codex adoption telemetry event";
const WINDOWS_CLAUDE_TELEMETRY_STEP = "Submit Claude adoption telemetry event";

const REQUIRED_WORKFLOWS = Object.freeze([
  {
    workflowId: "plugin-production-canary.yml",
    label: "macOS/Linux production matrix",
    requiredJobs: UNIX_PLUGINS.flatMap((plugin) =>
      UNIX_OPERATING_SYSTEMS.map((operatingSystem) => `${plugin} on ${operatingSystem}`)),
    requiredSteps: UNIX_PLUGINS.flatMap((plugin) =>
      UNIX_OPERATING_SYSTEMS.map((operatingSystem) => ({
        job: `${plugin} on ${operatingSystem}`,
        step: ADOPTION_TELEMETRY_STEP,
      }))),
  },
  {
    workflowId: "windows-plugin-canary.yml",
    label: "Windows production/bootstrap",
    requiredJobs: [WINDOWS_JOB],
    requiredSteps: [
      { job: WINDOWS_JOB, step: WINDOWS_BOOTSTRAP_STEP },
      { job: WINDOWS_JOB, step: WINDOWS_ROUTE_STEP },
      { job: WINDOWS_JOB, step: WINDOWS_ONBOARDING_STEP },
      { job: WINDOWS_JOB, step: WINDOWS_PRODUCTION_STEP },
      { job: WINDOWS_JOB, step: WINDOWS_CODEX_TELEMETRY_STEP },
      { job: WINDOWS_JOB, step: WINDOWS_CLAUDE_TELEMETRY_STEP },
    ],
  },
  {
    workflowId: "ci.yml",
    label: "plugin contract matrix",
    requiredJobs: ["Plugin contract matrix"],
  },
]);

async function requireWorkflowJobs({ github, context, requirement, run, sourceSha }) {
  const { data } = await github.rest.actions.listJobsForWorkflowRun({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: run.id,
    filter: "latest",
    per_page: 100,
  });
  const jobs = data.jobs ?? [];
  if (data.total_count > jobs.length) throw new Error("Incomplete canary job listing.");
  const receipts = [];
  for (const jobName of requirement.requiredJobs) {
    const matches = jobs.filter((candidate) => candidate.name === jobName);
    const job = matches[0];
    if (matches.length !== 1 || job.status !== "completed" || job.conclusion !== "success" ||
        job.run_id !== run.id || job.head_sha !== sourceSha) {
      throw new Error(`${requirement.label} run ${run.id} lacks successful job ${jobName}.`);
    }
    const required = (requirement.requiredSteps ?? []).filter(step => step.job === jobName);
    if (required.length && Array.isArray(job.steps) && job.steps.length === 0) {
      // GitHub occasionally omits the entire steps array. Use a separately
      // authenticated, digest-checked runner receipt; never synthesize API steps.
      receipts.push(await readCanaryReceipt({ github, context, requirement, run, job, sourceSha }));
      continue;
    }
    for (const { step: stepName } of required) {
      const steps = job.steps?.filter(candidate => candidate.name === stepName);
      if (steps?.length !== 1 || steps[0].status !== "completed" || steps[0].conclusion !== "success") {
        throw new Error(`${requirement.label} run ${run.id} lacks successful step ${stepName} in ${jobName}.`);
      }
    }
  }
  return receipts;
}

async function requirePluginCanaries({ github, context, core, sourceSha }) {
  if (!sourceSha) throw new Error("Release source SHA is required.");
  const branch = await github.rest.repos.getBranch({
    owner: context.repo.owner,
    repo: context.repo.repo,
    branch: "main",
  });
  if (branch.data.commit.sha !== sourceSha) {
    throw new Error(`Release tag commit ${sourceSha} is not current main ${branch.data.commit.sha}.`);
  }

  const evidence = [];
  for (const requirement of REQUIRED_WORKFLOWS) {
    const { data } = await github.rest.actions.listWorkflowRuns({
      owner: context.repo.owner,
      repo: context.repo.repo,
      workflow_id: requirement.workflowId,
      head_sha: sourceSha,
      status: "completed",
      per_page: 100,
    });
    const candidates = data.workflow_runs.filter((run) =>
      run.conclusion === "success" && run.status === "completed" && run.event === "push" &&
      run.head_sha === sourceSha && run.head_branch === "main" &&
      run.path === `.github/workflows/${requirement.workflowId}` &&
      run.repository?.full_name === `${context.repo.owner}/${context.repo.repo}` &&
      run.head_repository?.full_name === `${context.repo.owner}/${context.repo.repo}` &&
      Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
    if (candidates.length === 0) {
      throw new Error(`${requirement.label} has no successful trusted push run for ${sourceSha}.`);
    }
    let passed;
    let receipts;
    let lastError;
    for (const candidate of candidates) {
      try {
        receipts = await requireWorkflowJobs({ github, context, requirement, run: candidate, sourceSha });
        passed = candidate;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!passed) {
      throw new Error(
        `${requirement.label} has no complete successful trusted push run for ${sourceSha}: ${lastError?.message}`,
      );
    }
    core.info(`${requirement.label}: ${passed.html_url}`);
    evidence.push({ workflowId: requirement.workflowId, runId: passed.id, url: passed.html_url, receipts });
  }
  return evidence;
}

module.exports = { REQUIRED_WORKFLOWS, requirePluginCanaries };
