"use strict";

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

async function requireWorkflowJobs({ github, context, requirement, run }) {
  const { data } = await github.rest.actions.listJobsForWorkflowRun({
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: run.id,
    per_page: 100,
  });
  const jobs = data.jobs ?? [];
  for (const jobName of requirement.requiredJobs) {
    const job = jobs.find((candidate) => candidate.name === jobName);
    if (!job || job.conclusion !== "success") {
      throw new Error(`${requirement.label} run ${run.id} lacks successful job ${jobName}.`);
    }
  }
  for (const required of requirement.requiredSteps ?? []) {
    const job = jobs.find((candidate) => candidate.name === required.job);
    const step = job?.steps?.find((candidate) => candidate.name === required.step);
    if (!step || step.conclusion !== "success") {
      throw new Error(
        `${requirement.label} run ${run.id} lacks successful step ${required.step} in ${required.job}.`,
      );
    }
  }
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
      run.conclusion === "success" && run.event === "push");
    if (candidates.length === 0) {
      throw new Error(`${requirement.label} has no successful trusted push run for ${sourceSha}.`);
    }
    let passed;
    let lastError;
    for (const candidate of candidates) {
      try {
        await requireWorkflowJobs({ github, context, requirement, run: candidate });
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
    evidence.push({ workflowId: requirement.workflowId, runId: passed.id, url: passed.html_url });
  }
  return evidence;
}

module.exports = { REQUIRED_WORKFLOWS, requirePluginCanaries };
