import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const { REQUIRED_WORKFLOWS, requirePluginCanaries } = require(
  resolve(root, ".github/scripts/require-plugin-canaries.cjs"),
);
const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const { makeReceipt, receiptContract, artifactName } = require(resolve(root, ".github/scripts/canary-step-receipt.cjs"));
const { readCanaryReceipt, decodeReceiptArchive } = require(resolve(root, ".github/scripts/read-canary-receipt.cjs"));

function githubClient({ branchSha = SOURCE_SHA, jobs = successfulJobs(), runs = {} } = {}) {
  return {
    rest: {
      repos: {
        getBranch: async (request) => {
          assert.deepEqual(request, { owner: "statewright", repo: "statewright", branch: "main" });
          return { data: { commit: { sha: branchSha } } };
        },
      },
      actions: {
        listWorkflowRuns: async (request) => {
          assert.equal(request.owner, "statewright");
          assert.equal(request.repo, "statewright");
          assert.equal(request.head_sha, SOURCE_SHA);
          assert.equal(request.status, "completed");
          return { data: { workflow_runs: runs[request.workflow_id] ?? [] } };
        },
        listJobsForWorkflowRun: async (request) => {
          assert.equal(request.owner, "statewright");
          assert.equal(request.repo, "statewright");
          return { data: { jobs: jobs[request.run_id] ?? [] } };
        },
      },
    },
  };
}

function successfulJobs() {
  const jobs = {
    11: REQUIRED_WORKFLOWS[0].requiredJobs.map((name) => ({
      name,
      conclusion: "success",
      steps: [{ name: "Submit plugin adoption telemetry event", conclusion: "success" }],
    })),
    12: [{
      name: "Codex and Claude managed-client bootstrap",
      conclusion: "success",
      steps: [
        { name: "Run managed-client bootstrap canary", conclusion: "success" },
        { name: "Run managed-client route canary", conclusion: "success" },
        { name: "Prove secretless browser onboarding", conclusion: "success" },
        { name: "Run authenticated production gateway canary", conclusion: "success" },
        { name: "Submit Codex adoption telemetry event", conclusion: "success" },
        { name: "Submit Claude adoption telemetry event", conclusion: "success" },
      ],
    }],
    13: [{ name: "Plugin contract matrix", conclusion: "success", steps: [] }],
  };
  for (const [runId, entries] of Object.entries(jobs)) {
    for (const job of entries) {
      Object.assign(job, { run_id: Number(runId), run_attempt: 1, head_sha: SOURCE_SHA, status: "completed" });
      for (const step of job.steps) step.status = "completed";
    }
  }
  return jobs;
}

function successfulRuns(event = "push") {
  const runs = {
    "plugin-production-canary.yml": [{ id: 11, event, conclusion: "success", html_url: "https://example.test/unix" }],
    "windows-plugin-canary.yml": [{ id: 12, event, conclusion: "success", html_url: "https://example.test/windows" }],
    "ci.yml": [{ id: 13, event, conclusion: "success", html_url: "https://example.test/ci" }],
  };
  for (const [workflow, entries] of Object.entries(runs)) {
    for (const run of entries) Object.assign(run, {
      head_sha: SOURCE_SHA, head_branch: "main", status: "completed", run_attempt: 1,
      path: `.github/workflows/${workflow}`,
      repository: { full_name: "statewright/statewright" },
      head_repository: { full_name: "statewright/statewright" },
    });
  }
  return runs;
}

test("release tests install shared executor dependencies before exercising Desktop fixtures", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/plugin-release.yml"), "utf8");
  const packageJob = workflow.split("\n  package:\n")[1].split("\n  artifact-smoke:\n")[0];
  const install = packageJob.indexOf("npm ci --ignore-scripts --prefix plugins/executor");
  assert.ok(install >= 0, "Desktop fixture imports resolve shared executor dependencies");
  assert.ok(install < packageJob.indexOf("name: Run plugin contract tests"));
});

test("local release gate checks every generated runtime before executing canaries", async () => {
  const taskfile = await readFile(resolve(root, "Taskfile.yml"), "utf8");
  const gate = taskfile.split("\n  test:plugin-release:")[1].split("\n  test:tool-policy:")[0];
  const firstCanary = gate.indexOf("node --check plugins/executor/tests/unix-plugin-live-gateway-canary.mjs");
  for (const script of [
    "plugins/executor/scripts/sync-error-reporting.mjs",
    "plugins/codex/scripts/sync-executor-core.mjs",
    "plugins/claude-code/scripts/sync-managed-client.mjs",
    "plugins/codex/scripts/sync-desktop-runtime.mjs",
  ]) {
    const check = gate.indexOf(`node ${script} --check`);
    assert.ok(check >= 0 && check < firstCanary, `${script} must be checked before canaries`);
  }
});

