import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { desktopDoctor, disableDesktop, enableDesktop } from "../scripts/statewright-desktop-setup.mjs";

const execFile = promisify(execFileCallback);

async function executable(path) {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o700);
}

async function moduleFile(path) {
  await writeFile(path, "export {};\n");
}

function launchctlHarness(initialValue = null) {
  let value = initialValue;
  const calls = [];
  return {
    calls,
    get value() { return value; },
    async exec(_path, args) {
      calls.push(args);
      if (args[0] === "getenv") return { stdout: value == null ? "" : `${value}\n`, stderr: "" };
      if (args[0] === "setenv") { value = args[2]; return { stdout: "", stderr: "" }; }
      if (args[0] === "unsetenv") { value = null; return { stdout: "", stderr: "" }; }
      throw new Error(`unexpected launchctl args: ${args.join(" ")}`);
    },
  };
}

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const state = join(root, "state", "desktop.json");
  const vendor = join(root, "vendor-codex");
  const wrapper = join(root, "plugin-wrapper.mjs");
  await Promise.all([executable(vendor), moduleFile(wrapper)]);
  return { root, state, vendor, wrapper };
}

test("Desktop setup sets a private launchd shim and restores the prior value", async () => {
  const { root, state, vendor, wrapper } = await fixture("statewright-desktop-setup-");
  const launchctl = launchctlHarness("/prior/codex");
  try {
    const record = await enableDesktop({ statePath: state, original: vendor, wrapper, node: process.execPath, launchctlExecFile: launchctl.exec });
    assert.equal(record.previous_launchd_value, "/prior/codex");
    assert.equal(record.environment_key, "CODEX_CLI_PATH");
    assert.match(record.client_id, /^swc_[a-f0-9]{32}$/);
    assert.equal(launchctl.value, record.shim_path);
    assert.match(await readFile(record.shim_path, "utf8"), new RegExp(wrapper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal((await desktopDoctor({ statePath: state, launchctlExecFile: launchctl.exec })).ok, true);
    await disableDesktop({ statePath: state, launchctlExecFile: launchctl.exec });
    assert.equal(launchctl.value, "/prior/codex");
    assert.ok(launchctl.calls.some(args => args[0] === "setenv" && args[2] === "/prior/codex"));
    await assert.rejects(() => readFile(state, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop setup restores an absent launchd value by unsetting it", async () => {
  const { root, state, vendor, wrapper } = await fixture("statewright-desktop-unset-");
  const launchctl = launchctlHarness();
  try {
    const record = await enableDesktop({ statePath: state, original: vendor, wrapper, node: process.execPath, launchctlExecFile: launchctl.exec });
    assert.equal(record.previous_launchd_value, null);
    assert.equal(launchctl.value, record.shim_path);
    await disableDesktop({ statePath: state, launchctlExecFile: launchctl.exec });
    assert.equal(launchctl.value, null);
    assert.ok(launchctl.calls.some(args => args[0] === "unsetenv"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop disable refuses to overwrite a user-changed launchd executable", async () => {
  const { root, state, vendor, wrapper } = await fixture("statewright-desktop-diverge-");
  const launchctl = launchctlHarness();
  try {
    await enableDesktop({ statePath: state, original: vendor, wrapper, node: process.execPath, launchctlExecFile: launchctl.exec });
    await launchctl.exec("/bin/launchctl", ["setenv", "CODEX_CLI_PATH", "/other/codex"]);
    await assert.rejects(() => disableDesktop({ statePath: state, launchctlExecFile: launchctl.exec }), /changed since setup/);
    assert.equal(launchctl.value, "/other/codex");
    assert.ok(await readFile(state, "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop enable refuses to overwrite a user-changed launchd executable", async () => {
  const { root, state, vendor, wrapper } = await fixture("statewright-desktop-enable-diverge-");
  const refreshedWrapper = join(root, "plugin-wrapper-v2.mjs");
  const launchctl = launchctlHarness();
  try {
    await moduleFile(refreshedWrapper);
    await enableDesktop({ statePath: state, original: vendor, wrapper, node: process.execPath, launchctlExecFile: launchctl.exec });
    await launchctl.exec("/bin/launchctl", ["setenv", "CODEX_CLI_PATH", "/other/codex"]);
    await assert.rejects(
      () => enableDesktop({ statePath: state, original: vendor, wrapper: refreshedWrapper, node: process.execPath, launchctlExecFile: launchctl.exec }),
      /changed since setup/,
    );
    assert.equal(launchctl.value, "/other/codex");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop enable refreshes the packaged wrapper without rotating user identity", async () => {
  const { root, state, vendor, wrapper } = await fixture("statewright-desktop-refresh-");
  const nextWrapper = join(root, "plugin-v2.mjs");
  const launchctl = launchctlHarness();
  try {
    await moduleFile(nextWrapper);
    const first = await enableDesktop({ statePath: state, original: vendor, wrapper, node: process.execPath, launchctlExecFile: launchctl.exec });
    const refreshed = await enableDesktop({ statePath: state, original: vendor, wrapper: nextWrapper, node: process.execPath, launchctlExecFile: launchctl.exec });
    assert.equal(refreshed.client_id, first.client_id);
    assert.equal(refreshed.wrapper, nextWrapper);
    assert.equal(launchctl.value, refreshed.shim_path);
    assert.equal((await desktopDoctor({ statePath: state, launchctlExecFile: launchctl.exec })).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop refresh retains the existing launchd boundary when setenv is unavailable", async () => {
  const { root, state, vendor, wrapper } = await fixture("statewright-desktop-refresh-atomic-");
  const nextWrapper = join(root, "plugin-v2.mjs");
  const launchctl = launchctlHarness();
  try {
    await moduleFile(nextWrapper);
    const first = await enableDesktop({ statePath: state, original: vendor, wrapper, node: process.execPath, launchctlExecFile: launchctl.exec });
    const callsBeforeRefresh = launchctl.calls.length;
    const originalExec = launchctl.exec;
    launchctl.exec = async (path, args) => {
      if (args[0] === "setenv") throw new Error("launchctl setenv unavailable");
      return originalExec(path, args);
    };
    const refreshed = await enableDesktop({ statePath: state, original: vendor, wrapper: nextWrapper, node: process.execPath, launchctlExecFile: launchctl.exec });
    assert.equal(refreshed.client_id, first.client_id);
    assert.equal(launchctl.value, first.shim_path);
    assert.equal((await desktopDoctor({ statePath: state, launchctlExecFile: launchctl.exec })).ok, true);
    assert.equal(launchctl.calls.slice(callsBeforeRefresh).some(args => args[0] === "setenv"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop setup removes private artifacts when its initial launchd install fails", async () => {
  const { root, state, vendor, wrapper } = await fixture("statewright-desktop-initial-atomic-");
  const launchctl = launchctlHarness();
  try {
    const failingExec = async (path, args) => {
      if (args[0] === "setenv") throw new Error("launchctl setenv unavailable");
      return launchctl.exec(path, args);
    };
    await assert.rejects(
      () => enableDesktop({ statePath: state, original: vendor, wrapper, node: process.execPath, launchctlExecFile: failingExec }),
      /launchctl setenv unavailable/,
    );
    assert.equal(launchctl.value, null);
    await assert.rejects(() => readFile(state, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop shim binds the explicit state record it created", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-desktop-shim-"));
  const state = join(root, "custom", "desktop.json");
  const vendor = join(root, "vendor-codex");
  const wrapper = join(root, "capture-state.mjs");
  const launchctl = launchctlHarness();
  try {
    await executable(vendor);
    await writeFile(wrapper, 'import { readFile } from "node:fs/promises";\nconst state = JSON.parse(await readFile(process.env.STATEWRIGHT_DESKTOP_STATE_PATH, "utf8"));\nprocess.stdout.write(JSON.stringify({ path: process.env.STATEWRIGHT_DESKTOP_STATE_PATH, original: state.original_codex, client: state.client_id }));\n');
    const record = await enableDesktop({ statePath: state, original: vendor, wrapper, node: process.execPath, launchctlExecFile: launchctl.exec });
    const { stdout } = await execFile(record.shim_path, [], { env: { ...process.env, STATEWRIGHT_DESKTOP_STATE_PATH: join(root, "wrong.json") } });
    assert.deepEqual(JSON.parse(stdout), { path: state, original: vendor, client: record.client_id });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
