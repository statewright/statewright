import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

function runProxy(proxy, environment) {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "statewright_get_state", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "statewright_connect", arguments: {} } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "statewright_list_workflows", arguments: {} } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "statewright_search_docs", arguments: {} } },
  ];
  return runProxyRequests(proxy, environment, requests);
}

function runProxyRequests(proxy, environment, requests) {
  const input = requests.map(JSON.stringify).join("\n") + "\n";
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn("bash", [proxy], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectResult);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function responseById(stdout, id) {
  return stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)).find((response) => response.id === id);
}

const legacyProxies = [
  ["claude", resolve("plugins/claude-code/mcp-proxy.sh")],
  ["cursor", resolve("plugins/cursor/mcp-proxy.sh")],
];

async function waitForOutput(readOutput, pattern, timeoutMs = 2_000) {
  const started = Date.now();
  while (!pattern.test(await readOutput())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for proxy output matching ${pattern}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

test("codex exposes only safe setup tools and opens device approval on explicit connect", async () => {
  const name = "codex";
  const proxy = resolve("plugins/codex/mcp-proxy.sh");
    const root = await mkdtemp(join(tmpdir(), `statewright-${name}-browser-test-`));
    const home = join(root, "home");
    const bin = join(root, "bin");
    const capture = join(root, "browser-command.txt");
    try {
      await mkdir(bin, { recursive: true });
      const fakePowerShell = join(bin, "powershell.exe");
      await writeFile(fakePowerShell, "#!/usr/bin/env bash\nexit 99\n");
      await chmod(fakePowerShell, 0o755);
      const fakeSleep = join(bin, "sleep");
      await writeFile(fakeSleep, "#!/usr/bin/env bash\nexit 0\n");
      await chmod(fakeSleep, 0o755);
      const fakeCurl = join(bin, "curl");
      await writeFile(fakeCurl, `#!/usr/bin/env bash
output=''
url=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '-o' ]; then output="$argument"; fi
  case "$argument" in http://*|https://*) url="$argument" ;; esac
  previous="$argument"
done
case "$url" in
  */api/oauth/device/code)
    printf '%s' '{"device_code":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","user_code":"BCDF-GHJK-MNPQ","verification_uri":"https://statewright.ai/device","verification_uri_complete":"https://statewright.ai/device?user_code=BCDF-GHJK-MNPQ","expires_in":600,"interval":5}' > "$output"
    printf '200'
    ;;
  */api/oauth/device/token)
    printf '%s' '{"error":"access_denied"}' > "$output"
    printf '400'
    ;;
  *) exit 1 ;;
esac
`);
      await chmod(fakeCurl, 0o755);
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("statewright_")),
      );
      Object.assign(environment, {
        HOME: home,
        OS: "Windows_NT",
        PATH: `${bin}${delimiter}${environment.PATH ?? ""}`,
        STATEWRIGHT_BROWSER_OPEN_CAPTURE_PATH: capture,
        STATEWRIGHT_NO_UPDATE_CHECK: "1",
        STATEWRIGHT_SENTRY_DISABLED: "true",
      });

      const disabled = await runProxy(proxy, { ...environment, STATEWRIGHT_NO_BROWSER: "true" });
      assert.equal(disabled.code, 0, disabled.stderr);
      const disabledConnect = responseById(disabled.stdout, 4);
      assert.match(disabledConnect.result.content[0].text, /Open https:\/\/statewright\.ai\/device\?user_code=BCDF-GHJK-MNPQ/);
      assert.match(disabledConnect.result.content[0].text, /device code BCDF-GHJK-MNPQ/);
      await assert.rejects(readFile(join(home, ".statewright", "missing_api_key_prompted")));

      const result = await runProxy(proxy, environment);
      assert.equal(result.code, 0, result.stderr);
      const setupCatalog = responseById(result.stdout, 2);
      assert.deepEqual(setupCatalog.result.tools.map((tool) => tool.name), [
        "statewright_search_docs",
        "statewright_list_workflows",
        "statewright_connect",
      ]);
      const ordinaryCall = responseById(result.stdout, 3);
      assert.equal(ordinaryCall.error.code, -32001);
      assert.match(ordinaryCall.error.message, /Statewright is not connected/);
      const connect = responseById(result.stdout, 4);
      assert.match(connect.result.content[0].text, /Opened secure Statewright approval in your browser/);
      assert.match(connect.result.content[0].text, /device code BCDF-GHJK-MNPQ/);
      assert.match(connect.result.content[0].text, /do not paste an API key into chat/i);
      const workflowStatus = JSON.parse(responseById(result.stdout, 5).result.content[0].text);
      assert.deepEqual(workflowStatus, {
        connected: false,
        credential: "missing",
        workflows: [],
        active: null,
        reason: "No local Statewright credential is configured. Use statewright_connect for account setup.",
      });
      assert.match(responseById(result.stdout, 6).result.content[0].text, /Missing required parameter: query/);
      assert.deepEqual((await readFile(capture, "utf8")).trim().split(/\r?\n/), [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Process -FilePath 'https://statewright.ai/device?user_code=BCDF-GHJK-MNPQ'",
      ]);
      await assert.rejects(readFile(join(home, ".statewright", "missing_api_key_prompted")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
});

test("codex device approval verifies and atomically stores the returned Statewright key", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-codex-device-login-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const capture = join(root, "curl-command.txt");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("statewright_")),
  );
  const rawKey = `sw_live_${"a".repeat(32)}`;
  try {
    await mkdir(bin, { recursive: true });
    const fakeSleep = join(bin, "sleep");
    await writeFile(fakeSleep, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(fakeSleep, 0o755);
    const fakeCurl = join(bin, "curl");
    await writeFile(fakeCurl, `#!/usr/bin/env bash
output=''
url=''
previous=''
printf '%s\\n' "$@" >> "$STATEWRIGHT_CURL_CAPTURE"
for argument in "$@"; do
  if [ "$previous" = '-o' ]; then output="$argument"; fi
  case "$argument" in http://*|https://*) url="$argument" ;; esac
  previous="$argument"
done
case "$url" in
  */api/oauth/device/code)
    printf '%s' '{"device_code":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","user_code":"BCDF-GHJK-MNPQ","verification_uri":"https://statewright.ai/device","verification_uri_complete":"https://statewright.ai/device?user_code=BCDF-GHJK-MNPQ","expires_in":600,"interval":5}' > "$output"
    printf '200'
    ;;
  */api/oauth/device/token)
    printf '%s' '{"access_token":"${rawKey}","token_type":"Bearer","scope":"mcp"}' > "$output"
    printf '200'
    ;;
  */api/gateway/workflows)
    printf '%s' '{"default":"bugfix","workflows":{}}' > "$output"
    printf '200'
    ;;
  *) exit 1 ;;
esac
`);
    await chmod(fakeCurl, 0o755);
    Object.assign(environment, {
      HOME: home,
      PATH: `${bin}${delimiter}${environment.PATH ?? ""}`,
      STATEWRIGHT_CURL_CAPTURE: capture,
      STATEWRIGHT_NO_BROWSER: "true",
      STATEWRIGHT_NO_UPDATE_CHECK: "1",
      STATEWRIGHT_SENTRY_DISABLED: "true",
    });

    const result = await runProxyRequests(resolve("plugins/codex/mcp-proxy.sh"), environment, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "statewright_connect", arguments: {} } },
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(responseById(result.stdout, 2).result.content[0].text, /device code BCDF-GHJK-MNPQ/);

    const keyPath = join(home, ".statewright", "api_key");
    await waitForOutput(async () => {
      try { return await readFile(keyPath, "utf8"); } catch { return ""; }
    }, /sw_live_/);
    assert.equal(await readFile(keyPath, "utf8"), `${rawKey}\n`);
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    const curlArguments = await readFile(capture, "utf8");
    assert.match(curlArguments, /\/api\/oauth\/device\/code/);
    assert.match(curlArguments, /\/api\/oauth\/device\/token/);
    assert.match(curlArguments, /\/api\/gateway\/workflows/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex searches public docs without a local credential or gateway request", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-codex-public-docs-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const curlCapture = join(root, "curl-command.txt");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("statewright_")),
  );
  try {
    await mkdir(bin, { recursive: true });
    const fakeCurl = join(bin, "curl");
    await writeFile(
      fakeCurl,
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" >> \"$STATEWRIGHT_CURL_CAPTURE\"\nprintf '%s' '[{\"url\":\"/docs/workflows\",\"title\":\"Workflow Guide\",\"section\":\"Intro\",\"content\":\"Build workflows safely.\"}]'\n",
    );
    await chmod(fakeCurl, 0o755);
    Object.assign(environment, {
      HOME: home,
      PATH: `${bin}${delimiter}${environment.PATH ?? ""}`,
      STATEWRIGHT_CURL_CAPTURE: curlCapture,
      STATEWRIGHT_NO_BROWSER: "true",
      STATEWRIGHT_NO_UPDATE_CHECK: "1",
      STATEWRIGHT_SENTRY_DISABLED: "true",
    });
    const result = await runProxyRequests(resolve("plugins/codex/mcp-proxy.sh"), environment, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "statewright_search_docs", arguments: { query: "workflow" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "statewright_search_docs", arguments: { query: 'not "found' } } },
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(responseById(result.stdout, 2).result.content[0].text, /Workflow Guide/);
    assert.equal(responseById(result.stdout, 3).result.content[0].text, 'No results found for: not "found');
    const curlArguments = await readFile(curlCapture, "utf8");
    assert.match(curlArguments, /https:\/\/docs\.statewright\.ai\/search-index\.json/);
    assert.doesNotMatch(curlArguments, /Authorization:|mcp\.statewright\.ai/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, proxy] of legacyProxies) {
  test(`${name} preserves its existing Windows signup onboarding`, async () => {
    const root = await mkdtemp(join(tmpdir(), `statewright-${name}-browser-test-`));
    const home = join(root, "home");
    const bin = join(root, "bin");
    const capture = join(root, "browser-command.txt");
    try {
      await mkdir(bin, { recursive: true });
      const fakePowerShell = join(bin, "powershell.exe");
      await writeFile(fakePowerShell, "#!/usr/bin/env bash\nexit 99\n");
      await chmod(fakePowerShell, 0o755);
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("statewright_")),
      );
      Object.assign(environment, {
        HOME: home,
        OS: "Windows_NT",
        PATH: `${bin}${delimiter}${environment.PATH ?? ""}`,
        STATEWRIGHT_BROWSER_OPEN_CAPTURE_PATH: capture,
        STATEWRIGHT_NO_UPDATE_CHECK: "1",
        STATEWRIGHT_SENTRY_DISABLED: "true",
      });

      const result = await runProxy(proxy, environment);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Statewright API key not configured/);
      assert.deepEqual((await readFile(capture, "utf8")).trim().split(/\r?\n/), [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Process -FilePath 'https://statewright.ai/signup?redirect=%2Fkeys'",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("codex refreshes its catalog after a local credential is provisioned without restarting", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-codex-key-adoption-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const browserCapture = join(root, "browser-command.txt");
  const curlCapture = join(root, "curl-command.txt");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("statewright_")),
  );
  try {
    await mkdir(bin, { recursive: true });
    const fakeCurl = join(bin, "curl");
    await writeFile(
      fakeCurl,
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" >> \"$STATEWRIGHT_CURL_CAPTURE\"\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[{\"name\":\"statewright_get_state\"}]},\"id\":4}'\n",
    );
    await chmod(fakeCurl, 0o755);
    Object.assign(environment, {
      HOME: home,
      PATH: `${bin}${delimiter}${environment.PATH ?? ""}`,
      STATEWRIGHT_BROWSER_OPEN_CAPTURE_PATH: browserCapture,
      STATEWRIGHT_CURL_CAPTURE: curlCapture,
      STATEWRIGHT_NO_UPDATE_CHECK: "1",
      STATEWRIGHT_SENTRY_DISABLED: "true",
    });

    const child = spawn("bash", [resolve("plugins/codex/mcp-proxy.sh")], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await waitForOutput(() => stdout, /\"id\":1/);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    await waitForOutput(() => stdout, /\"id\":2/);
    assert.deepEqual(responseById(stdout, 2).result.tools.map((tool) => tool.name), [
      "statewright_search_docs",
      "statewright_list_workflows",
      "statewright_connect",
    ]);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "statewright_get_state", arguments: {} } })}\n`);
    await waitForOutput(() => stdout, /\"id\":3/);
    assert.equal(responseById(stdout, 3).error.code, -32001);
    await writeFile(join(home, ".statewright", "api_key"), "sw_live_new_key\n", { mode: 0o600 });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })}\n`);
    child.stdin.end();
    const code = await new Promise((resolveClose, rejectClose) => {
      child.once("error", rejectClose);
      child.once("close", resolveClose);
    });

    assert.equal(code, 0, stderr);
    assert.ok(responseById(stdout, 4).result.tools.some((tool) => tool.name === "statewright_get_state"));
    assert.match(await readFile(curlCapture, "utf8"), /Authorization: Bearer sw_live_new_key/);
    await assert.rejects(readFile(join(home, ".statewright", "missing_api_key_prompted")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cursor adopts a newly saved API key without restarting its MCP process", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-cursor-key-adoption-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const browserCapture = join(root, "browser-command.txt");
  const curlCapture = join(root, "curl-command.txt");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("statewright_")),
  );
  try {
    await mkdir(bin, { recursive: true });
    const fakeCurl = join(bin, "curl");
    await writeFile(
      fakeCurl,
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" >> \"$STATEWRIGHT_CURL_CAPTURE\"\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[]},\"id\":2}'\n",
    );
    await chmod(fakeCurl, 0o755);
    Object.assign(environment, {
      HOME: home,
      PATH: `${bin}${delimiter}${environment.PATH ?? ""}`,
      STATEWRIGHT_BROWSER_OPEN_CAPTURE_PATH: browserCapture,
      STATEWRIGHT_CURL_CAPTURE: curlCapture,
      STATEWRIGHT_NO_UPDATE_CHECK: "1",
      STATEWRIGHT_SENTRY_DISABLED: "true",
    });

    const child = spawn("bash", [resolve("plugins/cursor/mcp-proxy.sh")], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await waitForOutput(() => stdout, /\"id\":1/);
    await writeFile(join(home, ".statewright", "api_key"), "sw_live_new_key\n", { mode: 0o600 });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    child.stdin.end();
    const code = await new Promise((resolveClose, rejectClose) => {
      child.once("error", rejectClose);
      child.once("close", resolveClose);
    });

    assert.equal(code, 0, stderr);
    assert.match(stdout, /\"id\":2/);
    assert.match(await readFile(curlCapture, "utf8"), /Authorization: Bearer sw_live_new_key/);
    await assert.rejects(readFile(join(home, ".statewright", "missing_api_key_prompted")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