test("plugin release and canary gates retain the full matrix on supported macOS runners", async () => {
  const expectedJobs = ["codex", "claude", "cursor", "pi", "opencode", "omx"].flatMap(
    plugin => ["ubuntu-24.04", "macos-15"].map(os => `${plugin} on ${os}`),
  );
  assert.deepEqual(REQUIRED_WORKFLOWS[0].requiredJobs, expectedJobs);
  assert.equal(REQUIRED_WORKFLOWS[0].requiredSteps.length, 12);
  for (const file of ["plugin-release.yml", "plugin-production-canary.yml", "plugin-version-canary.yml"]) {
    const workflow = await readFile(resolve(root, ".github/workflows", file), "utf8");
    assert.doesNotMatch(workflow, /macos-14/);
    assert.match(workflow, /os: \[ubuntu-24\.04, macos-15\]/);
  }
  const release = await readFile(resolve(root, ".github/workflows/plugin-release.yml"), "utf8");
  assert.match(release, /os: macos-15\n\s+target: aarch64-apple-darwin/);
  assert.match(release, /runs-on: macos-15/);
});

test("Windows native lifecycle repetitions fail on the first unsuccessful cleanup", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/windows-plugin-canary.yml"), "utf8");
  const canary = workflow.split("name: Run managed Codex App Server approval protocol canary")[1].split("name: Run managed ownership race canary")[0];
  assert.match(canary, /timeout-minutes: 3/);
  assert.match(canary, /foreach \(\$attempt in 1\.\.5\)/);
  assert.match(canary, /node plugins\/executor\/tests\/windows-managed-app-server-canary\.mjs\n\s+if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/);
  const source = await readFile(resolve(root, "plugins/executor/tests/windows-managed-app-server-canary.mjs"), "utf8");
  assert.ok(source.lastIndexOf('outcome: "pass"') > source.indexOf("await runtime?.close()"));
  assert.ok(source.lastIndexOf('outcome: "pass"') > source.indexOf("await rm(home"));
});

test("Claude's skipped Desktop build cannot skip downstream smoke or weaken publish gates", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/plugin-release.yml"), "utf8");
  const packageJob = workflow.split("\n  package:\n")[1].split("\n  artifact-smoke:\n")[0];
  const smoke = workflow.split("\n  artifact-smoke:\n")[1].split("\n  publish:\n")[0];
  const publish = workflow.split("\n  publish:\n")[1];
  assert.match(packageJob, /^\s+needs: \[credential-helper, native-desktop-launcher\]\n\s+if: \$\{\{ !cancelled\(\) && needs\.credential-helper\.result == 'success' && \(startsWith\(github\.ref_name, 'claude-v'\) \|\| needs\.native-desktop-launcher\.result == 'success'\) \}\}\n/);
  assert.match(smoke, /^\s+needs: package\n\s+if: \$\{\{ !cancelled\(\) && needs\.package\.result == 'success' \}\}\n/);
  assert.match(publish, /^\s+needs: \[package, artifact-smoke\]\n\s+if: \$\{\{ !cancelled\(\) && needs\.package\.result == 'success' && needs\['artifact-smoke'\]\.result == 'success' \}\}\n/);
  assert.doesNotMatch(packageJob + smoke + publish, /continue-on-error|^    if: .*always\(\)/m);
});

