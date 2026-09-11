import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProjectAppServers } from "../statewright-managed-client.mjs";

function writable() {
  let value = "";
  return { write(chunk) { value += chunk; }, get value() { return value; } };
}

test("managed App Server termination selects one explicit same-cwd thread", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-kill-one-"));
  const root = join(home, ".statewright", "codex-app-server");
  const cwd = "/workspace/shared";
  const alpha = "swc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const beta = "swc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const input = { once(_event, callback) { callback("y"); } };
  const output = writable();
  const errorOutput = writable();
  const killed = [];
  try {
    for (const [clientId, threadId, pid] of [[alpha, "alpha-thread", 1111], [beta, "beta-thread", 2222]]) {
      const clientRoot = join(root, clientId);
      await mkdir(join(clientRoot, "routes"), { recursive: true });
      await writeFile(join(clientRoot, "manifest.json"), JSON.stringify({ pid, clientId, threadListCwd: cwd }));
      await writeFile(join(clientRoot, "routes", "codex-root-session.json"), JSON.stringify({ version: 1, session_id: threadId, client_id: clientId }));
    }
    const result = await killProjectAppServers({
      cwd,
      home,
      threadId: "alpha-thread",
      input,
      output,
      errorOutput,
      kill(pid, signal) { killed.push([pid, signal]); },
    });
    assert.deepEqual(result, [1111]);
    assert.deepEqual(killed, [[1111, "SIGTERM"]]);
    assert.match(errorOutput.value, /thread=alpha-thread/);
    assert.doesNotMatch(errorOutput.value, /beta-thread/);
    assert.match(output.value, /"threadId":"alpha-thread"/);
    const noMatch = await killProjectAppServers({
      cwd,
      home,
      threadId: "missing-thread",
      input,
      output,
      errorOutput,
      kill(pid) { killed.push([pid, "unexpected"]); },
    });
    assert.deepEqual(noMatch, []);
    assert.equal(killed.length, 1);
    assert.match(errorOutput.value, /nothing was terminated/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
