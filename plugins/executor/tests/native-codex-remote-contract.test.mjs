import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import test from "node:test";
import { WebSocketServer } from "ws";

const nativeCodex = process.env.STATEWRIGHT_NATIVE_CODEX_BIN?.trim();
const expectCandidate = process.env.STATEWRIGHT_NATIVE_CODEX_EXPECT_BIN?.trim()
  || (process.platform !== "win32" ? "/usr/bin/expect" : null);
const expectBin = expectCandidate && existsSync(expectCandidate) ? expectCandidate : null;

test("native Codex accepts the bare remote and bearer-token argument contract", {
  skip: nativeCodex && expectBin ? false : "set STATEWRIGHT_NATIVE_CODEX_BIN and install Expect to exercise the installed Codex CLI",
}, async () => {
  const tokenEnvironment = "STATEWRIGHT_NATIVE_CODEX_REMOTE_TOKEN";
  const expectedToken = "native-contract-token";
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  let socket;
  const connected = new Promise((resolveConnection) => server.once("connection", (accepted, request) => {
    socket = accepted;
    resolveConnection(request.headers.authorization);
  }));
  const expectScript = [
    "set timeout 5",
    "spawn -noecho $env(STATEWRIGHT_NATIVE_CODEX_BIN) --remote $env(STATEWRIGHT_NATIVE_CODEX_REMOTE_URL) --remote-auth-token-env STATEWRIGHT_NATIVE_CODEX_REMOTE_TOKEN resume 00000000-0000-0000-0000-000000000000",
    "expect {",
    "  eof { set status [wait]; exit [lindex $status 3] }",
    "  timeout { exit 124 }",
    "}",
  ].join("\n");
  const child = spawn(expectBin, ["-c", expectScript], {
    env: {
      ...process.env,
      [tokenEnvironment]: expectedToken,
      STATEWRIGHT_NATIVE_CODEX_REMOTE_URL: `ws://127.0.0.1:${address.port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-32_768); });
  }
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let timer;
  const timeout = new Promise((_, rejectTimeout) => {
    timer = setTimeout(() => rejectTimeout(new Error(`native Codex did not complete its remote handshake; output: ${output}`)), 5_000);
  });
  try {
    const authorization = await Promise.race([
      connected,
      exited.then(({ code, signal }) => {
        throw new Error(`native Codex exited before the remote handshake (code=${code}, signal=${signal}); output: ${output}`);
      }),
      timeout,
    ]);
    assert.equal(authorization, `Bearer ${expectedToken}`);
    socket.close(1000, "contract verified");
    const result = await Promise.race([exited, timeout]);
    assert.equal(result.signal, null, `native Codex terminated by signal; output: ${output}`);
    assert.doesNotMatch(output, /invalid remote address|unexpected argument|usage:/i);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    socket?.terminate();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});
