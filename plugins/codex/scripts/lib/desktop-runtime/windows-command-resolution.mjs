import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function isWindowsCommand(command, platform = process.platform) {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(String(command));
}

function expandLegacyShimPath(value, command) {
  const input = String(value);
  const prefix = "%~dp0";
  if (!input.toLowerCase().startsWith(prefix)) return input;
  return join(dirname(command), input.slice(prefix.length).replace(/^[\\/]+/, ""));
}


// %dp0% is the shim's own directory. Backslash components are folded to "/"
// before the host join: Windows accepts both separators, which keeps the
// expansion valid on real Windows and on POSIX hosts running the tests.
function expandDp0(value, shimDir) {
  const raw = String(value).trim().replace(/^"+|"+$/g, "");
  if (!raw.toLowerCase().startsWith("%dp0%")) return raw;
  const rest = raw.slice(5).replace(/^[\\/]+/, "").split("\\").join("/");
  if (!rest) return shimDir;
  return join(shimDir, rest);
}

// Parser for the exact template npm's cmd-shim dependency writes for Windows
// JS bin links: a %~dp0 self-locator, an IF EXIST "%dp0%\node.exe" / ELSE
// SET "_prog=..." branch, and an `endLocal & goto ... & "%_prog%" <args>
// "<target>" %*` launch line. Only that shape is interpreted; anything else
// falls through to the legacy direct-node form or the shell fallback.
function parseNpmTemplateShim(source, shimPath) {
  const lines = source.split(/\r?\n/).map((line) => line.replace(/\s+$/, ""));
  const lower = lines.map((line) => line.toLowerCase());
  const isNpmTemplate =
    lower.some((line) => /^set\s+dp0\s*=\s*%~dp0$/.test(line)) &&
    lower.some((line) => /^call\s+:find_dp0$/.test(line));
  if (!isNpmTemplate) return null;

  const shimDir = dirname(shimPath);
  const progCandidates = [];
  for (const line of lines) {
    const match = line.match(/^\s*SET\s+"?_prog"?\s*=(.+)$/i);
    if (match) progCandidates.push(match[1].replace(/"/g, "").trim());
  }

  let launchLine = null;
  for (const line of lines) {
    if (line.includes("%_prog%") && line.includes("%*")) launchLine = line;
  }
  if (!launchLine) return null;

  const body = launchLine.replace(
    /^endlocal\s*&\s*goto\s+#_undefined_#\s*(?:\d+>nul\s*\|\|\s*title\s+%comspec%\s*&\s*)?/i,
    "",
  );
  const tokens = [...body.matchAll(/"([^"]*)"|(\S+)/g)].map((token) => token[1] ?? token[2]);
  if (tokens.length < 2 || tokens[0] !== "%_prog%" || tokens.at(-1) !== "%*") return null;

  const constants = tokens.slice(1, -1);
  if (constants.length === 0) return null;
  const entrypoint = expandDp0(constants.at(-1), shimDir);
  if (!entrypoint || !existsSync(entrypoint)) return null;

  // Mirrors the shim's IF EXIST chain: prefer a dp0-local node, then the
  // bare %PATH% node the ELSE branch would have invoked.
  let progCommand = null;
  let pathFallback = null;
  for (const candidate of progCandidates) {
    if (!candidate.toLowerCase().startsWith("%dp0%")) {
      pathFallback ??= candidate;
      continue;
    }
    const expanded = expandDp0(candidate, shimDir);
    if (existsSync(expanded)) {
      progCommand = expanded;
      break;
    }
  }
  if (!progCommand) progCommand = pathFallback ?? "node";

  const prefixArgs = constants.slice(0, -1).map((value) => expandDp0(value, shimDir));
  prefixArgs.push(entrypoint);
  return { command: progCommand, prefixArgs };
}

// Resolves a Windows .cmd/.bat launcher to a direct process spawn. Returns
// the parsed descriptor, or null when the shim cannot be interpreted (the
// caller then falls back to launching through cmd.exe).
export async function parseWindowsCmdShim(command, platform = process.platform) {
  if (!isWindowsCommand(command, platform)) return null;
  let source;
  try {
    source = await readFile(command, "utf8");
  } catch {
    return null;
  }
  const npmTemplate = parseNpmTemplateShim(source, command);
  if (npmTemplate) return npmTemplate;

  const match = source.match(
    /(?:"([^"\r\n]*node(?:\.exe)?)"|([^\s"\r\n]*node(?:\.exe)?))\s+"([^"\r\n]+\.(?:[cm]?js))"\s+%\*/i,
  );
  if (!match) return null;

  const nodeCandidate = expandLegacyShimPath(match[1] ?? match[2], command);
  const entrypoint = expandLegacyShimPath(match[3], command);
  if (!existsSync(entrypoint)) return null;
  return {
    command: existsSync(nodeCandidate) ? nodeCandidate : "node",
    prefixArgs: [entrypoint],
  };
}

// Backward-compatible name for the raw shim parser.
export const resolveWindowsCmdShim = parseWindowsCmdShim;

// Complete launch descriptor for every platform and command kind:
//   - non-Windows or non-batch: launch the command itself, no shell
//   - parsed Windows shim: launch the shim's Node interpreter directly
//   - unparseable Windows shim: leave it to cmd.exe (shell: true)
export async function resolveWindowsLaunch(command, platform = process.platform) {
  if (!isWindowsCommand(command, platform)) {
    return { command, prefixArgs: [], shell: false };
  }
  const parsed = await parseWindowsCmdShim(command, platform);
  if (parsed) return { ...parsed, shell: false };
  return { command, prefixArgs: [], shell: true };
}
