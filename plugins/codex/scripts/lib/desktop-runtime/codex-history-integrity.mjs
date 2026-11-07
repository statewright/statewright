import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, copyFile, link, mkdir, open, opendir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Transform } from "node:stream";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COMPRESSED_ROLLOUT_BYTES = 128 * 1024 * 1024;
const MAX_MATERIALIZED_ROLLOUT_BYTES = 512 * 1024 * 1024;
const REPAIR_MODES = new Set(["guard", "repair", "auto", "prompt", "off"]);
const CODEX_OPTIONS_WITH_VALUE = new Set([
  "-a", "--ask-for-approval", "-C", "--cd", "-c", "--config", "--local-provider",
  "-m", "--model", "-p", "--profile", "--remote", "--remote-auth-token-env",
  "-s", "--sandbox", "--add-dir",
]);
const CODEX_TOP_LEVEL_COMMANDS = new Set([
  "agents", "app", "app-server", "apply", "archive", "cloud", "completion", "debug", "delete",
  "doctor", "e", "exec", "exec-server", "features", "fork", "help", "login", "logout", "mcp",
  "mcp-server", "migrate-rollouts", "plugin", "queue", "remote-control", "resume", "review", "sandbox",
  "unarchive", "update",
]);
const WRITER_LOCK_HELPER = String.raw`
use Fcntl qw(:flock);
my ($coord_path, $thread_path) = @ARGV;
open(my $coord, "+>>", $coord_path) or exit 76;
flock($coord, LOCK_EX) or exit 76;
open(my $lock, "+>>", $thread_path) or exit 76;
flock($lock, LOCK_EX | LOCK_NB) or exit 75;
close($coord) or exit 76;
select(STDOUT); $| = 1; print "LOCKED\n";
while (<STDIN>) {}
open($coord, "+>>", $coord_path) or exit 77;
flock($coord, LOCK_EX) or exit 77;
close($lock) or exit 77;
unlink($thread_path) unless !-e $thread_path;
close($coord) or exit 77;
`;

export class CodexHistoryIntegrityError extends Error {
  constructor(message, { code, inspection = null, cause = null } = {}) {
    super(message);
    this.name = "CodexHistoryIntegrityError";
    this.code = code;
    Object.defineProperty(this, "inspection", { value: inspection, enumerable: false });
    Object.defineProperty(this, "cause", { value: cause, enumerable: false });
  }
}

async function pathExists(path) {
  return access(path).then(() => true, () => false);
}

async function sha256(path) {
  const digest = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest("hex");
}