test("plugin release workflow resolves distinct names and curated notes", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/plugin-release.yml"), "utf8");
  const unixCanary = await readFile(
    resolve(root, ".github/workflows/plugin-production-canary.yml"),
    "utf8",
  );
  const versionCanary = await readFile(
    resolve(root, ".github/workflows/plugin-version-canary.yml"),
    "utf8",
  );
  const windowsCanary = await readFile(
    resolve(root, ".github/workflows/windows-plugin-canary.yml"),
    "utf8",
  );
  const ci = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const windowsRouteCanary = await readFile(
    resolve(root, "plugins/executor/tests/windows-managed-client-route-canary.mjs"),
    "utf8",
  );
  const codexProxy = await readFile(resolve(root, "plugins/codex/mcp-proxy.sh"), "utf8");
  const codexHook = await readFile(resolve(root, "plugins/codex/hook.sh"), "utf8");
  const claudeHook = await readFile(resolve(root, "plugins/claude-code/hook.sh"), "utf8");
  const codexManifest = JSON.parse(
    await readFile(resolve(root, "plugins/codex/.codex-plugin/plugin.json"), "utf8"),
  );
  const claudeManifest = JSON.parse(
    await readFile(resolve(root, "plugins/claude-code/plugin.json"), "utf8"),
  );
  const codexVersion = codexManifest.version.split("+")[0];
  const claudeVersion = claudeManifest.version;

  await readFile(resolve(root, `docs/releases/codex-${codexVersion}.md`), "utf8");
  await readFile(resolve(root, `docs/releases/claude-${claudeVersion}.md`), "utf8");

  assert.match(workflow, /release_name=Statewright Codex plugin \$version/);
  assert.match(workflow, /release_name=Statewright Claude Code plugin \$version/);
  assert.match(workflow, /notes_path=docs\/releases\/codex-\$version\.md/);
  assert.match(workflow, /notes_path=docs\/releases\/claude-\$version\.md/);
  assert.match(workflow, /body_path: "\${{ needs\.package\.outputs\.notes_path }}"/);
  assert.doesNotMatch(workflow, /generate_release_notes:/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /require\("\.\/\.github\/scripts\/require-plugin-canaries\.cjs"\)/);
  assert.match(workflow, /await requirePluginCanaries\(/);
  assert.match(workflow, /artifact-smoke:\n\s+needs: package/);
  assert.match(workflow, /credential-helper:\n/);
  assert.match(workflow, /statewright-credentials-linux-x64/);
  assert.match(workflow, /statewright-credentials-darwin-arm64/);
  assert.match(workflow, /statewright-credentials-windows-x64\.exe/);
  assert.match(workflow, /cargo test --target "\$\{\{ matrix\.target \}\}" -p statewright-credentials/);
  assert.match(workflow, /pattern: credential-helper-\*/);
  assert.match(workflow, /name: Smoke packaged plugin against production/);
  assert.match(workflow, /name: Build native Desktop launcher/);
  assert.match(workflow, /platform: darwin-x64/);
  assert.match(workflow, /platform: darwin-arm64/);
  assert.match(workflow, /plugins\/codex\/native\/\$platform\/statewright-native-desktop-launcher/);
  assert.match(workflow, /name: Verify packaged native Desktop launchers/);
  assert.match(workflow, /name: Submit packaged plugin adoption telemetry event/);
  assert.match(workflow, /uses: actions\/attest@v4/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /STATEWRIGHT_PLUGIN_ROOT: \${{ runner\.temp }}\/plugin-candidate/);
  assert.match(workflow, /publish:\n\s+needs: \[package, artifact-smoke\]/);
  assert.match(windowsCanary, /push:\n\s+branches: \[main\]/);
  assert.match(
    windowsCanary,
    /push:\n\s+branches: \[main\]\n\s+pull_request:/,
    "every main commit must produce trusted exact-SHA Windows evidence for the release gate",
  );
  assert.match(windowsCanary, /name: Run managed-client bootstrap canary\n\s+id: bootstrap\n\s+timeout-minutes: 3/);
  assert.match(windowsCanary, /name: Run managed-client route canary\n\s+id: route\n\s+timeout-minutes: 3/);
  assert.match(
    windowsCanary,
    /name: Prove secretless browser onboarding[\s\S]*STATEWRIGHT_API_KEY: ""[\s\S]*windows-plugin-browser-onboarding-canary\.mjs/,
  );
  assert.match(
    windowsCanary,
    /name: Run authenticated production gateway canary\n\s+id: production\n\s+if: github\.event_name != 'pull_request'/,
  );
  assert.ok(
    windowsCanary.indexOf("Prove secretless browser onboarding") <
      windowsCanary.indexOf("Run authenticated production gateway canary"),
    "secretless onboarding must run before the production secret enters a step environment",
  );
  assert.match(windowsCanary, /STATEWRIGHT_API_KEY: \$\{\{ secrets\.STATEWRIGHT_PLUGIN_CANARY_API_KEY \}\}/);
  assert.match(ci, /plugin-contracts:/);
  assert.match(ci, /name: Plugin contract matrix/);
  assert.match(ci, /task test:plugin-release/);
  assert.match(windowsCanary, /release_ref:/);
  assert.match(windowsCanary, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.match(unixCanary, /release_ref:/);
  assert.match(unixCanary, /plugin: \${{ fromJSON\(/);
  assert.match(unixCanary, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.match(unixCanary, /name: Submit plugin adoption telemetry event/);
  assert.match(unixCanary, /plugin-adoption-telemetry-canary\.mjs/);
  assert.doesNotMatch(unixCanary, /\bomp\b/);
  assert.match(versionCanary, /evidence_mode:/);
  assert.match(versionCanary, /release-artifact/);
  assert.match(versionCanary, /release_ref is not part of trusted main history/);
  assert.match(versionCanary, /name: Submit requested plugin adoption telemetry event/);
  assert.match(versionCanary, /codex:codex-v\*/);
  assert.match(versionCanary, /claude:claude-v\*/);
  assert.match(versionCanary, /gh attestation verify/);
  assert.match(
    versionCanary,
    /permissions:\n\s+attestations: read\n\s+contents: read/,
  );
  assert.match(versionCanary, /--signer-workflow/);
  assert.match(versionCanary, /--source-digest "\$SOURCE_SHA"/);
  assert.match(versionCanary, /--source-ref "refs\/tags\/\$RELEASE_REF"/);
  assert.match(versionCanary, /--deny-self-hosted-runners/);
  assert.doesNotMatch(versionCanary, /\bomp\b/);
  assert.match(windowsRouteCanary, /codex-root-session\.json/);
  assert.match(windowsRouteCanary, /root_session_id: "windows-route-session"/);
  assert.equal(
    codexProxy.match(/STATEWRIGHT_GATEWAY_URL="\$GW_URL"/g)?.length,
    2,
    "Codex collector identity and process must receive the selected Gateway URL",
  );
  assert.match(codexHook, /AUTHORITATIVE_EPOCH=.*\.state_epoch/);
  assert.match(codexHook, /emit_native_telemetry "state_boundary" "\$STATE_JSON"/);
  assert.match(claudeHook, /AUTHORITATIVE_EPOCH=.*\.state_epoch/);
});

test("hosted plugin contracts expose installed Task to nested adapter tests", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /go install github\.com\/go-task\/task\/v3\/cmd\/task@v3\.39\.2/);
  assert.match(workflow, /echo "\$\(go env GOPATH\)\/bin" >> "\$GITHUB_PATH"/);
  assert.match(workflow, /task test:plugin-release/);
});

test("Windows secretless onboarding uses a built native credential helper", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/windows-plugin-canary.yml"), "utf8");
  const build = workflow.indexOf("cargo build --locked -p statewright-credentials");
  const onboarding = workflow.indexOf("name: Prove secretless browser onboarding");
  assert.ok(build >= 0 && build < onboarding, "missing helper must not masquerade as missing credentials");
  assert.match(workflow.slice(onboarding), /STATEWRIGHT_CREDENTIAL_HELPER: \$\{\{ github\.workspace \}\}\/target\/debug\/statewright-credentials\.exe/);
  assert.match(workflow.slice(onboarding), /timeout-minutes: 2/);
});

test("workspace CI and release builds install the Linux credential helper prerequisites", async () => {
  for (const [file, buildStep] of [
    ["ci.yml", "cargo check --workspace"],
    ["plugin-release.yml", "cargo test --target"],
  ]) {
    const workflow = await readFile(resolve(root, ".github/workflows", file), "utf8");
    const install = "sudo apt-get update && sudo apt-get install -y libdbus-1-dev pkg-config";
    assert.ok(workflow.includes(install), `${file} must install Secret Service build headers`);
    assert.ok(workflow.indexOf(install) < workflow.indexOf(buildStep), `${file} must install headers before compiling`);
  }
});

test("release gate accepts successful exact-commit hosted canaries", async () => {
  const messages = [];
  const evidence = await requirePluginCanaries({
    github: githubClient({ runs: successfulRuns() }),
    context: { repo: { owner: "statewright", repo: "statewright" } },
    core: { info: (message) => messages.push(message) },
    sourceSha: SOURCE_SHA,
  });
  assert.deepEqual(evidence.map((item) => item.runId), [11, 12, 13]);
  assert.equal(messages.length, 3);
});

function receiptEnv(workflow = REQUIRED_WORKFLOWS[1].workflowId, jobName = REQUIRED_WORKFLOWS[1].requiredJobs[0]) {
  const contract = receiptContract(workflow, jobName);
  return {
    GITHUB_REPOSITORY: "statewright/statewright", GITHUB_SHA: SOURCE_SHA,
    GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_JOB: contract.jobKey,
    GITHUB_WORKFLOW_REF: `statewright/statewright/.github/workflows/${workflow}@refs/heads/main`,
    GITHUB_RUN_ID: workflow === "windows-plugin-canary.yml" ? "12" : "11", GITHUB_RUN_ATTEMPT: "1",
    CANARY_WORKFLOW: workflow, CANARY_JOB_NAME: jobName, CANARY_SOURCE_SHA: SOURCE_SHA,
    CANARY_STEPS: JSON.stringify(Object.fromEntries(Object.keys(contract.steps).map(id => [id, {
      outcome: "success", conclusion: "success", outputs: { private: "never serialize step outputs" },
    }]))),
  };
}

function zipReceipt(receipt, member = "canary-steps.json") {
  const directory = mkdtempSync(join(tmpdir(), "canary-receipt-test-"));
  try {
    writeFileSync(join(directory, member), JSON.stringify(receipt));
    execFileSync("zip", ["-q", "receipt.zip", member], { cwd: directory });
    return readFileSync(join(directory, "receipt.zip"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function receiptFixture({ receipt = makeReceipt(receiptEnv()), artifactOverride = {}, bytes = zipReceipt(receipt) } = {}) {
  const artifact = {
    id: 123, name: artifactName(receipt.workflow, receipt.jobName, receipt.attempt), expired: false,
    size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    workflow_run: { id: receipt.runId, head_sha: SOURCE_SHA, head_branch: "main" }, ...artifactOverride,
  };
  return { bytes, artifact };
}

function attachArtifacts(github, fixtures) {
  github.rest.actions.listWorkflowRunArtifacts = async request => {
    assert.equal(request.owner, "statewright"); assert.equal(request.repo, "statewright");
    return { data: { artifacts: fixtures.filter(f => f.artifact.name === request.name).map(f => f.artifact) } };
  };
  github.rest.actions.downloadArtifact = async request => {
    assert.equal(request.archive_format, "zip");
    return { data: fixtures.find(f => f.artifact.id === request.artifact_id).bytes };
  };
  return github;
}

test("runner receipt records required outcomes only and rejects skipped/failed/continued steps", () => {
  const receipt = makeReceipt(receiptEnv());
  assert.equal(receipt.steps.length, 6);
  assert.doesNotMatch(JSON.stringify(receipt), /never serialize|outputs|private/);
  for (const outcome of ["failure", "cancelled", "skipped", undefined]) {
    const env = receiptEnv(); const steps = JSON.parse(env.CANARY_STEPS);
    steps.bootstrap.outcome = outcome;
    assert.throws(() => makeReceipt({ ...env, CANARY_STEPS: JSON.stringify(steps) }), /did not succeed/);
  }
  for (const [key, value] of Object.entries({
    GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/heads/feature", GITHUB_SHA: "bad",
    CANARY_SOURCE_SHA: "f".repeat(40), GITHUB_WORKFLOW_REF: "untrusted", GITHUB_JOB: "other",
    GITHUB_RUN_ATTEMPT: "0", GITHUB_RUN_ID: "NaN",
  })) assert.throws(() => makeReceipt({ ...receiptEnv(), [key]: value }), undefined, key);
});

test("receipt writer CLI emits native-shaped context without including outputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "canary-writer-test-"));
  try {
    execFileSync(process.execPath, [resolve(root, ".github/scripts/canary-step-receipt.cjs")], {
      cwd: directory, env: receiptEnv(),
    });
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "canary-steps.json"))), makeReceipt(receiptEnv()));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("release gate recovers empty API steps from exact-source digest-checked runner receipts", async () => {
  const jobs = successfulJobs(); const fixtures = [];
  for (const [index, requirement] of REQUIRED_WORKFLOWS.slice(0, 2).entries()) {
    for (const job of jobs[index + 11]) {
      job.steps = [];
      const receipt = makeReceipt(receiptEnv(requirement.workflowId, job.name));
      fixtures.push(receiptFixture({ receipt, artifactOverride: { id: fixtures.length + 1 } }));
    }
  }
  const evidence = await requirePluginCanaries({
    github: attachArtifacts(githubClient({ jobs, runs: successfulRuns() }), fixtures),
    context: { repo: { owner: "statewright", repo: "statewright" } }, core: { info() {} }, sourceSha: SOURCE_SHA,
  });
  assert.equal(evidence[0].receipts.length, 12);
  assert.equal(evidence[1].receipts.length, 1);
  assert.match(evidence[1].receipts[0].digest, /^sha256:/);
});

test("receipt reader rejects wrong identity, replay, missing, duplicate and failed step evidence", async () => {
  const base = makeReceipt(receiptEnv());
  const changes = [
    ...Object.entries({ schema: "v0", repository: "other/repo", sourceSha: "f".repeat(40), event: "pull_request",
      ref: "refs/heads/other", workflowRef: "other", runId: 999, attempt: 2, jobKey: "other" })
      .map(([key, value]) => r => { r[key] = value; }),
    r => { r.steps = []; }, r => { r.steps[0].outcome = "failure"; },
    r => { r.steps[0].conclusion = "skipped"; }, r => { r.steps[0].id = "other"; },
    r => { r.steps[0].name = "other"; }, r => { r.steps[1] = r.steps[0]; },
  ];
  for (const change of changes) {
    const receipt = structuredClone(base); change(receipt);
    const fixture = receiptFixture({ bytes: zipReceipt(receipt) });
    const github = attachArtifacts(githubClient(), [fixture]);
    await assert.rejects(readCanaryReceipt({ github, context: { repo: { owner: "statewright", repo: "statewright" } },
      requirement: REQUIRED_WORKFLOWS[1], run: successfulRuns()["windows-plugin-canary.yml"][0],
      job: successfulJobs()[12][0], sourceSha: SOURCE_SHA }), /mismatch|lacks successful/);
  }
});

test("receipt reader fails closed on missing, ambiguous, expired or mismatched artifacts", async () => {
  const fixture = receiptFixture();
  const sets = [[], [fixture, fixture], ...[
    { expired: true }, { size_in_bytes: 1000000 }, { digest: "sha256:" + "0".repeat(64) },
    { workflow_run: { id: 999, head_sha: SOURCE_SHA, head_branch: "main" } },
    { workflow_run: { id: 12, head_sha: "f".repeat(40), head_branch: "main" } },
  ].map(override => [{ ...fixture, artifact: { ...fixture.artifact, ...override } }])];
  for (const fixtures of sets) await assert.rejects(readCanaryReceipt({
    github: attachArtifacts(githubClient(), fixtures), context: { repo: { owner: "statewright", repo: "statewright" } },
    requirement: REQUIRED_WORKFLOWS[1], run: successfulRuns()["windows-plugin-canary.yml"][0],
    job: successfulJobs()[12][0], sourceSha: SOURCE_SHA,
  }));
});

test("receipt recovery respects retained successful job attempts on a partial rerun", async () => {
  const fixture = receiptFixture();
  const run = { ...successfulRuns()["windows-plugin-canary.yml"][0], run_attempt: 2 };
  const args = { github: attachArtifacts(githubClient(), [fixture]),
    context: { repo: { owner: "statewright", repo: "statewright" } }, requirement: REQUIRED_WORKFLOWS[1],
    run, job: successfulJobs()[12][0], sourceSha: SOURCE_SHA };
  assert.equal((await readCanaryReceipt(args)).attempt, 1);
  await assert.rejects(readCanaryReceipt({ ...args, job: { ...args.job, run_attempt: 2 } }), /missing/);
  for (const override of [{ run_id: 999 }, { head_sha: "f".repeat(40) }, { run_attempt: 3 }, { run_attempt: 0 }]) {
    await assert.rejects(readCanaryReceipt({ ...args, job: { ...args.job, ...override } }), /mismatch/);
  }
});

test("artifact service errors cannot turn missing step evidence into acceptance", async () => {
  const github = attachArtifacts(githubClient(), [receiptFixture()]);
  github.rest.actions.downloadArtifact = async () => { throw new Error("artifact service unavailable"); };
  await assert.rejects(readCanaryReceipt({ github,
    context: { repo: { owner: "statewright", repo: "statewright" } }, requirement: REQUIRED_WORKFLOWS[1],
    run: successfulRuns()["windows-plugin-canary.yml"][0], job: successfulJobs()[12][0], sourceSha: SOURCE_SHA,
  }), /artifact service unavailable/);
});

test("release gate rejects ambiguous jobs and missing rather than empty step fields", async () => {
  for (const mutate of [jobs => jobs[11].push(jobs[11][0]), jobs => { delete jobs[11][0].steps; }]) {
    const jobs = successfulJobs(); mutate(jobs);
    const github = githubClient({ jobs, runs: successfulRuns() });
    github.rest.actions.listWorkflowRunArtifacts = () => assert.fail("ambiguous evidence is not an omission");
    await assert.rejects(requirePluginCanaries({ github,
      context: { repo: { owner: "statewright", repo: "statewright" } }, core: { info() {} }, sourceSha: SOURCE_SHA,
    }), /lacks successful/);
  }
});

test("archive decoder refuses malformed, unexpected and oversized payloads", () => {
  for (const bytes of [Buffer.from("not a zip"), zipReceipt({}, "other.json"), zipReceipt({ text: "x".repeat(100000) })]) {
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert.throws(() => decodeReceiptArchive(bytes, digest));
  }
});

test("nonempty API failure or partial evidence never falls back to artifacts", async () => {
  for (const steps of [[{ name: "unrelated", status: "completed", conclusion: "success" }],
    [{ name: "Submit plugin adoption telemetry event", status: "completed", conclusion: "failure" }]]) {
    const jobs = successfulJobs(); jobs[11][0].steps = steps;
    const github = githubClient({ jobs, runs: successfulRuns() });
    github.rest.actions.listWorkflowRunArtifacts = () => assert.fail("must not override API evidence");
    await assert.rejects(requirePluginCanaries({ github,
      context: { repo: { owner: "statewright", repo: "statewright" } }, core: { info() {} }, sourceSha: SOURCE_SHA,
    }), /lacks successful step/);
  }
});

test("release gate revalidates returned run identity instead of trusting API query filters", async () => {
  for (const [key, value] of Object.entries({ head_sha: "f".repeat(40), head_branch: "other", status: "in_progress",
    path: ".github/workflows/untrusted.yml", head_repository: { full_name: "fork/repo" }, run_attempt: 0 })) {
    const runs = successfulRuns(); runs["windows-plugin-canary.yml"][0][key] = value;
    await assert.rejects(requirePluginCanaries({ github: githubClient({ runs }),
      context: { repo: { owner: "statewright", repo: "statewright" } }, core: { info() {} }, sourceSha: SOURCE_SHA,
    }), /no successful trusted push run/);
  }
});

test("both canary workflows bind runner step IDs and immutable receipts to each matrix attempt", async () => {
  for (const requirement of REQUIRED_WORKFLOWS.slice(0, 2)) {
    const workflow = await readFile(resolve(root, ".github/workflows", requirement.workflowId), "utf8");
    const contract = receiptContract(requirement.workflowId, requirement.requiredJobs[0]);
    const parsed = parseYaml(workflow);
    const steps = parsed.jobs[contract.jobKey].steps;
    const producer = steps.findIndex(step => step.name === "Record required step outcomes");
    assert.equal(steps[producer].run, "node .github/scripts/canary-step-receipt.cjs");
    assert.equal(steps[producer].env.CANARY_WORKFLOW, requirement.workflowId);
    for (const [id, name] of Object.entries(contract.steps)) {
      assert.ok(workflow.includes(`name: ${name}\n        id: ${id}\n`));
      const matches = steps.filter(step => step.id === id);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].name, name);
      assert.ok(steps.indexOf(matches[0]) < producer);
      assert.notEqual(matches[0]["continue-on-error"], true);
    }
    assert.equal(steps[producer + 1].uses, "actions/upload-artifact@v4");
    assert.equal(steps[producer + 1].with.path, "canary-steps.json");
    assert.equal(steps[producer + 1].with["if-no-files-found"], "error");
    assert.match(workflow, /CANARY_STEPS: \$\{\{ toJSON\(steps\) \}\}/);
    assert.match(workflow, /CANARY_SOURCE_SHA: \$\{\{ steps\.source\.outputs\.sha \}\}/);
    assert.match(workflow, /name: Record required step outcomes\n\s+if: github.event_name == 'push'/);
    assert.match(workflow, /uses: actions\/upload-artifact@v4/);
    assert.match(workflow, /-attempt-\$\{\{ github.run_attempt \}\}/);
    assert.doesNotMatch(workflow, /overwrite: true|continue-on-error: true/);
  }
});

test("release gate rejects a tag that is not current main", async () => {
  await assert.rejects(
    requirePluginCanaries({
      github: githubClient({ branchSha: "ffffffffffffffffffffffffffffffffffffffff" }),
      context: { repo: { owner: "statewright", repo: "statewright" } },
      core: { info() {} },
      sourceSha: SOURCE_SHA,
    }),
    /is not current main/,
  );
});

test("release gate rejects missing, failed, and pull-request-only evidence", async () => {
  for (const windowsRuns of [
    [],
    [{ id: 12, event: "push", conclusion: "failure", html_url: "https://example.test/windows" }],
    [{ id: 12, event: "pull_request", conclusion: "success", html_url: "https://example.test/windows" }],
  ]) {
    const runs = successfulRuns();
    runs["windows-plugin-canary.yml"] = windowsRuns;
    await assert.rejects(
      requirePluginCanaries({
        github: githubClient({ runs }),
        context: { repo: { owner: "statewright", repo: "statewright" } },
        core: { info() {} },
        sourceSha: SOURCE_SHA,
      }),
      /Windows production\/bootstrap has no successful trusted push run/,
    );
  }
});

test("release gate rejects a false-green Unix matrix with a missing job", async () => {
  const jobs = successfulJobs();
  jobs[11] = jobs[11].slice(1);
  await assert.rejects(
    requirePluginCanaries({
      github: githubClient({ jobs, runs: successfulRuns() }),
      context: { repo: { owner: "statewright", repo: "statewright" } },
      core: { info() {} },
      sourceSha: SOURCE_SHA,
    }),
    /lacks successful job codex on ubuntu-24\.04/,
  );
});

test("release gate rejects a skipped Windows production step", async () => {
  const jobs = successfulJobs();
  jobs[12][0].steps[3].conclusion = "skipped";
  await assert.rejects(
    requirePluginCanaries({
      github: githubClient({ jobs, runs: successfulRuns() }),
      context: { repo: { owner: "statewright", repo: "statewright" } },
      core: { info() {} },
      sourceSha: SOURCE_SHA,
    }),
    /lacks successful step Run authenticated production gateway canary/,
  );
});

test("release gate rejects a Unix matrix job without a telemetry acknowledgement", async () => {
  const jobs = successfulJobs();
  jobs[11][0].steps[0].conclusion = "skipped";
  await assert.rejects(
    requirePluginCanaries({
      github: githubClient({ jobs, runs: successfulRuns() }),
      context: { repo: { owner: "statewright", repo: "statewright" } },
      core: { info() {} },
      sourceSha: SOURCE_SHA,
    }),
    /lacks successful step Submit plugin adoption telemetry event/,
  );
});

test("release gate rejects a skipped Windows secretless onboarding step", async () => {
  const jobs = successfulJobs();
  jobs[12][0].steps[2].conclusion = "skipped";
  await assert.rejects(
    requirePluginCanaries({
      github: githubClient({ jobs, runs: successfulRuns() }),
      context: { repo: { owner: "statewright", repo: "statewright" } },
      core: { info() {} },
      sourceSha: SOURCE_SHA,
    }),
    /lacks successful step Prove secretless browser onboarding/,
  );
});

test("release gate rejects an earlier failed Windows native command even when a later step succeeds", async () => {
  for (const failedStep of [
    "Run managed-client bootstrap canary",
    "Submit Codex adoption telemetry event",
  ]) {
    const jobs = successfulJobs();
    jobs[12][0].steps.find((step) => step.name === failedStep).conclusion = "failure";
    await assert.rejects(
      requirePluginCanaries({
        github: githubClient({ jobs, runs: successfulRuns() }),
        context: { repo: { owner: "statewright", repo: "statewright" } },
        core: { info() {} },
        sourceSha: SOURCE_SHA,
      }),
      new RegExp(`lacks successful step ${failedStep}`),
    );
  }
});

test("release gate ignores a newer incomplete push when complete evidence exists", async () => {
  const runs = successfulRuns();
  runs["plugin-production-canary.yml"] = [
    { ...runs["plugin-production-canary.yml"][0], id: 14, html_url: "https://example.test/partial" },
    ...runs["plugin-production-canary.yml"],
  ];
  const jobs = successfulJobs();
  jobs[14] = jobs[11].slice(0, 1).map(job => ({ ...job, run_id: 14 }));
  const evidence = await requirePluginCanaries({
    github: githubClient({ jobs, runs }),
    context: { repo: { owner: "statewright", repo: "statewright" } },
    core: { info() {} },
    sourceSha: SOURCE_SHA,
  });
  assert.equal(evidence[0].runId, 11);
});

test("release gate never treats manual dispatches as release evidence", async () => {
  await assert.rejects(
    requirePluginCanaries({
      github: githubClient({ runs: successfulRuns("workflow_dispatch") }),
      context: { repo: { owner: "statewright", repo: "statewright" } },
      core: { info() {} },
      sourceSha: SOURCE_SHA,
    }),
    /no successful trusted push run/,
  );
});

test("self-hosted telemetry projections are tenant-bound and monotonic", async () => {
  const hook = await readFile(
    resolve(root, "self-hosted/pocketbase/pb_hooks/gateway.pb.js"),
    "utf8",
  );
  const migration = await readFile(
    resolve(
      root,
      "self-hosted/pocketbase/pb_migrations/007_bind_telemetry_runs_and_sequences.js",
    ),
    "utf8",
  );
  const sourceMigration = await readFile(
    resolve(
      root,
      "self-hosted/pocketbase/pb_migrations/008_add_usage_event_source.js",
    ),
    "utf8",
  );

  assert.match(hook, /external_run_id = \{:run\} && api_key_fingerprint = \{:fingerprint\}/);
  assert.match(hook, /session_id = \{:session\} && api_key_fingerprint = \{:fingerprint\}/);
  assert.match(hook, /Workflow run belongs to another API key/);
  assert.doesNotMatch(hook, /existing\.set\('session_id'/);
  assert.match(hook, /sequence <= telemetryNumber\(cursors\[channel\]\)/);
  assert.match(hook, /telemetryPrecisionRank\(precision\) > telemetryPrecisionRank\(priorPrecision\)/);
  assert.match(hook, /runInTransaction/);
  assert.match(hook, /telemetryHas\(budget, 'tool_result_bytes'\)/);
  assert.match(hook, /STATE_EPOCH_MISMATCH/);
  assert.match(hook, /STALE_SEQUENCE/);
  assert.match(hook, /telemetrySafeCount\(usage\[field\]\)/);
  assert.match(hook, /error: 'stale_sequence'/);
  assert.match(hook, /Invalid telemetry event identity or state budget/);
  assert.match(hook, /accepted_event_ids/);
  assert.match(hook, /duplicate_event_ids/);
  assert.match(migration, /api_key_fingerprint/);
  assert.match(migration, /telemetry_ownership_status/);
  assert.match(migration, /owners\.length > 1/);
  assert.match(migration, /sequence_cursors/);
  assert.match(migration, /idx_usage_event_owner/);
  assert.match(sourceMigration, /idx_usage_event_run_epoch_source_sequence/);
  assert.match(hook, /source = \{:source\}/);
});
