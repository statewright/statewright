import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const { REQUIRED_WORKFLOWS, requirePluginCanaries } = require(
  resolve(root, ".github/scripts/require-plugin-canaries.cjs"),
);
const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

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
  return {
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
}

function successfulRuns(event = "push") {
  return {
    "plugin-production-canary.yml": [{ id: 11, event, conclusion: "success", html_url: "https://example.test/unix" }],
    "windows-plugin-canary.yml": [{ id: 12, event, conclusion: "success", html_url: "https://example.test/windows" }],
    "ci.yml": [{ id: 13, event, conclusion: "success", html_url: "https://example.test/ci" }],
  };
}

test("release tests install shared executor dependencies before exercising Desktop fixtures", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/plugin-release.yml"), "utf8");
  const packageJob = workflow.split("\n  package:\n")[1].split("\n  artifact-smoke:\n")[0];
  const install = packageJob.indexOf("npm ci --ignore-scripts --prefix plugins/executor");
  assert.ok(install >= 0, "Desktop fixture imports resolve shared executor dependencies");
  assert.ok(install < packageJob.indexOf("name: Run plugin contract tests"));
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
  assert.match(windowsCanary, /name: Run managed-client bootstrap canary\n\s+timeout-minutes: 3/);
  assert.match(windowsCanary, /name: Run managed-client route canary\n\s+timeout-minutes: 3/);
  assert.match(
    windowsCanary,
    /name: Prove secretless browser onboarding[\s\S]*STATEWRIGHT_API_KEY: ""[\s\S]*windows-plugin-browser-onboarding-canary\.mjs/,
  );
  assert.match(
    windowsCanary,
    /name: Run authenticated production gateway canary\n\s+if: github\.event_name != 'pull_request'/,
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
    { id: 14, event: "push", conclusion: "success", html_url: "https://example.test/partial" },
    ...runs["plugin-production-canary.yml"],
  ];
  const jobs = successfulJobs();
  jobs[14] = jobs[11].slice(0, 1);
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
