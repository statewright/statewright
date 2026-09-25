import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { desktopDoctor, disableDesktop, enableDesktop, replaceTomlValue, tomlValue } from "../scripts/statewright-desktop-setup.mjs";

const execFile = promisify(execFileCallback);

async function executable(path) {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o700);
}

async function moduleFile(path) {
  await writeFile(path, "export {};\n");
}

test("Desktop setup installs a private shim, preserves the vendor binary, and disables reversibly", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-desktop-setup-"));
  const config = join(root, "config.toml");
  const state = join(root, "state", "desktop.json");
  const vendor = join(root, "vendor-codex");
  const wrapper = join(root, "plugin-wrapper.mjs");
  try {
    await executable(vendor);
    await moduleFile(wrapper);
    await writeFile(config, `CODEX_CLI_PATH = "${vendor}"\n`);
    const record = await enableDesktop({ configPath: config, statePath: state, wrapper, node: process.execPath });
    assert.equal(record.original_codex, vendor);
    assert.match(record.client_id, /^swc_[a-f0-9]{32}$/);
    assert.equal(tomlValue(await readFile(config, "utf8"), "CODEX_CLI_PATH"), record.shim_path);
    assert.match(await readFile(record.shim_path, "utf8"), new RegExp(wrapper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal((await desktopDoctor({ configPath: config, statePath: state })).ok, true);
    await disableDesktop({ configPath: config, statePath: state });
    assert.equal(tomlValue(await readFile(config, "utf8"), "CODEX_CLI_PATH"), vendor);
    await assert.rejects(() => readFile(state, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop disable refuses to overwrite a user-changed Codex executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-desktop-diverge-"));
  const config = join(root, "config.toml");
  const state = join(root, "state", "desktop.json");
  const vendor = join(root, "vendor-codex");
  const wrapper = join(root, "plugin-wrapper.mjs");
  const replacement = join(root, "other-codex");
  try {
    await Promise.all([executable(vendor), moduleFile(wrapper), executable(replacement)]);
    await writeFile(config, `CODEX_CLI_PATH = "${vendor}"\n`);
    await enableDesktop({ configPath: config, statePath: state, wrapper, node: process.execPath });
    await writeFile(config, `CODEX_CLI_PATH = "${replacement}"\n`);
    await assert.rejects(() => disableDesktop({ configPath: config, statePath: state }), /changed since setup/);
    assert.equal(tomlValue(await readFile(config, "utf8"), "CODEX_CLI_PATH"), replacement);
    assert.ok(await readFile(state, "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop enable refuses to overwrite a user-changed Codex executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-desktop-enable-diverge-"));
  const config = join(root, "config.toml");
  const state = join(root, "state", "desktop.json");
  const vendor = join(root, "vendor-codex");
  const wrapper = join(root, "plugin-wrapper.mjs");
  const refreshedWrapper = join(root, "plugin-wrapper-v2.mjs");
  const replacement = join(root, "other-codex");
  try {
    await Promise.all([executable(vendor), moduleFile(wrapper), moduleFile(refreshedWrapper), executable(replacement)]);
    await writeFile(config, `CODEX_CLI_PATH = "${vendor}"\n`);
    await enableDesktop({ configPath: config, statePath: state, wrapper, node: process.execPath });
    await writeFile(config, `CODEX_CLI_PATH = "${replacement}"\n`);
    const before = await readFile(config, "utf8");
    await assert.rejects(
      () => enableDesktop({ configPath: config, statePath: state, wrapper: refreshedWrapper, node: process.execPath }),
      /changed since setup/,
    );
    assert.equal(await readFile(config, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop enable refreshes the packaged wrapper without rotating user identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-desktop-refresh-"));
  const config = join(root, "config.toml");
  const state = join(root, "state", "desktop.json");
  const vendor = join(root, "vendor-codex");
  const firstWrapper = join(root, "plugin-v1.mjs");
  const nextWrapper = join(root, "plugin-v2.mjs");
  try {
    await Promise.all([executable(vendor), moduleFile(firstWrapper), moduleFile(nextWrapper)]);
    await writeFile(config, `CODEX_CLI_PATH = "${vendor}"\n`);
    const first = await enableDesktop({ configPath: config, statePath: state, wrapper: firstWrapper, node: process.execPath });
    const refreshed = await enableDesktop({ configPath: config, statePath: state, wrapper: nextWrapper, node: process.execPath });
    assert.equal(refreshed.client_id, first.client_id);
    assert.equal(refreshed.original_codex, vendor);
    assert.equal(refreshed.wrapper, nextWrapper);
    assert.match(await readFile(refreshed.shim_path, "utf8"), new RegExp(nextWrapper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal((await desktopDoctor({ configPath: config, statePath: state })).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop setup adds a missing root key before TOML tables", () => {
  const updated = replaceTomlValue("existing = \"value\"\n\n[mcp_servers.example]\ncommand = \"tool\"\n", "CODEX_CLI_PATH", "/vendor/codex");
  assert.match(updated, /^CODEX_CLI_PATH = "\/vendor\/codex"\nexisting = "value"\n\n\[mcp_servers\.example\]/);
});

test("Desktop setup preserves an inline comment on the root Codex executable", () => {
  const updated = replaceTomlValue('CODEX_CLI_PATH = "/vendor/codex" # local override\n', "CODEX_CLI_PATH", "/statewright/shim");
  assert.equal(updated, 'CODEX_CLI_PATH = "/statewright/shim" # local override\n');
  assert.equal(tomlValue(updated, "CODEX_CLI_PATH"), "/statewright/shim");
});

test("Desktop setup ignores a nested Codex executable key", () => {
  const source = '[mcp_servers.example.env]\nCODEX_CLI_PATH = "/nested/codex"\n';
  const updated = replaceTomlValue(source, "CODEX_CLI_PATH", "/root/codex");
  assert.match(updated, /^CODEX_CLI_PATH = "\/root\/codex"\n\[mcp_servers\.example\.env\]/);
  assert.match(updated, /CODEX_CLI_PATH = "\/nested\/codex"/);
  assert.equal(tomlValue(updated, "CODEX_CLI_PATH"), "/root/codex");
});

test("Desktop enable updates a quoted root key without creating a duplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-desktop-quoted-root-"));
  const config = join(root, "config.toml");
  const state = join(root, "state", "desktop.json");
  const vendor = join(root, "vendor-codex");
  const wrapper = join(root, "plugin-wrapper.mjs");
  try {
    await Promise.all([executable(vendor), moduleFile(wrapper)]);
    await writeFile(config, `"CODEX_CLI_PATH" = "${vendor}" # preserved\n`);
    const record = await enableDesktop({ configPath: config, statePath: state, wrapper, node: process.execPath });
    const updated = await readFile(config, "utf8");
    assert.equal(tomlValue(updated, "CODEX_CLI_PATH"), record.shim_path);
    assert.match(updated, /# preserved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop enable preserves multiline text that resembles TOML configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-desktop-multiline-"));
  const config = join(root, "config.toml");
  const state = join(root, "state", "desktop.json");
  const vendor = join(root, "vendor-codex");
  const wrapper = join(root, "plugin-wrapper.mjs");
  const prose = 'notes = """\n[mcp_servers.example]\nCODEX_CLI_PATH = "/only prose"\n"""\n';
  try {
    await Promise.all([executable(vendor), moduleFile(wrapper)]);
    await writeFile(config, `${prose}CODEX_CLI_PATH = "${vendor}"\n`);
    const record = await enableDesktop({ configPath: config, statePath: state, wrapper, node: process.execPath });
    const updated = await readFile(config, "utf8");
    assert.equal(tomlValue(updated, "CODEX_CLI_PATH"), record.shim_path);
    assert.match(updated, /\[mcp_servers\.example\]/);
    assert.match(updated, /CODEX_CLI_PATH = "\/only prose"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop enable rejects unsupported valid TOML before writing Statewright files", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-desktop-unsupported-root-"));
  const config = join(root, "config.toml");
  const state = join(root, "state", "desktop.json");
  const shim = join(root, "state", "bin", "statewright-desktop-codex");
  const vendor = join(root, "vendor-codex");
  const wrapper = join(root, "plugin-wrapper.mjs");
  const source = `CODEX_CLI_PATH = """${vendor}"""\n`;
  try {
    await Promise.all([executable(vendor), moduleFile(wrapper)]);
    await writeFile(config, source);
    await assert.rejects(
      () => enableDesktop({ configPath: config, statePath: state, wrapper, node: process.execPath }),
      /Cannot safely replace root CODEX_CLI_PATH/,
    );
    assert.equal(await readFile(config, "utf8"), source);
    await assert.rejects(() => readFile(state, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(shim, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop shim binds the explicit state record it created", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-desktop-shim-"));
  const config = join(root, "config.toml");
  const state = join(root, "custom", "desktop.json");
  const vendor = join(root, "vendor-codex");
  const wrapper = join(root, "capture-state.mjs");
  try {
    await executable(vendor);
    await writeFile(wrapper, 'import { readFile } from "node:fs/promises";\nconst state = JSON.parse(await readFile(process.env.STATEWRIGHT_DESKTOP_STATE_PATH, "utf8"));\nprocess.stdout.write(JSON.stringify({ path: process.env.STATEWRIGHT_DESKTOP_STATE_PATH, original: state.original_codex, client: state.client_id }));\n');
    await writeFile(config, `CODEX_CLI_PATH = "${vendor}"\n`);
    const record = await enableDesktop({ configPath: config, statePath: state, wrapper, node: process.execPath });
    const { stdout } = await execFile(record.shim_path, [], { env: { ...process.env, STATEWRIGHT_DESKTOP_STATE_PATH: join(root, "wrong.json") } });
    assert.deepEqual(JSON.parse(stdout), { path: state, original: vendor, client: record.client_id });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
