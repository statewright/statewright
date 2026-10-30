import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("The Windows browser onboarding canary must run on a Windows runner.");
}

function msysPath(path) {
  return path.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
}

function secretlessEnvironment(home, probePath, resultPath) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("statewright_")),
  );
  return {
    ...environment,
    HOME: msysPath(home),
    USERPROFILE: home,
    OS: "Windows_NT",
    STATEWRIGHT_BROWSER_OPEN_PROBE: probePath,
    STATEWRIGHT_BROWSER_PROBE_RESULT: resultPath,
    STATEWRIGHT_NO_UPDATE_CHECK: "1",
    STATEWRIGHT_SENTRY_DISABLED: "true",
  };
}

function runProxy(stage, proxyPath, environment, connect = false) {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "statewright_get_state", arguments: {} } },
    ...(connect ? [{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "statewright_connect", arguments: {} } }] : []),
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  return new Promise((resolve, reject) => {
    console.log(`[windows-browser-onboarding] starting ${stage}`);
    const child = spawn("bash", [proxyPath], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let exited = false;
    child.once("exit", () => { exited = true; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (exited) {
        // Descendants may still hold a pipe, but an exited parent's PID can be
        // reused. Do not taskkill by that stale identity.
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new Error(`${stage} timed out waiting for pipe closure after proxy exit; no stale PID was killed`));
        return;
      }
      // Only this fixture's child tree. Never leave a spinning proxy after the
      // outer CI step kills the harness, or dump arbitrary child/environment data.
      execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"],
        { windowsHide: true, timeout: 5_000 }, (error) => {
          reject(new Error(`${stage} timed out after 25s (stdout=${stdout.length} bytes, stderr=${stderr.length} bytes; child-tree cleanup ${error ? "failed" : "completed"})`));
        });
    }, 25_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!timedOut) resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

// Test the real Windows proxy/curl/PowerShell boundary without creating a grant
// on a public service. Denial terminates the background poll; this fixture does
// not establish live OAuth approval, token storage or native Claude OAuth.
async function deviceIssuerFixture() {
  const deviceCode = "a".repeat(32);
  const userCode = "BCDF-GHJK-MNPQ";
  const requests = [];
  const errors = [];
  let tokenReceived;
  const tokenRequest = new Promise((resolve) => { tokenReceived = resolve; });
  let origin;
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(request.url);
      const form = new URLSearchParams(body);
      assert.equal(request.method, "POST");
      assert.equal(form.get("client_id"), "statewright-codex");
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/oauth/device/code") {
        assert.equal(form.get("scope"), "mcp");
        response.end(JSON.stringify({ device_code: deviceCode, user_code: userCode,
          verification_uri: `${origin}/device`, verification_uri_complete: `${origin}/device?user_code=${userCode}`,
          expires_in: 60, interval: 5 }));
      } else {
        assert.equal(request.url, "/api/oauth/device/token");
        assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
        assert.equal(form.get("device_code"), deviceCode);
        response.writeHead(400);
        response.end(JSON.stringify({ error: "access_denied" }), tokenReceived);
      }
    } catch (error) {
      errors.push(error);
      response.statusCode = 500;
      response.end("fixture failed");
      tokenReceived();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, deviceCode, userCode,
    async verifyPoll() {
      let timer;
      try {
        await Promise.race([tokenRequest, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Codex did not poll the device issuer within 20s")), 20_000);
        })]);
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, ["/api/oauth/device/code", "/api/oauth/device/token"]);
      } finally { clearTimeout(timer); }
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

const plugins = [
  ["codex", new URL("../../codex/mcp-proxy.sh", import.meta.url)],
  ["claude", new URL("../../claude-code/mcp-proxy.sh", import.meta.url)],
  ["cursor", new URL("../../cursor/mcp-proxy.sh", import.meta.url)],
];

