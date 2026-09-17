import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimManagedSessionOwner, releaseManagedSessionOwner } from "../lib/managed-client-identity.mjs";
import { runManagedClient, windowsProcessTreeEnvironment } from "../lib/managed-client-supervisor.mjs";

const CLIENT_A = `swc_${"a".repeat(32)}`;
const CLIENT_B = `swc_${"b".repeat(32)}`;

function fakeBridgeFactory() {
  return {
    url: "http://127.0.0.1:9999",
    token: "ownership-race-fixture",
    async start() { return this; },
    async close() {},
  };
}

async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  return false;
}

async function settleRestartFixture({ release, first }) {
  await writeFile(release, "release\n").catch(() => {});
  if (!first) return;
  let timeout;
  try {
    await Promise.race([
      first.catch(() => {}),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("restart fixture child did not settle after release")), 2_000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("concurrent ownership has one winner and releases to a different managed client", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-ownership-race-"));
  const sessionId = "ownership-race-thread";
  try {
    const attempts = await Promise.allSettled([
      claimManagedSessionOwner({ host: "codex", sessionId, clientId: CLIENT_A, home, cwd: home, pid: process.pid }),
      claimManagedSessionOwner({ host: "codex", sessionId, clientId: CLIENT_B, home, cwd: home, pid: process.pid }),
    ]);
    const winner = attempts.find((attempt) => attempt.status === "fulfilled");
    const loser = attempts.find((attempt) => attempt.status === "rejected");
    assert.ok(winner, "exactly one concurrent owner must claim the session");
    assert.ok(loser, "the duplicate concurrent owner must be refused");
    assert.match(String(loser.reason), /refused to attach a second managed writer/i);
    assert.equal(await releaseManagedSessionOwner({ host: "codex", sessionId, ownerId: winner.value.owner_id, home }), true);
    const replacementClient = winner.value.client_id === CLIENT_A ? CLIENT_B : CLIENT_A;
    const replacement = await claimManagedSessionOwner({ host: "codex", sessionId, clientId: replacementClient, home, cwd: home, pid: process.pid });
    assert.equal(replacement.client_id, replacementClient, "the released lease must hand over to the other managed client");
    assert.notEqual(replacement.owner_id, winner.value.owner_id, "a released owner lease must hand over cleanly");
    assert.equal(await releaseManagedSessionOwner({ host: "codex", sessionId, ownerId: replacement.owner_id, home }), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a stale ownership lease is reclaimed by the next managed client", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-ownership-stale-"));
  const sessionId = "ownership-stale-thread";
  try {
    const stalePid = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", ""]);
      child.once("error", reject);
      child.once("exit", () => resolve(child.pid));
    });
    await claimManagedSessionOwner({ host: "codex", sessionId, clientId: CLIENT_A, home, cwd: home, pid: stalePid });
    const replacement = await claimManagedSessionOwner({ host: "codex", sessionId, clientId: CLIENT_B, home, cwd: home, pid: process.pid });
    assert.equal(replacement.client_id, CLIENT_B);
    assert.equal(await releaseManagedSessionOwner({ host: "codex", sessionId, ownerId: replacement.owner_id, home }), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("restart fixture cleanup releases a worker after an assertion-path failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-ownership-cleanup-"));
  const worker = join(home, "worker.mjs");
  const release = join(home, "release");
  let first;
  try {
    await writeFile(worker, `import { existsSync } from "node:fs";\nconst release = ${JSON.stringify(release)};\nconst wait = () => existsSync(release) ? process.exit(0) : setTimeout(wait, 10);\nwait();\n`);
    const child = spawn(process.execPath, [worker]);
    first = new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code) => resolveExit(code));
    });
    await assert.rejects((async () => {
      try {
        throw new Error("intentional assertion-path failure");
      } finally {
        await settleRestartFixture({ release, first });
      }
    })(), /intentional assertion-path failure/);
    assert.equal(await first, 0, "cleanup must release the worker before removing its directory");
  } finally {
    await settleRestartFixture({ release, first });
    await rm(home, { recursive: true, force: true });
  }
});

test("a duplicate resumed supervisor is refused before its native child starts", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-ownership-restart-"));
  const sharedCwd = join(home, "shared");
  const otherCwd = join(home, "other");
  const worker = join(home, "worker.mjs");
  const launcher = process.platform === "win32" ? join(home, "fake-codex.cmd") : worker;
  const calls = join(home, "calls.log");
  const release = join(home, "release");
  let first;
  try {
    await mkdir(sharedCwd);
    await mkdir(otherCwd);
    await writeFile(worker, `#!/usr/bin/env node\nimport { appendFileSync, existsSync } from "node:fs";\nappendFileSync(${JSON.stringify(calls)}, "spawned\\n");\nconst release = ${JSON.stringify(release)};\nconst awaitRelease = () => existsSync(release) ? process.exit(0) : setTimeout(awaitRelease, 10);\nawaitRelease();\n`);
    if (process.platform === "win32") {
      await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${worker}" %*\r\n`);
    } else {
      await chmod(worker, 0o755);
    }
    const options = {
      host: "codex",
      command: launcher,
      args: ["resume", "shared-thread"],
      environment: { ...windowsProcessTreeEnvironment(process.env), PATH: process.env.PATH, STATEWRIGHT_API_KEY: "ownership-race", STATEWRIGHT_SENTRY_DISABLED: "true" },
      home,
      cwd: sharedCwd,
      pollMs: 5,
      bridgeFactory: fakeBridgeFactory,
      historyGuard: async () => ({ status: "healthy" }),
    };
    first = runManagedClient(options);
    assert.equal(await waitFor(() => access(calls).then(() => true, () => false)), true, "first supervisor started its native child");
    await assert.rejects(runManagedClient({ ...options, cwd: otherCwd }), /refused to attach a second managed writer/i);
    await settleRestartFixture({ release, first });
    assert.equal(await first, 0);
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), ["spawned"], "the duplicate supervisor must not start a second native child");
  } finally {
    await settleRestartFixture({ release, first });
    await rm(home, { recursive: true, force: true });
  }
});