async function syncFile(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function parseTomlPathValue(raw) {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (/^(?:true|false|[+-]?(?:\d+(?:\.\d*)?|\.\d+)|[\[{])/.test(value)) return null;
  if (!/[\s#]/.test(value)) return value;
  return null;
}

function topLevelTomlPath(source, key) {
  let section = "";
  let result = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (sectionMatch) { section = sectionMatch[1].trim(); continue; }
    if (section || !line.startsWith(key)) continue;
    const assignment = line.match(new RegExp(`^${key}\\s*=\\s*(.+)$`));
    if (!assignment) continue;
    const parsed = parseTomlPathValue(assignment[1].replace(/\s+#.*$/, ""));
    if (!parsed || result !== null) throw new CodexHistoryIntegrityError("Statewright cannot safely resolve Codex's configured storage paths. No unverified resume was started.", { code: "CODEX_HISTORY_STORAGE_UNRESOLVED" });
    result = parsed;
  }
  return result;
}

function cliSqliteHome(args = []) {
  let result = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--") break;
    let override = null;
    if (args[index] === "-c" || args[index] === "--config") override = args[++index] ?? "";
    else if (args[index].startsWith("-c") && !args[index].startsWith("--") && args[index].length > 2) override = args[index].slice(2).replace(/^=/, "");
    else if (args[index].startsWith("--config=")) override = args[index].slice("--config=".length);
    else if (args[index] === "-i" || args[index] === "--image") {
      while (index + 1 < args.length && !args[index + 1].startsWith("-") && !CODEX_TOP_LEVEL_COMMANDS.has(args[index + 1])) index += 1;
      continue;
    } else if (CODEX_OPTIONS_WITH_VALUE.has(args[index])) { index += 1; continue; }
    if (!override) continue;
    const match = override.match(/^sqlite_home\s*=\s*(.+)$/);
    if (!match) continue;
    const parsed = parseTomlPathValue(match[1]);
    if (!parsed) throw new CodexHistoryIntegrityError("Statewright cannot safely resolve Codex's configured storage paths. No unverified resume was started.", { code: "CODEX_HISTORY_STORAGE_UNRESOLVED" });
    result = parsed;
  }
  return result;
}

async function effectiveCodexCwd(args, cwd) {
  let requested = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") break;
    if (argument === "-C" || argument === "--cd") requested = args[++index] ?? "";
    else if (argument.startsWith("-C") && !argument.startsWith("--") && argument.length > 2) requested = argument.slice(2).replace(/^=/, "");
    else if (argument.startsWith("--cd=")) requested = argument.slice("--cd=".length);
    else if (argument === "-i" || argument === "--image") {
      while (index + 1 < args.length && !args[index + 1].startsWith("-") && !CODEX_TOP_LEVEL_COMMANDS.has(args[index + 1])) index += 1;
    } else if (CODEX_OPTIONS_WITH_VALUE.has(argument)) index += 1;
  }
  if (!requested) return cwd;
  return absoluteDirectory(requested, { base: cwd, configured: true });
}

async function absoluteDirectory(value, { base, configured, requireAbsolute = false }) {
  if (requireAbsolute && !isAbsolute(value)) throw new CodexHistoryIntegrityError("Statewright cannot safely resolve Codex's configured storage paths. No unverified resume was started.", { code: "CODEX_HISTORY_STORAGE_UNRESOLVED" });
  const candidate = isAbsolute(value) ? value : resolve(base, value);
  if (configured) {
    const canonical = await realpath(candidate).catch(() => null);
    if (!canonical || !(await stat(canonical)).isDirectory()) throw new CodexHistoryIntegrityError("Statewright cannot safely resolve Codex's configured storage paths. No unverified resume was started.", { code: "CODEX_HISTORY_STORAGE_UNRESOLVED" });
    return canonical;
  }
  return candidate;
}

export async function resolveCodexHistoryStorage({ home = homedir(), cwd = process.cwd(), environment = process.env, args = [] } = {}) {
  const configuredCodexHome = String(environment.CODEX_HOME ?? "").trim();
  const codexHome = await absoluteDirectory(configuredCodexHome || join(home, ".codex"), { base: cwd, configured: Boolean(configuredCodexHome), requireAbsolute: Boolean(configuredCodexHome) });
  const effectiveCwd = await effectiveCodexCwd(args, cwd);
  let configuredSqliteHome = null;
  const configPath = join(codexHome, "config.toml");
  if (await pathExists(configPath)) configuredSqliteHome = topLevelTomlPath(await readFile(configPath, "utf8"), "sqlite_home");
  const envSqliteHome = String(environment.CODEX_SQLITE_HOME ?? "").trim() || null;
  const overrideSqliteHome = cliSqliteHome(args);
  let sqliteHome = codexHome;
  if (overrideSqliteHome) sqliteHome = await absoluteDirectory(overrideSqliteHome, { base: effectiveCwd, configured: true });
  else if (configuredSqliteHome) sqliteHome = await absoluteDirectory(configuredSqliteHome, { base: codexHome, configured: true });
  else if (envSqliteHome) sqliteHome = await absoluteDirectory(envSqliteHome, { base: effectiveCwd, configured: true });
  return {
    codexHome,
    effectiveCwd,
    sqliteHome,
    sessionsRoot: join(codexHome, "sessions"),
    writerLockRoot: join(codexHome, "thread-writer-locks"),
    projectionPath: join(sqliteHome, "thread_history_1.sqlite"),
  };
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function findRollouts(root, sessionId, matches = []) {
  if (!await pathExists(root)) return matches;
  const directory = await opendir(root);
  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await findRollouts(path, sessionId, matches);
    else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) matches.push(path);
  }
  return matches;
}

async function findCompressedRollouts(root, sessionId, matches = []) {
  if (!await pathExists(root)) return matches;
  const directory = await opendir(root);
  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await findCompressedRollouts(path, sessionId, matches);
    else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl.zst`)) matches.push(path);
  }
  return matches;
}

let nativeZstdVerified;
async function decompressRollout(archivePath, boundedOutput, destination, environment) {
  const zlib = await import("node:zlib");
  const { pipeline } = await import("node:stream/promises");
  if (nativeZstdVerified === undefined) {
    nativeZstdVerified = false;
    if (typeof zlib.createZstdDecompress === "function" && typeof zlib.zstdCompressSync === "function") {
      // Some Node releases silently accept incomplete frames. JSON validation
      // alone cannot detect an archive truncated at a valid record boundary.
      const frame = zlib.zstdCompressSync(Buffer.from("statewright archive integrity probe"));
      try { zlib.zstdDecompressSync(frame.subarray(0, frame.length - 1)); }
      catch (error) { nativeZstdVerified = error.code === "Z_BUF_ERROR"; }
    }
  }
  if (nativeZstdVerified) {
    return pipeline(createReadStream(archivePath), zlib.createZstdDecompress(), boundedOutput, destination);
  }
  const child = spawn("zstd", ["--decompress", "--stdout", "--quiet", "--", archivePath], {
    env: environment, stdio: ["ignore", "pipe", "ignore"], shell: false,
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", cause => rejectExit(new CodexHistoryIntegrityError(
      "This Node runtime cannot verify incomplete Zstd frames and the zstd executable is unavailable. Install zstd or use a Node runtime with verified Zstd EOF checks before resuming this archive.",
      { code: "CODEX_HISTORY_ZSTD_UNAVAILABLE", cause },
    )));
    child.once("close", code => code === 0 ? resolveExit() : rejectExit(new CodexHistoryIntegrityError(
      "Zstd rejected the compressed history stream. The archive was retained and no canonical rollout was installed.",
      { code: "CODEX_HISTORY_ARCHIVE_MATERIALIZATION_FAILED" },
    )));
  });
  try { await Promise.all([pipeline(child.stdout, boundedOutput, destination), exited]); }
  finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited.catch(() => {});
  }
}

async function materializeCompressedRollout({ archivePath, sessionId, operations = {}, checkCurrentRequest, environment, requiredPrefix = null }) {
  const canonicalPath = archivePath.slice(0, -4);
  if (!recognizedFilename(canonicalPath, sessionId)) {
    throw new CodexHistoryIntegrityError("Statewright found a compressed Codex history with an unrecognized canonical filename and will not materialize it.", { code: "CODEX_HISTORY_UNSAFE" });
  }
  if (await pathExists(canonicalPath)) return canonicalPath;
  const archiveIdentity = sourceIdentity(await stat(archivePath));
  const maxCompressedBytes = Math.min(operations.maxCompressedBytes ?? MAX_COMPRESSED_ROLLOUT_BYTES, MAX_COMPRESSED_ROLLOUT_BYTES);
  const maxMaterializedBytes = Math.min(operations.maxMaterializedBytes ?? MAX_MATERIALIZED_ROLLOUT_BYTES, MAX_MATERIALIZED_ROLLOUT_BYTES);
  if (archiveIdentity.size > maxCompressedBytes) {
    throw new CodexHistoryIntegrityError("Statewright will not materialize a compressed Codex rollout larger than the bounded recovery limit. The archive was retained and no resume was started.", { code: "CODEX_HISTORY_ARCHIVE_TOO_LARGE" });
  }
  const archiveSha256 = await sha256(archivePath);
  const temporary = `${canonicalPath}.statewright-hydrate-${process.pid}-${randomUUID()}.tmp`;
  try {
    let materializedBytes = 0;
    const boundedOutput = new Transform({
      transform(chunk, encoding, callback) {
        materializedBytes += chunk.length;
        if (materializedBytes > maxMaterializedBytes) {
          callback(new CodexHistoryIntegrityError("Statewright will not materialize compressed Codex history beyond the bounded recovery limit. The archive was retained and no canonical rollout was installed.", { code: "CODEX_HISTORY_ARCHIVE_EXPANSION_LIMIT" }));
          return;
        }
        callback(null, chunk);
      },
    });
    await decompressRollout(archivePath, boundedOutput, createWriteStream(temporary, { flags: "wx", mode: 0o600 }), environment);
    await syncFile(temporary);
    const inspection = await inspectRolloutPath(temporary, sessionId, { requireCanonicalFilename: false });
    if (inspection.status !== "healthy") {
      throw new CodexHistoryIntegrityError("The compressed Codex history did not satisfy the canonical identity and ordinal contract, so Statewright did not materialize it.", { code: "CODEX_HISTORY_UNSAFE", inspection });
    }
    if (requiredPrefix) {
      const prefix = await inspectRolloutPath(temporary, sessionId, { requireCanonicalFilename: false, endByteExclusive: requiredPrefix.end_byte_offset });
      if (prefix.status !== "healthy" || prefix.historyMode !== "paginated"
        || prefix.finalOrdinal !== requiredPrefix.end_ordinal_exclusive - 1
        || requiredPrefix.ancestorIds.includes(prefix.historyBase?.thread_id)) {
        throw new CodexHistoryIntegrityError("The compressed Codex ancestor does not match the required inherited prefix or introduces an ancestry cycle. The archive was retained and no ancestor was installed.", { code: "CODEX_HISTORY_UNSAFE", inspection: prefix });
      }
    }
    await operations.beforeArchiveInstall?.({ archivePath, canonicalPath });
    const currentArchiveIdentity = sourceIdentity(await stat(archivePath));
    if (!sameSourceIdentity(currentArchiveIdentity, archiveIdentity) || await sha256(archivePath) !== archiveSha256) {
      throw new CodexHistoryIntegrityError("Compressed Codex history changed while Statewright prepared recovery. The archive was retained and no canonical rollout was installed.", { code: "CODEX_HISTORY_SOURCE_CHANGED" });
    }
    // link() is atomic and refuses an existing destination; rename() could overwrite
    // a concurrently-created canonical rollout.
    checkCurrentRequest();
    await link(temporary, canonicalPath);
    await syncFile(canonicalPath);
    await syncDirectory(dirname(canonicalPath));
    return canonicalPath;
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new CodexHistoryIntegrityError("A canonical Codex rollout appeared while Statewright prepared compressed history. Nothing was replaced; retry once the writer is idle.", { code: "CODEX_HISTORY_SOURCE_CHANGED", cause: error });
    }
    if (error instanceof CodexHistoryIntegrityError || error?.code === "STATEWRIGHT_SUPERSEDED") throw error;
    throw new CodexHistoryIntegrityError("Statewright could not safely materialize compressed Codex history. The archive was retained and no resume was started.", { code: "CODEX_HISTORY_ARCHIVE_MATERIALIZATION_FAILED", cause: error });
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function findCodexRollout({ home = homedir(), codexHome = join(home, ".codex"), sessionId }) {
  if (!SESSION_ID_PATTERN.test(String(sessionId ?? ""))) {
    throw new CodexHistoryIntegrityError("Statewright cannot inspect Codex history without an explicit durable session ID.", { code: "CODEX_HISTORY_INVALID_SESSION" });
  }
  const matches = await findRollouts(join(codexHome, "sessions"), sessionId);
  if (matches.length > 1) {
    throw new CodexHistoryIntegrityError("Statewright found more than one rollout for the requested Codex session and will not guess which one is canonical.", { code: "CODEX_HISTORY_AMBIGUOUS" });
  }
  return matches[0] ?? null;
}

async function materializeArchivedRollout({ storage, sessionId, mode, confirmRepair, inspection, dependencyOf = null }) {
  const archives = await findCompressedRollouts(storage.sessionsRoot, sessionId);
  if (archives.length > 1) {
    throw new CodexHistoryIntegrityError("Statewright found more than one compressed rollout for the requested Codex session and will not guess which one is canonical.", { code: "CODEX_HISTORY_AMBIGUOUS" });
  }
  if (archives.length === 0) return null;
  if (mode === "guard") {
    const subject = dependencyOf ? "This Codex session requires compressed ancestor history, but" : "Statewright found valid-looking compressed Codex history but";
    throw new CodexHistoryIntegrityError(`${subject} guard mode will not materialize it. Re-run interactively with history repair set to prompt or auto after every writer for the affected threads is idle.`, { code: "CODEX_HISTORY_ARCHIVE_MATERIALIZATION_REQUIRED", inspection });
  }
  await requireRepairConsent({
    mode,
    confirmRepair,
    message: dependencyOf
      ? "[statewright] This Codex session requires compressed ancestor history. Materialize and validate its canonical .jsonl without deleting the archive? [y/N] "
      : "[statewright] Codex retained this session only as compressed history. Materialize and validate the canonical .jsonl without deleting the archive? [y/N] ",
    inspection,
  });
  return archives[0];
}

function recognizedFilename(path, sessionId) {
  const escaped = sessionId.replaceAll("-", "\\-");
  return new RegExp(`^rollout-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-${escaped}\\.jsonl$`, "i").test(basename(path));
}

function recognizedDuplicate(row, priorOrdinal) {
  return row?.ordinal === priorOrdinal && row?.type === "event_msg" && row?.payload?.type === "thread_settings_applied";
}

function sourceIdentity(fileStat) {
  return { device: fileStat.dev, inode: fileStat.ino, size: fileStat.size, modified_ms: fileStat.mtimeMs };
}

function sameSourceIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode && left.size === right.size && left.modified_ms === right.modified_ms;
}

// JSONL records end at LF, not Unicode line/paragraph separators inside strings.
// Use the stream's UTF-8 decoder so a multibyte character may cross chunks.
export async function* readCodexRolloutLines(path, options = {}) {
  let fragments = [];
  for await (const chunk of createReadStream(path, { ...options, encoding: "utf8" })) {
    let start = 0;
    for (let end = chunk.indexOf("\n", start); end !== -1; end = chunk.indexOf("\n", start)) {
      fragments.push(chunk.slice(start, end));
      // Preserve the existing normalized-hash rejection of CRLF input.
      yield fragments.join("").replace(/\r$/, "");
      fragments = [];
      start = end + 1;
    }
    if (start < chunk.length) fragments.push(chunk.slice(start));
  }
  // The inspector's hash comparison rejects a missing final LF.
  if (fragments.length) yield fragments.join("").replace(/\r$/, "");
}

function historyStartOrdinal(metadata, expectedSessionId) {
  const base = metadata?.history_base;
  if (base == null) return 0;
  if (typeof base !== "object" || Array.isArray(base)
    || !SESSION_ID_PATTERN.test(String(base.thread_id ?? "")) || base.thread_id === expectedSessionId
    || !Number.isSafeInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive <= 0
    || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset <= 0
    || (metadata.forked_from_id != null && metadata.forked_from_id !== base.thread_id)
    || (metadata.forked_from_ordinal_exclusive != null && metadata.forked_from_ordinal_exclusive !== base.end_ordinal_exclusive)) return null;
  return base.end_ordinal_exclusive;
}

async function inspectRolloutPath(path, expectedSessionId, { requireCanonicalFilename = true, endByteExclusive = null } = {}) {
  const sourceStat = sourceIdentity(await stat(path));
  const normalizedSourceHash = createHash("sha256");
  const keptHash = createHash("sha256");
  const anomalies = [];
  let duplicateSettingsCount = 0;
  let finalOrdinal = null;
  let historyMode = null;
  let lineNumber = 0;
  let priorOrdinal = null;
  let sessionMetaCount = 0;
  let historyBase = null;
  let startOrdinal = 0;

  if (requireCanonicalFilename && !recognizedFilename(path, expectedSessionId)) anomalies.push({ kind: "unrecognized_rollout_filename", line: 0 });
  const prefixOptions = endByteExclusive === null ? {} : { end: endByteExclusive - 1 };
  const lines = readCodexRolloutLines(path, prefixOptions);
  for await (const line of lines) {
    lineNumber += 1;
    normalizedSourceHash.update(line).update("\n");
    let row;
    try { row = JSON.parse(line); } catch {
      anomalies.push({ kind: "malformed_json", line: lineNumber });
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.type !== "string" || row.type.length === 0) {
      anomalies.push({ kind: "invalid_record_shape", line: lineNumber });
      keptHash.update(line).update("\n");
      continue;
    }
    if (lineNumber === 1 && row?.type !== "session_meta") anomalies.push({ kind: "invalid_root_record", line: lineNumber });
    if (row?.type === "session_meta") {
      sessionMetaCount += 1;
      if (lineNumber !== 1) anomalies.push({ kind: "late_or_duplicate_session_meta", line: lineNumber });
      if (row?.payload?.id !== expectedSessionId) anomalies.push({ kind: "session_identity_mismatch", line: lineNumber });
      if (lineNumber === 1) {
        const snakeMode = row?.payload?.history_mode;
        const camelMode = row?.payload?.historyMode;
        if (snakeMode != null && camelMode != null && snakeMode !== camelMode) anomalies.push({ kind: "conflicting_history_mode", line: lineNumber });
        historyMode = snakeMode ?? camelMode ?? null;
        historyBase = row.payload?.history_base ?? null;
        startOrdinal = historyStartOrdinal(row.payload, expectedSessionId);
        if (startOrdinal === null || (historyBase !== null && historyMode !== "paginated")) anomalies.push({ kind: "invalid_history_base", line: lineNumber });
      }
    }
    if (historyMode === "legacy") {
      if (Object.hasOwn(row, "ordinal")) anomalies.push({ kind: "unexpected_ordinal", line: lineNumber, ordinal: row.ordinal ?? null });
      keptHash.update(line).update("\n");
      continue;
    }
    if (lineNumber === 1 && row?.ordinal !== startOrdinal) anomalies.push({ kind: "invalid_root_record", line: lineNumber });
    if (!Number.isSafeInteger(row?.ordinal) || row.ordinal < 0) {
      anomalies.push({ kind: "missing_ordinal", line: lineNumber });
      keptHash.update(line).update("\n");
      continue;
    }
    if (priorOrdinal !== null && row.ordinal !== priorOrdinal + 1) {
      if (recognizedDuplicate(row, priorOrdinal)) {
        duplicateSettingsCount += 1;
        continue;
      }
      anomalies.push({ kind: row.ordinal <= priorOrdinal ? "ordinal_regression" : "ordinal_gap", line: lineNumber, prior_ordinal: priorOrdinal, ordinal: row.ordinal, record_type: row.type ?? null, payload_type: row?.payload?.type ?? null });
    }
    priorOrdinal = row.ordinal;
    finalOrdinal = row.ordinal;
    keptHash.update(line).update("\n");
  }
  if (sessionMetaCount !== 1) anomalies.push({ kind: "invalid_session_meta_count", line: 0, count: sessionMetaCount });
  const sourceDigest = createHash("sha256");
  for await (const chunk of createReadStream(path, prefixOptions)) sourceDigest.update(chunk);
  const sourceSha256 = sourceDigest.digest("hex");
  if (sourceSha256 !== normalizedSourceHash.digest("hex")) anomalies.push({ kind: "noncanonical_line_endings_or_final_newline", line: 0 });
  if (endByteExclusive !== null && sourceStat.size < endByteExclusive) anomalies.push({ kind: "history_base_out_of_bounds", line: 0 });
  const status = anomalies.length > 0 ? "unsafe" : duplicateSettingsCount > 0 ? "repairable" : "healthy";
  return {
    status, path, historyMode, historyBase, startOrdinal, lineCount: lineNumber, finalOrdinal, duplicateSettingsCount,
    unknownAnomalies: anomalies,
    sourceIdentity: sourceStat,
    sourceSha256,
    repairedSha256: keptHash.digest("hex"),
  };
}

export async function inspectCodexHistory({ home = homedir(), codexHome = join(home, ".codex"), sessionId }) {
  const path = await findCodexRollout({ home, codexHome, sessionId });
  if (!path) return { status: "not_found", path: null, historyMode: null, finalOrdinal: null, duplicateSettingsCount: 0, unknownAnomalies: [] };
  const inspection = await inspectRolloutPath(path, sessionId);
  inspection.historyDependencies = [];
  // A fork stores its local suffix at the inherited end ordinal, not at zero.
  // Validate only the parent's referenced prefix: later parent turns are unrelated.
  // Never repair an ancestor or silently accept a missing/cyclic ancestry chain.
  let current = inspection;
  const visited = new Set([sessionId]);
  while (current.status === "healthy" || current.status === "repairable") {
    const base = current.historyBase;
    if (!base) break;
    let failure = null;
    if (visited.has(base.thread_id) || visited.size >= 64) failure = "history_base_cycle_or_depth";
    else {
      visited.add(base.thread_id);
      const parentPath = await findCodexRollout({ codexHome, sessionId: base.thread_id });
      if (!parentPath) {
        const archives = await findCompressedRollouts(join(codexHome, "sessions"), base.thread_id);
        if (archives.length > 1) {
          throw new CodexHistoryIntegrityError("Statewright found more than one compressed rollout for a required Codex ancestor and will not guess which one is canonical.", { code: "CODEX_HISTORY_AMBIGUOUS" });
        }
        failure = archives.length ? "history_base_compressed" : "history_base_missing";
        if (archives.length) inspection.compressedHistoryBase = { ...base, archivePath: archives[0], ancestorIds: [...visited] };
      }
      else {
        const parent = await inspectRolloutPath(parentPath, base.thread_id, { endByteExclusive: base.end_byte_offset });
        if (parent.status !== "healthy" || parent.historyMode !== "paginated"
          || parent.finalOrdinal !== base.end_ordinal_exclusive - 1) failure = "history_base_prefix_invalid";
        else {
          inspection.historyDependencies.push({ path: parentPath, endByteExclusive: base.end_byte_offset, sha256: parent.sourceSha256 });
          current = parent;
        }
      }
    }
    if (failure) {
      inspection.unknownAnomalies.push({ kind: failure, line: 1 });
      inspection.status = "unsafe";
      break;
    }
  }
  return inspection;
}

async function recoverCompressedHistoryBase({ inspection, home, storage, sessionId, mode, confirmRepair, environment, withWriterLock, operations, checkCurrentRequest }) {
  const base = inspection.compressedHistoryBase;
  const changed = () => new CodexHistoryIntegrityError("Codex history or its required ancestor changed while preparing archive recovery. No unverified ancestor was installed; retry after every affected writer is idle.", { code: "CODEX_HISTORY_SOURCE_CHANGED" });
  const archivePath = await materializeArchivedRollout({ storage, sessionId: base.thread_id, mode, confirmRepair, inspection, dependencyOf: sessionId });
  if (archivePath !== base.archivePath) throw changed();
  const assertSnapshot = current => {
    if (current.sourceSha256 !== inspection.sourceSha256
      || JSON.stringify(current.historyDependencies) !== JSON.stringify(inspection.historyDependencies)
      || JSON.stringify(current.compressedHistoryBase) !== JSON.stringify(base)) throw changed();
  };
  // Own both the requested thread and this exact ancestor. Never repair parent
  // records or reset a parent's projection while restoring an archived dependency.
  const lockOptions = { home, codexHome: storage.codexHome, writerLockRoot: storage.writerLockRoot, environment };
  await withWriterLock({ ...lockOptions, sessionId }, async () => {
    await withWriterLock({ ...lockOptions, sessionId: base.thread_id }, async () => {
      checkCurrentRequest();
      const current = await inspectCodexHistory({ home, codexHome: storage.codexHome, sessionId });
      if (current.sourceSha256 !== inspection.sourceSha256) throw changed();
      // Another lock owner may have restored the same dependency while consent
      // was open. Reuse it only after normal ancestry validation succeeds.
      if (!current.compressedHistoryBase && ["healthy", "repairable"].includes(current.status)) return;
      assertSnapshot(current);
      await materializeCompressedRollout({ archivePath, sessionId: base.thread_id, environment, checkCurrentRequest, requiredPrefix: base,
        operations: { ...operations, beforeArchiveInstall: async details => {
          await operations.beforeArchiveInstall?.(details);
          assertSnapshot(await inspectCodexHistory({ home, codexHome: storage.codexHome, sessionId }));
        } },
      });
    });
  });
}

function waitForWriterLock(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.removeAllListeners();
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      operation();
    };
    const timeout = setTimeout(() => finish(() => {
      child.kill("SIGTERM");
      reject(new CodexHistoryIntegrityError("Statewright could not prove exclusive ownership of the Codex history writer lock.", { code: "CODEX_HISTORY_WRITER_LOCK_TIMEOUT" }));
    }), 2_000);
    child.once("error", (error) => finish(() => reject(new CodexHistoryIntegrityError("Statewright cannot acquire Codex's native history writer lock on this platform.", { code: "CODEX_HISTORY_WRITER_LOCK_UNAVAILABLE", cause: error }))));
    child.once("exit", (code) => finish(() => reject(new CodexHistoryIntegrityError(
      code === 75 ? "Statewright will not repair Codex history while that thread has an active writer. Exit the other Codex session and retry." : "Statewright cannot acquire Codex's native history writer lock on this platform.",
      { code: code === 75 ? "CODEX_HISTORY_ACTIVE_WRITER" : "CODEX_HISTORY_WRITER_LOCK_UNAVAILABLE" },
    ))));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("LOCKED\n")) finish(resolve);
    });
  });
}

async function releaseWriterLock(child) {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  await Promise.race([exited, new Promise((resolve) => setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 1_000))]);
}

export async function withCodexWriterLock({ home = homedir(), codexHome = join(home, ".codex"), writerLockRoot = join(codexHome, "thread-writer-locks"), sessionId, environment = process.env }, operation) {
  if (process.platform === "win32") throw new CodexHistoryIntegrityError("Automatic Codex history repair is unavailable on Windows because Statewright cannot prove native writer-lock ownership. Guard mode remains active.", { code: "CODEX_HISTORY_WRITER_LOCK_UNAVAILABLE" });
  await mkdir(writerLockRoot, { recursive: true, mode: 0o700 });
  const child = spawn("perl", ["-MFcntl=:flock", "-e", WRITER_LOCK_HELPER, join(writerLockRoot, ".coordination.lock"), join(writerLockRoot, `${sessionId}.lock`)], {
    env: { ...environment, LC_ALL: "C", LANG: "C" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  await waitForWriterLock(child);
  try { return await operation(); } finally { await releaseWriterLock(child); }
}

async function replaceFromBackup(source, destination) {
  const temporary = `${destination}.statewright-restore-${process.pid}-${randomUUID()}`;
  await copyFile(source, temporary);
  await syncFile(temporary);
  await rename(temporary, destination);
  await syncDirectory(dirname(destination));
}

async function writeRepairedRollout(source, destination) {
  const sourceMode = (await stat(source)).mode & 0o777;
  const handle = await open(destination, "wx", sourceMode);
  let priorOrdinal = null;
  let droppedRecords = 0;
  try {
    const lines = readCodexRolloutLines(source);
    for await (const line of lines) {
      const row = JSON.parse(line);
      if (priorOrdinal !== null && recognizedDuplicate(row, priorOrdinal)) { droppedRecords += 1; continue; }
      await handle.write(`${line}\n`);
      if (Number.isInteger(row?.ordinal)) priorOrdinal = row.ordinal;
    }
    await handle.sync();
  } finally { await handle.close(); }
  await chmod(destination, sourceMode);
  return droppedRecords;
}

async function openProjection() {
  const sqlite = await import("node:sqlite").catch(() => null);
  if (!sqlite?.DatabaseSync || !sqlite?.backup) throw new CodexHistoryIntegrityError("This Node runtime cannot safely back up and rebuild Codex's paginated history projection. Upgrade Node or leave Statewright history repair in guard mode.", { code: "CODEX_HISTORY_SQLITE_UNAVAILABLE" });
  return sqlite;
}

function projectionIntegrity(database) {
  const rows = database.prepare("PRAGMA integrity_check").all();
  return rows.length === 1 && Object.values(rows[0])[0] === "ok";
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function targetScopedRollbackSql({ projectionBackup, sessionId }) {
  if (!projectionBackup) return null;
  const id = sqlLiteral(sessionId);
  return [
    `ATTACH DATABASE ${sqlLiteral(projectionBackup)} AS statewright_backup;`, "BEGIN IMMEDIATE;",
    `DELETE FROM thread_items WHERE thread_id = ${id};`, `DELETE FROM thread_turns WHERE thread_id = ${id};`,
    `DELETE FROM thread_realtime_items WHERE thread_id = ${id};`, `DELETE FROM thread_history_projection_state WHERE thread_id = ${id};`,
    `INSERT INTO thread_items SELECT * FROM statewright_backup.thread_items WHERE thread_id = ${id};`,
    `INSERT INTO thread_turns SELECT * FROM statewright_backup.thread_turns WHERE thread_id = ${id};`,
    `INSERT INTO thread_realtime_items SELECT * FROM statewright_backup.thread_realtime_items WHERE thread_id = ${id};`,
    `INSERT INTO thread_history_projection_state SELECT * FROM statewright_backup.thread_history_projection_state WHERE thread_id = ${id};`,
    "COMMIT;", "DETACH DATABASE statewright_backup;",
  ].join("\n");
}

async function prepareBackup({ backupRoot, inspection, projectionPath, sessionId, writeManifest, onDurabilityEvent = async () => {} }) {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupDir = join(backupRoot, `statewright-codex-history-${stamp}-${sessionId.slice(0, 8)}`);
  const backupRootExisted = await pathExists(backupRoot);
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await onDurabilityEvent("backup_root_created");
  if (!backupRootExisted) {
    await syncDirectory(dirname(backupRoot));
    await onDurabilityEvent("backup_parent_synced");
  }
  await mkdir(backupDir, { recursive: false, mode: 0o700 });
  await onDurabilityEvent("backup_dir_created");
  await syncDirectory(backupRoot);
  await onDurabilityEvent("backup_root_synced");
  const rolloutBackup = join(backupDir, "rollout.jsonl");
  const projectionBackup = await pathExists(projectionPath) ? join(backupDir, "thread_history_1.sqlite") : null;
  const manifestPath = join(backupDir, "manifest.json");
  const manifest = {
    version: 2, state: "preparing", created_at: new Date().toISOString(), thread_id: sessionId,
    rollout_path: inspection.path, rollout_backup: rolloutBackup, rollout_original_sha256: null,
    projection_path: projectionPath, projection_backup: projectionBackup, projection_backup_sha256: null,
    dropped_records: inspection.duplicateSettingsCount,
    target_scoped_projection_restore_sql: targetScopedRollbackSql({ projectionBackup, sessionId }),
    rollback: "Stop every Codex writer. Restore only this rollout, then use target_scoped_projection_restore_sql for this thread. Restoring the entire shared projection database is offline disaster recovery and rewinds every thread changed after this backup.",
  };
  await writeManifest(manifestPath, manifest);
  try {
    await copyFile(inspection.path, rolloutBackup);
    await chmod(rolloutBackup, 0o600);
    await syncFile(rolloutBackup);
    manifest.rollout_original_sha256 = await sha256(rolloutBackup);
    if (manifest.rollout_original_sha256 !== inspection.sourceSha256) throw new Error("rollout changed during backup");
    if (projectionBackup) {
      const sqlite = await openProjection();
      const database = new sqlite.DatabaseSync(projectionPath, { readOnly: true });
      try {
        if (!projectionIntegrity(database)) throw new Error("projection integrity check failed");
        await sqlite.backup(database, projectionBackup);
      } finally { database.close(); }
      await chmod(projectionBackup, 0o600);
      await syncFile(projectionBackup);
      manifest.projection_backup_sha256 = await sha256(projectionBackup);
    }
    manifest.state = "prepared";
    await writeManifest(manifestPath, manifest);
    return { backupDir, rolloutBackup, projectionBackup, manifest, manifestPath };
  } catch (error) {
    manifest.state = "backup_failed";
    manifest.failed_at = new Date().toISOString();
    manifest.failure = "Backup preparation failed before canonical history mutation.";
    await writeManifest(manifestPath, manifest).catch(() => {});
    throw new CodexHistoryIntegrityError("Statewright could not complete a durable Codex history backup, so it did not modify the session.", { code: "CODEX_HISTORY_BACKUP_FAILED", cause: error });
  }
}

function clearThreadProjection(database, sessionId) {
  if (!projectionIntegrity(database)) throw new Error("projection integrity check failed before reset");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM thread_items WHERE thread_id = ?").run(sessionId);
    database.prepare("DELETE FROM thread_turns WHERE thread_id = ?").run(sessionId);
    database.prepare("DELETE FROM thread_realtime_items WHERE thread_id = ?").run(sessionId);
    database.prepare("DELETE FROM thread_history_projection_state WHERE thread_id = ?").run(sessionId);
    for (const table of ["thread_items", "thread_turns", "thread_realtime_items", "thread_history_projection_state"]) {
      if (database.prepare(`SELECT count(*) AS count FROM ${table} WHERE thread_id = ?`).get(sessionId).count !== 0) throw new Error("target projection reset was incomplete");
    }
    if (!projectionIntegrity(database)) throw new Error("projection integrity check failed during reset");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function repairCodexHistory({ sessionId, inspection, backupRoot, projectionPath, operations = {} }) {
  const writeManifest = operations.writeManifest ?? writeJsonAtomic;
  let backup = null;
  const temporary = `${inspection.path}.statewright-repair-${process.pid}-${randomUUID()}`;
  let rolloutReplaced = false;
  let projectionCommitted = false;
  try {
    if (!await pathExists(projectionPath)) throw new CodexHistoryIntegrityError("Statewright cannot locate Codex's paginated history projection and will not report a partial repair.", { code: "CODEX_HISTORY_PROJECTION_NOT_FOUND" });
    backup = await prepareBackup({ backupRoot, inspection, projectionPath, sessionId, writeManifest, onDurabilityEvent: operations.onDurabilityEvent });
    const droppedRecords = await writeRepairedRollout(inspection.path, temporary);
    const repairedInspection = await inspectRolloutPath(temporary, sessionId, { requireCanonicalFilename: false });
    if (droppedRecords !== inspection.duplicateSettingsCount || repairedInspection.status !== "healthy" || repairedInspection.finalOrdinal !== inspection.finalOrdinal || repairedInspection.sourceSha256 !== inspection.repairedSha256) {
      throw new CodexHistoryIntegrityError("The candidate Codex rollout did not satisfy the exact repair contract, so Statewright did not replace the session.", { code: "CODEX_HISTORY_CANDIDATE_INVALID" });
    }
    await operations.beforeCompareAndSwap?.({ path: inspection.path });
    const currentIdentity = sourceIdentity(await stat(inspection.path));
    const currentHash = await sha256(inspection.path);
    if (!sameSourceIdentity(currentIdentity, inspection.sourceIdentity) || currentHash !== inspection.sourceSha256) {
      throw new CodexHistoryIntegrityError("Codex history changed while Statewright prepared the repair. Nothing was replaced; retry after the writer is idle.", { code: "CODEX_HISTORY_SOURCE_CHANGED" });
    }
    for (const dependency of inspection.historyDependencies ?? []) {
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(dependency.path, { end: dependency.endByteExclusive - 1 })) digest.update(chunk);
      if (digest.digest("hex") !== dependency.sha256) {
        throw new CodexHistoryIntegrityError("Inherited Codex history changed while Statewright prepared the repair. Nothing was replaced; retry after the writer is idle.", { code: "CODEX_HISTORY_SOURCE_CHANGED" });
      }
    }
    operations.checkCurrentRequest?.();
    await rename(temporary, inspection.path);
    rolloutReplaced = true;
    await syncDirectory(dirname(inspection.path));
    await operations.onDurabilityEvent?.("canonical_replaced");
    backup.manifest.state = "rollout_replaced";
    await writeManifest(backup.manifestPath, backup.manifest);
    const sqlite = await openProjection();
    const database = new sqlite.DatabaseSync(projectionPath);
    try { clearThreadProjection(database, sessionId); projectionCommitted = true; } finally { database.close(); }
    backup.manifest.state = "projection_committed";
    await writeManifest(backup.manifestPath, backup.manifest);
    await operations.afterProjectionCommit?.({ path: inspection.path });
    backup.manifest.state = "completed";
    backup.manifest.completed_at = new Date().toISOString();
    backup.manifest.repaired_sha256 = await sha256(inspection.path);
    await writeManifest(backup.manifestPath, backup.manifest);
    return { status: "repaired", droppedRecords, finalOrdinal: inspection.finalOrdinal, backupDir: backup.backupDir, repairedSha256: backup.manifest.repaired_sha256 };
  } catch (error) {
    await unlink(temporary).catch(() => {});
    let rollbackFailed = false;
    if (rolloutReplaced && !projectionCommitted) {
      try { await replaceFromBackup(backup.rolloutBackup, inspection.path); } catch { rollbackFailed = true; }
    }
    if (backup) {
      backup.manifest.state = projectionCommitted ? "repair_applied_manifest_incomplete" : rollbackFailed ? "repair_failed_rollback_failed" : rolloutReplaced ? "repair_failed_rollout_restored" : "repair_failed_before_replacement";
      backup.manifest.failed_at = new Date().toISOString();
      backup.manifest.failure = projectionCommitted ? "The repaired rollout and target projection reset were retained; final manifest completion failed." : "The repair was not applied to both canonical history and its target projection.";
      await writeJsonAtomic(backup.manifestPath, backup.manifest).catch(() => {});
    }
    if (projectionCommitted) {
      throw new CodexHistoryIntegrityError("Statewright applied the safe history repair and target projection reset, but final backup metadata could not be completed. Inspect the private backup manifest before retrying.", { code: "CODEX_HISTORY_MANIFEST_INCOMPLETE", cause: error });
    }
    if (rollbackFailed) {
      throw new CodexHistoryIntegrityError("Statewright's Codex history repair failed and automatic rollout restoration also failed. Keep the session stopped and use the private backup manifest.", { code: "CODEX_HISTORY_ROLLBACK_FAILED", cause: error });
    }
    if (error instanceof CodexHistoryIntegrityError) throw error;
    throw new CodexHistoryIntegrityError(
      "Statewright could not safely complete the Codex history repair. The original rollout was retained or restored; inspect the private backup manifest before retrying.",
      { code: "CODEX_HISTORY_REPAIR_FAILED", cause: error },
    );
  }
}

export function codexHistoryRepairMode({ environment = process.env, config = {} } = {}) {
  const requested = String(environment.STATEWRIGHT_CODEX_HISTORY_REPAIR ?? config?.routing?.managed_clients?.codex_history_repair ?? "prompt").toLowerCase();
  return REPAIR_MODES.has(requested) ? requested : "guard";
}

function classifyInspection(inspection) {
  if (inspection.status === "unsafe") throw new CodexHistoryIntegrityError("The requested Codex history failed its canonical identity or ordinal contract and is not safe for automatic repair. Statewright did not modify it.", { code: "CODEX_HISTORY_UNSAFE", inspection });
  if (inspection.status === "not_found") return { status: "not_applicable", historyMode: null };
  if (inspection.historyMode !== "paginated") return { status: "not_applicable", historyMode: inspection.historyMode };
  if (inspection.status === "healthy") return { status: "healthy", finalOrdinal: inspection.finalOrdinal };
  return null;
}

async function requestRepairConsent({ message, inspection }) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new CodexHistoryIntegrityError("Statewright found repairable Codex history but cannot request approval on a non-interactive terminal. Re-run interactively to approve repair.", { code: "CODEX_HISTORY_REPAIR_PROMPT_REQUIRED", inspection });
  }
  process.stderr.write(message);
  const answer = await new Promise((resolve) => process.stdin.once("data", (chunk) => resolve(String(chunk).trim().toLowerCase())));
  return answer === "y" || answer === "yes";
}

async function requireRepairConsent({ mode, confirmRepair, message, inspection }) {
  if (mode !== "prompt") return;
  if (!await confirmRepair({ message, inspection })) {
    throw new CodexHistoryIntegrityError("Statewright left Codex history unchanged because repair was not approved.", { code: "CODEX_HISTORY_REPAIR_DECLINED", inspection });
  }
}

async function repairPartialWrite({ inspection, sessionId, backupRoot, operations = {} }) {
  const path = inspection.path;
  const source = await readFile(path, "utf8");
  const rows = [];
  let buffer = "";
  for (const line of source.split(/\r?\n/)) {
    if (line === "" && buffer === "") continue;
    buffer += line;
    try { rows.push(JSON.parse(buffer)); buffer = ""; } catch {}
  }
  if (buffer.trim() || rows.length === 0 || rows[0]?.type !== "session_meta" || rows[0]?.payload?.id !== sessionId) return null;
  for (let index = 0; index < rows.length; index += 1) if (rows[index]?.ordinal !== index) return null;
  const normalized = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  if (normalized === source) return null;
  const temporary = `${path}.repair-${randomUUID()}.tmp`;
  const sourceMode = (await stat(path)).mode & 0o777;
  try {
    await (operations.writePartialCandidate ?? writeFile)(temporary, normalized, { mode: sourceMode, flag: "wx" });
    await syncFile(temporary);
    const candidate = await inspectRolloutPath(temporary, sessionId, { requireCanonicalFilename: false });
    if (candidate.status !== "healthy" || candidate.historyMode !== "paginated" || candidate.finalOrdinal !== rows.at(-1).ordinal) {
      throw new CodexHistoryIntegrityError("The reconstructed Codex rollout did not satisfy the complete history contract, so Statewright did not replace the session.", { code: "CODEX_HISTORY_CANDIDATE_INVALID", inspection: candidate });
    }

    const backupRootExisted = await pathExists(backupRoot);
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    if (!backupRootExisted) await syncDirectory(dirname(backupRoot));
    const backupDir = join(backupRoot, `codex-history-${sessionId}-${Date.now()}`);
    await mkdir(backupDir, { recursive: false, mode: 0o700 });
    await syncDirectory(backupRoot);
    const backupPath = join(backupDir, basename(path));
    const manifestPath = join(backupDir, "manifest.json");
    await copyFile(path, backupPath);
    await chmod(backupPath, 0o600);
    await syncFile(backupPath);
    if (await sha256(backupPath) !== inspection.sourceSha256) {
      throw new CodexHistoryIntegrityError("Codex history changed while Statewright prepared its backup. Nothing was replaced; retry after the writer is idle.", { code: "CODEX_HISTORY_SOURCE_CHANGED", inspection });
    }
    await writeJsonAtomic(manifestPath, {
      version: 1, state: "prepared", created_at: new Date().toISOString(), thread_id: sessionId,
      rollout_path: path, rollout_backup: backupPath, rollout_original_sha256: inspection.sourceSha256,
      repaired_sha256: candidate.sourceSha256,
      rollback: "Stop every Codex writer, then restore rollout_backup to rollout_path.",
    });
    await operations.beforePartialCompareAndSwap?.({ path });
    const currentIdentity = sourceIdentity(await stat(path));
    const currentHash = await sha256(path);
    if (!sameSourceIdentity(currentIdentity, inspection.sourceIdentity) || currentHash !== inspection.sourceSha256) {
      throw new CodexHistoryIntegrityError("Codex history changed while Statewright prepared the partial-write repair. Nothing was replaced; retry after the writer is idle.", { code: "CODEX_HISTORY_SOURCE_CHANGED", inspection });
    }
    operations.checkCurrentRequest?.();
    await rename(temporary, path);
    await syncDirectory(dirname(path));
    await writeJsonAtomic(manifestPath, {
      version: 1, state: "completed", created_at: new Date().toISOString(), completed_at: new Date().toISOString(), thread_id: sessionId,
      rollout_path: path, rollout_backup: backupPath, rollout_original_sha256: inspection.sourceSha256,
      repaired_sha256: candidate.sourceSha256,
      rollback: "Stop every Codex writer, then restore rollout_backup to rollout_path.",
    });
    return { status: "repaired", repairKind: "partial_write", backupPath, finalOrdinal: candidate.finalOrdinal };
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function statewrightAppServerRolloutPath(path) {
  return typeof path === "string"
    && /(?:^|[\\/])statewright-swc_[a-f0-9]{32}-app-server-[^\\/]+[\\/]sessions[\\/]/.test(path);
}

async function staleThreadPointer({ storage, sessionId }) {
  const candidates = [];
  const directory = await opendir(storage.sqliteHome).catch(() => null);
  if (!directory) return null;
  for await (const entry of directory) {
    const match = entry.name.match(/^state_(\d+)\.sqlite$/);
    if (!match) continue;
    const candidatePath = join(storage.sqliteHome, entry.name);
    // The staging lane exposes the durable state database through a symlink.
    // Dirent#isFile is false for that entry, so validate its followed target.
    candidates.push({ path: candidatePath, version: Number(match[1]) });
  }
  candidates.sort((left, right) => right.version - left.version);
  const candidate = candidates[0];
  if (!candidate) return null;
  if (!(await stat(candidate.path).catch(() => null))?.isFile()) {
    throw new CodexHistoryIntegrityError("The newest Codex state database is unavailable. Statewright will not modify an obsolete database.", { code: "CODEX_HISTORY_STATE_UNAVAILABLE" });
  }
  const canonicalPath = await findCodexRollout({ codexHome: storage.codexHome, sessionId });
  if (!canonicalPath) return null;
  const sqlite = await openProjection();
  const database = new sqlite.DatabaseSync(candidate.path, { readOnly: true });
  try {
    const row = database.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(sessionId);
    const recordedPath = row?.rollout_path;
    if (!recordedPath || await pathExists(recordedPath)) return null;
    if (!statewrightAppServerRolloutPath(recordedPath) || basename(recordedPath) !== basename(canonicalPath)) return null;
    return { databasePath: await realpath(candidate.path), recordedPath, canonicalPath: await realpath(canonicalPath) };
  } catch (error) {
    if (/no such table: threads/.test(String(error?.message))) return null;
    throw error;
  } finally { database.close(); }
}

async function repairStaleThreadPointer({ pointer, sessionId, backupRoot, checkCurrentRequest, operations = {} }) {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupRootExisted = await pathExists(backupRoot);
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  if (!backupRootExisted) await syncDirectory(dirname(backupRoot));
  const backupDir = join(backupRoot, `statewright-codex-pointer-${stamp}-${sessionId.slice(0, 8)}`);
  await mkdir(backupDir, { recursive: false, mode: 0o700 });
  await syncDirectory(backupRoot);
  const backupPath = join(backupDir, basename(pointer.databasePath));
  const manifestPath = join(backupDir, "manifest.json");
  const sqlite = await openProjection();
  const source = new sqlite.DatabaseSync(pointer.databasePath, { readOnly: true });
  try {
    if (!projectionIntegrity(source)) throw new Error("Codex state database integrity check failed");
    await sqlite.backup(source, backupPath);
  } finally { source.close(); }
  await chmod(backupPath, 0o600);
  await syncFile(backupPath);
  await syncDirectory(backupDir);
  const database = new sqlite.DatabaseSync(pointer.databasePath);
  try {
    await operations.beforePointerCompareAndSwap?.({ pointer });
    checkCurrentRequest();
    database.exec("BEGIN IMMEDIATE");
    const result = database.prepare("UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?")
      .run(pointer.canonicalPath, sessionId, pointer.recordedPath);
    if (Number(result.changes) !== 1) throw new Error("stale rollout pointer changed before repair");
    if (!projectionIntegrity(database)) throw new Error("Codex state database integrity check failed after repair");
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { database.close(); }
  await writeJsonAtomic(manifestPath, {
    version: 1, state: "completed", completed_at: new Date().toISOString(), thread_id: sessionId,
    database_path: pointer.databasePath, database_backup: backupPath,
    stale_rollout_path: pointer.recordedPath, canonical_rollout_path: pointer.canonicalPath,
    target_scoped_rollback_sql: `BEGIN IMMEDIATE; UPDATE threads SET rollout_path = ${sqlLiteral(pointer.recordedPath)} WHERE id = ${sqlLiteral(sessionId)} AND rollout_path = ${sqlLiteral(pointer.canonicalPath)}; COMMIT;`,
    disaster_recovery_database_backup: backupPath,
    rollback: "Stop writers and apply target_scoped_rollback_sql. Restoring the whole database is disaster recovery only and can rewind unrelated threads.",
  });
  return { status: "repaired", repairKind: "stale_rollout_pointer", backupDir, canonicalPath: pointer.canonicalPath };
}

export async function guardCodexResumeHistory({
  home = homedir(), cwd = process.cwd(), args = [], sessionId, mode = "guard", backupRoot = null,
  environment = process.env, withWriterLock = withCodexWriterLock, repairOperations = {}, confirmRepair = requestRepairConsent,
  checkCurrentRequest = () => {},
} = {}) {
  try {
    checkCurrentRequest();
    repairOperations = { ...repairOperations, checkCurrentRequest };
    if (!sessionId || mode === "off") return { status: "skipped" };
    if (!SESSION_ID_PATTERN.test(String(sessionId))) return { status: "not_applicable", historyMode: null };
    if (!REPAIR_MODES.has(mode)) mode = "guard";
    const storage = await resolveCodexHistoryStorage({ home, cwd, environment, args });
    const effectiveBackupRoot = backupRoot ?? join(storage.codexHome, "backups");
    let inspection = await inspectCodexHistory({ home, codexHome: storage.codexHome, sessionId });
    if (inspection.status === "not_found") {
      const archivePath = await materializeArchivedRollout({ storage, sessionId, mode, confirmRepair, inspection });
      if (archivePath) {
        await withWriterLock({ home, codexHome: storage.codexHome, writerLockRoot: storage.writerLockRoot, sessionId, environment }, async () => {
          checkCurrentRequest();
          const current = await inspectCodexHistory({ home, codexHome: storage.codexHome, sessionId });
          if (current.status === "not_found") {
            const currentArchives = await findCompressedRollouts(storage.sessionsRoot, sessionId);
            if (currentArchives.length !== 1 || currentArchives[0] !== archivePath) {
              throw new CodexHistoryIntegrityError("Compressed rollout candidates changed while awaiting recovery. No archive was selected.", { code: "CODEX_HISTORY_SOURCE_CHANGED" });
            }
            await materializeCompressedRollout({ archivePath, sessionId, operations: repairOperations, checkCurrentRequest, environment });
          }
        });
        inspection = await inspectCodexHistory({ home, codexHome: storage.codexHome, sessionId });
      }
    }
    const restoredAncestors = new Set();
    while (inspection.compressedHistoryBase) {
      const ancestorId = inspection.compressedHistoryBase.thread_id;
      if (restoredAncestors.has(ancestorId) || restoredAncestors.size >= 63) {
        throw new CodexHistoryIntegrityError("Codex ancestry changed repeatedly during archive recovery. No resume was started.", { code: "CODEX_HISTORY_SOURCE_CHANGED" });
      }
      restoredAncestors.add(ancestorId);
      await recoverCompressedHistoryBase({ inspection, home, storage, sessionId, mode, confirmRepair, environment, withWriterLock,
        operations: repairOperations, checkCurrentRequest });
      inspection = await inspectCodexHistory({ home, codexHome: storage.codexHome, sessionId });
    }
    let partialRepairResult = null;
    const partialWriteCandidate = inspection.status === "unsafe"
      && inspection.historyBase === null
      && recognizedFilename(inspection.path, sessionId)
      && inspection.unknownAnomalies.some((item) => item.kind === "malformed_json");
    if (partialWriteCandidate) {
      if (mode === "guard") classifyInspection(inspection);
      await requireRepairConsent({
        mode, confirmRepair,
        message: "[statewright] Codex history contains a recoverable-looking partial write. Back up and repair this session? [y/N] ",
        inspection,
      });
      partialRepairResult = await withWriterLock({ home, codexHome: storage.codexHome, writerLockRoot: storage.writerLockRoot, sessionId, environment }, async () => {
        checkCurrentRequest();
        const lockedInspection = await inspectCodexHistory({ home, codexHome: storage.codexHome, sessionId });
        if (!lockedInspection.path || !recognizedFilename(lockedInspection.path, sessionId)) return classifyInspection(lockedInspection);
        if (lockedInspection.historyBase !== null || lockedInspection.status !== "unsafe" || !lockedInspection.unknownAnomalies.some((item) => item.kind === "malformed_json")) return classifyInspection(lockedInspection);
        return repairPartialWrite({ inspection: lockedInspection, sessionId, backupRoot: effectiveBackupRoot, operations: repairOperations });
      });
      inspection = await inspectCodexHistory({ home, codexHome: storage.codexHome, sessionId });
    }
    let historyResult = classifyInspection(inspection);
    if (partialRepairResult?.repairKind === "partial_write") historyResult = partialRepairResult;
    if (!historyResult) {
      if (mode === "guard") throw new CodexHistoryIntegrityError(`Statewright detected duplicate restart metadata and is refusing to resume from a stale paginated projection. Re-run once with STATEWRIGHT_CODEX_HISTORY_REPAIR=auto after exiting every writer for this thread. If a resident App Server is stale for this project, run: statewright-managed-client --kill-app-server (cwd: ${cwd})`, { code: "CODEX_HISTORY_REPAIR_REQUIRED", inspection });
      await requireRepairConsent({
        mode, confirmRepair,
        message: "[statewright] Codex history contains duplicate restart metadata. Back up and repair this session? [y/N] ",
        inspection,
      });
      historyResult = await withWriterLock({ home, codexHome: storage.codexHome, writerLockRoot: storage.writerLockRoot, sessionId, environment }, async () => {
        checkCurrentRequest();
        const lockedInspection = await inspectCodexHistory({ home, codexHome: storage.codexHome, sessionId });
        const lockedClassification = classifyInspection(lockedInspection);
        if (lockedClassification) return lockedClassification;
        return repairCodexHistory({ sessionId, inspection: lockedInspection, backupRoot: effectiveBackupRoot, projectionPath: storage.projectionPath, operations: repairOperations });
      });
    }
    const pointer = await staleThreadPointer({ storage, sessionId });
    if (!pointer) return historyResult;
    if (mode === "guard") throw new CodexHistoryIntegrityError("Statewright found a stale Codex rollout pointer left by a managed App Server. Re-run interactively with history repair set to prompt or auto; Statewright will back up the Codex state database before changing one exact thread row.", { code: "CODEX_HISTORY_STALE_POINTER" });
    if (mode === "prompt") {
      await requireRepairConsent({
        mode, confirmRepair,
        message: `[statewright] Codex indexed this session under a deleted managed App Server home. Back up the state database and relink this thread to ${pointer.canonicalPath}? [y/N] `,
        inspection,
      });
    }
    return await withWriterLock({ home, codexHome: storage.codexHome, writerLockRoot: storage.writerLockRoot, sessionId, environment }, async () => {
      checkCurrentRequest();
      // Re-read under the same lock used for history mutation; a resume or
      // another repair may have fixed this exact row while consent was open.
      const lockedPointer = await staleThreadPointer({ storage, sessionId });
      if (!lockedPointer) return historyResult;
      return repairStaleThreadPointer({ pointer: lockedPointer, sessionId, backupRoot: effectiveBackupRoot, checkCurrentRequest, operations: repairOperations });
    });
  } catch (error) {
    if (error instanceof CodexHistoryIntegrityError || error?.code === "STATEWRIGHT_SUPERSEDED") throw error;
    throw new CodexHistoryIntegrityError("Statewright could not inspect or repair Codex history safely. No unverified resume was started.", { code: "CODEX_HISTORY_OPERATION_FAILED", cause: error });
  }
}