for (const [name, proxyUrl] of plugins) {
  const root = await mkdtemp(join(tmpdir(), `statewright-${name}-browser-onboarding-`));
  const home = join(root, "home with spaces");
  const probePath = join(root, "browser-probe.cmd");
  const resultPath = join(root, "browser-probe-result.txt");
  let issuer;
  try {
    await writeFile(
      probePath,
      '@echo off\r\n>> "%STATEWRIGHT_BROWSER_PROBE_RESULT%" echo %~1\r\n',
    );
    const environment = secretlessEnvironment(home, probePath, resultPath);
    assert.equal(
      Object.keys(environment).some((key) => key.toLowerCase() === "statewright_api_key"),
      false,
      `${name} canary must not inherit an API key`,
    );
    const proxy = msysPath(fileURLToPath(proxyUrl));
    if (name === "codex") {
      // Source checkout CI must build the helper shipped in release archives.
      // An absent helper is unavailable, not an empty credential store.
      assert.ok(process.env.STATEWRIGHT_CREDENTIAL_HELPER, "native credential helper must be supplied");
      await access(process.env.STATEWRIGHT_CREDENTIAL_HELPER);
      environment.STATEWRIGHT_CREDENTIAL_HELPER = process.env.STATEWRIGHT_CREDENTIAL_HELPER;
      issuer = await deviceIssuerFixture();
      environment.STATEWRIGHT_GATEWAY_URL = `${issuer.origin}/mcp`;
      environment.STATEWRIGHT_PB_URL = issuer.origin;
      const disconnected = await runProxy("codex disconnected", proxy, environment);
      assert.equal(disconnected.code, 0, disconnected.stderr);
      const messages = disconnected.stdout.trim().split(/\r?\n/).map(JSON.parse);
      const catalog = JSON.parse(await readFile(new URL("../../codex/mcp-tool-catalog.json", import.meta.url), "utf8"));
      assert.deepEqual(messages.find(({ id }) => id === 2).result.tools.map(({ name }) => name).sort(),
        catalog.map(({ name }) => name).sort());
      assert.equal(messages.find(({ id }) => id === 3).error.code, -32001);
      await assert.rejects(readFile(resultPath), { code: "ENOENT" }, "ordinary calls must not open a browser");

      const snapshotsRoot = join(home, ".statewright", "runtime", "codex-mcp");
      const snapshots = (await readdir(snapshotsRoot)).filter(name => !name.startsWith("."));
      assert.equal(snapshots.length, 1, "initial launch must retain exactly one runtime");
      const retainedProxy = msysPath(join(snapshotsRoot, snapshots[0], "mcp-proxy.sh"));
      const cold = await runProxy("codex retained cold-start", retainedProxy, environment);
      assert.equal(cold.code, 0, cold.stderr);
      assert.deepEqual(cold.stdout.trim().split(/\r?\n/).map(JSON.parse), messages);
      assert.deepEqual((await readdir(snapshotsRoot)).filter(name => !name.startsWith(".")), snapshots);
      await assert.rejects(readFile(resultPath), { code: "ENOENT" }, "cold-start must not open a browser");

      const connected = await runProxy("codex explicit connect", proxy, environment, true);
      assert.equal(connected.code, 0, connected.stderr);
      const connect = connected.stdout.trim().split(/\r?\n/).map(JSON.parse).find(({ id }) => id === 4);
      const text = connect.result.content[0].text;
      const approvalUrl = `${issuer.origin}/device?user_code=${issuer.userCode}`;
      assert.match(text, /Opened secure Statewright approval in your browser/);
      assert.ok(text.includes(approvalUrl));
      assert.ok(!text.includes(issuer.deviceCode), "private device code must not enter MCP output");
      assert.deepEqual((await readFile(resultPath, "utf8")).trim().split(/\r?\n/), [approvalUrl]);
      await issuer.verifyPoll();
      console.log("[windows-browser-onboarding] codex: explicit device-code connect, real PowerShell dispatch and local issuer denial verified; live OAuth not tested");
      continue;
    }

    const result = await runProxy(`${name} legacy onboarding`, proxy, environment);
    assert.equal(result.code, 0, `${name} proxy failed: ${result.stderr}`);
    assert.match(result.stdout, /Statewright API key not configured/);

    assert.deepEqual(
      (await readFile(resultPath, "utf8")).trim().split(/\r?\n/),
      ["https://statewright.ai/signup?redirect=%2Fkeys"],
      `${name} must launch exactly once with the signup URL through real PowerShell Start-Process`,
    );
    assert.equal(
      await readFile(join(home, ".statewright", "missing_api_key_prompted"), "utf8"),
      "",
    );
    console.log(`[windows-browser-onboarding] ${name}: legacy secretless API-key signup PowerShell path verified; native OAuth not tested`);
  } finally {
    if (issuer) await issuer.close();
    await rm(root, { recursive: true, force: true });
  }
}
