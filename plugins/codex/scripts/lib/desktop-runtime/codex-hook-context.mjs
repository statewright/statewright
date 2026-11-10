import {createHash, randomUUID} from "node:crypto";
import {readFile, writeFile, rename} from "node:fs/promises";
import {dirname, isAbsolute, join} from "node:path";
import {realpathSync} from "node:fs";
import {fileURLToPath} from "node:url";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = receipt => digest([receipt.pid, receipt.clientId, receipt.proxyUrl, receipt.proxyToken]);
const supported = value => {
  const match = typeof value === "string" && value.length <= 1024 && value.match(/^codex[a-z_-]*\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/i);
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 167));
};

// Written by the serving App Server's initialize response, never by a hook
// caller. Bind to its existing private approval receipt without copying a key.
export async function recordCodexHookHost({receiptPath, clientId, proxyToken, userAgent}) {
  if (!receiptPath || !supported(userAgent) || typeof proxyToken !== "string" || !proxyToken) return false;
  try {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (receipt.pid !== process.pid || receipt.clientId !== clientId || receipt.proxyToken !== proxyToken) return false;
    const record = {schema:"statewright/codex-hook-host/v1", pid:process.pid,
      clientId, runtimeIdentity:identity(receipt), userAgent};
    const temporary = receiptPath + ".host-" + randomUUID();
    await writeFile(temporary, JSON.stringify(record) + "\n", {mode:0o600, flag:"wx"});
    await rename(temporary, receiptPath + ".host.json");
    return true;
  } catch { return false; }
}

// Codex 0.167+ reports the effective local tool directory in hook.cwd; older
// hosts reported the session cwd instead. Never borrow process.cwd()/PWD.
export async function normalizeCodexHookInput(hook, {environment = process.env} = {}) {
  const input = hook?.tool_input ?? {};
  if (hook?.hook_event_name !== "PreToolUse"
      || !["bash", "exec_command", "shell_command"].includes(String(hook?.tool_name).toLowerCase())
      || input.workdir !== undefined || input.cwd !== undefined
      || typeof hook.cwd !== "string" || !isAbsolute(hook.cwd) || /[\0\r\n]/.test(hook.cwd)
      || hook.environment_id !== undefined || input.environment_id !== undefined) return hook;
  const path = environment.STATEWRIGHT_CLASSIFIER_APPROVAL_RECEIPT;
  const thread = hook.thread_id ?? hook.session_id;
  if (!path || !environment.STATEWRIGHT_ROUTE_CONTROL_DIR || !thread) return hook;
  try {
    const receipt = JSON.parse(await readFile(path, "utf8"));
    const host = JSON.parse(await readFile(path + ".host.json", "utf8"));
    const root = JSON.parse(await readFile(join(environment.STATEWRIGHT_ROUTE_CONTROL_DIR, "codex-root-session.json"), "utf8"));
    if (host.schema !== "statewright/codex-hook-host/v1" || !supported(host.userAgent)
        || typeof receipt.proxyToken !== "string" || !receipt.proxyToken
        || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0
        || host.pid !== receipt.pid || host.clientId !== receipt.clientId
        || receipt.clientId !== environment.STATEWRIGHT_CLIENT_ID
        || host.runtimeIdentity !== identity(receipt)
        || root.version !== 1 || root.client_id !== receipt.clientId || root.session_id !== thread
        || dirname(environment.STATEWRIGHT_ROUTE_CONTROL_DIR) !== dirname(path)) return hook;
    process.kill(receipt.pid, 0);
    return {...hook, tool_input:{...input, cwd:hook.cwd}};
  } catch { return hook; }
}

try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 128 * 1024) throw new Error("Native hook input exceeds bound");
    }
    process.stdout.write(JSON.stringify(await normalizeCodexHookInput(JSON.parse(input))) + "\n");
  }
} catch { process.exitCode = 1; }
