import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isWindowsCommand,
  resolveWindowsLaunch,
} from "../executor/lib/windows-command-resolution.mjs";

// The managed Claude Code client launches through this exact module. These
// tests drive the plugin's synced copy with a forced win32 platform so the
// Windows shim-resolution path is covered on POSIX CI hosts. They mirror the
// executor transport suite but assert against the claude-code copy itself, so
// a divergence between the shared resolver and its synced copy is caught here.

function npmTemplateShim() {
  // Exact template npm's cmd-shim dependency writes for Windows JS bin links.
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    '"%_prog%"  "%dp0%\\node_modules\\@statewright\\claude-code\\bin\\claude.mjs"  %*',
    "",
  ].join("\r\n");
}

test("claude-code launch helper classifies Windows batch launchers only", () => {
  assert.equal(isWindowsCommand("C:\\tools\\claude.cmd", "win32"), true);
  assert.equal(isWindowsCommand("C:\\tools\\claude.bat", "win32"), true);
  assert.equal(isWindowsCommand("C:\\tools\\claude.exe", "win32"), false);
  assert.equal(isWindowsCommand("/usr/local/bin/claude", "darwin"), false);
});

test("claude-code launch helper passes non-batch commands straight through", async () => {
  assert.deepEqual(await resolveWindowsLaunch("node", "win32"), { command: "node", prefixArgs: [], shell: false });
  assert.deepEqual(await resolveWindowsLaunch("C:\\tools\\claude.exe", "win32"), { command: "C:\\tools\\claude.exe", prefixArgs: [], shell: false });
  assert.deepEqual(await resolveWindowsLaunch("/usr/local/bin/claude", "darwin"), { command: "/usr/local/bin/claude", prefixArgs: [], shell: false });
});

test("claude-code launch helper falls back to cmd.exe for an unparseable Windows shim", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-cc-shim-fallback-"));
  const command = join(home, "claude.cmd");
  try {
    await writeFile(command, "@echo off\r\necho unsupported shim\r\n");
    const launch = await resolveWindowsLaunch(command, "win32");
    assert.deepEqual(launch, { command, prefixArgs: [], shell: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("claude-code npm-template Windows shim resolves to the local Node interpreter", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-cc-npm-template-"));
  const command = join(home, "claude.cmd");
  const entrypoint = join(home, "node_modules/@statewright/claude-code/bin/claude.mjs");
  const localNode = join(home, "node.exe");
  try {
    await mkdir(join(home, "node_modules/@statewright/claude-code/bin"), { recursive: true });
    await writeFile(entrypoint, "export {};\n");
    await writeFile(command, npmTemplateShim());
    // A placeholder marks the IF EXIST "%dp0%\node.exe" branch as taken, so
    // the resolver must prefer the local interpreter over the PATH fallback.
    await writeFile(localNode, "");
    const launch = await resolveWindowsLaunch(command, "win32");
    assert.deepEqual(launch, { command: localNode, prefixArgs: [entrypoint], shell: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("claude-code npm-template Windows shim falls back to PATH Node", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-cc-npm-template-fallback-"));
  const command = join(home, "claude.cmd");
  const entrypoint = join(home, "node_modules/@statewright/claude-code/bin/claude.mjs");
  try {
    await mkdir(join(home, "node_modules/@statewright/claude-code/bin"), { recursive: true });
    await writeFile(entrypoint, "export {};\n");
    await writeFile(command, npmTemplateShim());
    const launch = await resolveWindowsLaunch(command, "win32");
    assert.deepEqual(launch, { command: "node", prefixArgs: [entrypoint], shell: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
