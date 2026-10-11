import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { canonicalGateway, PRODUCTION_GATEWAY } from "./gateway-profile.mjs";

const MAX_RESPONSE_BYTES = 32 * 1024;

export class CredentialStoreError extends Error {
  constructor(message, code, response = null) {
    super(message);
    this.name = "CredentialStoreError";
    this.code = code;
    this.response = response;
  }
}

export function credentialHelperPath(environment = process.env, home = homedir(), platform = process.platform) {
  if (environment.STATEWRIGHT_CREDENTIAL_HELPER?.trim()) return environment.STATEWRIGHT_CREDENTIAL_HELPER.trim();
  const names = {
    darwin: { arm64: "statewright-credentials-darwin-arm64", x64: "statewright-credentials-darwin-x64" },
    linux: { arm64: "statewright-credentials-linux-arm64", x64: "statewright-credentials-linux-x64" },
    win32: { arm64: "statewright-credentials-windows-arm64.exe", x64: "statewright-credentials-windows-x64.exe" },
  };
  const packagedName = names[platform]?.[process.arch];
  if (packagedName) {
    for (const relative of ["../../../bin", "../../bin"]) {
      const packaged = resolve(dirname(fileURLToPath(import.meta.url)), relative, packagedName);
      if (existsSync(packaged)) return packaged;
    }
  }
  return join(home, ".statewright", "bin", platform === "win32" ? "statewright-credentials.exe" : "statewright-credentials");
}

export function invokeCredentialHelper(request, {
  environment = process.env,
  home = homedir(),
  platform = process.platform,
  spawnProcess = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const helper = credentialHelperPath(environment, home, platform);
    const child = spawnProcess(helper, [], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      fail(new CredentialStoreError("OS credential helper timed out", "CREDENTIAL_HELPER_TIMEOUT"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(new CredentialStoreError(
        error?.code === "ENOENT" ? "OS credential helper is not installed" : "OS credential helper could not be started",
        error?.code === "ENOENT" ? "CREDENTIAL_HELPER_MISSING" : "CREDENTIAL_HELPER_FAILED",
      ));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_RESPONSE_BYTES) {
        child.kill();
        fail(new CredentialStoreError("OS credential helper returned too much data", "CREDENTIAL_HELPER_FAILED"));
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(0, 1024); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (settled) return;
      let response;
      try { response = JSON.parse(stdout); } catch {
        return fail(new CredentialStoreError(
          `OS credential helper returned an invalid response${stderr ? ": see helper diagnostics" : ""}`,
          "CREDENTIAL_HELPER_FAILED",
        ));
      }
      if (code !== 0) return fail(new CredentialStoreError("OS credential helper failed", "CREDENTIAL_HELPER_FAILED", response));
      settled = true;
      resolve(response);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function getGatewayCredential(gateway, options = {}) {
  const response = await invokeCredentialHelper({ operation: "get", gateway: canonicalGateway(gateway) }, options);
  if (response.ok && typeof response.secret === "string" && response.secret.trim()) return response.secret.trim();
  if (response.status === "missing") throw new CredentialStoreError("No credential is stored for this gateway", "CREDENTIAL_MISSING", response);
  throw new CredentialStoreError(response.message || "OS credential store is unavailable", "CREDENTIAL_STORE_UNAVAILABLE", response);
}

export async function setGatewayCredential(gateway, secret, options = {}) {
  if (!secret?.trim()) throw new CredentialStoreError("Credential cannot be empty", "CREDENTIAL_INVALID");
  const response = await invokeCredentialHelper({ operation: "set", gateway: canonicalGateway(gateway), secret: secret.trim() }, options);
  if (response.ok) return response.account;
  throw new CredentialStoreError(response.message || "OS credential store is unavailable", "CREDENTIAL_STORE_UNAVAILABLE", response);
}

export async function resolveGatewayApiKey(environment = process.env, home = homedir(), options = {}) {
  if (environment.STATEWRIGHT_API_KEY?.trim()) return environment.STATEWRIGHT_API_KEY.trim();
  const gateway = canonicalGateway(environment.STATEWRIGHT_GATEWAY_URL || PRODUCTION_GATEWAY);
  try {
    return await getGatewayCredential(gateway, { environment, home, ...options });
  } catch (error) {
    if (error?.code !== "CREDENTIAL_MISSING" || gateway !== PRODUCTION_GATEWAY) throw error;
  }

  // Migrate the historical unscoped credential only into the exact production
  // gateway entry. Preserve the file for rollback; never consult it elsewhere.
  let legacy;
  try { legacy = (await readFile(join(home, ".statewright", "api_key"), "utf8")).trim(); } catch (error) {
    if (error?.code === "ENOENT") throw new CredentialStoreError("No credential is stored for this gateway", "CREDENTIAL_MISSING");
    throw error;
  }
  if (!legacy) throw new CredentialStoreError("No credential is stored for this gateway", "CREDENTIAL_MISSING");
  await setGatewayCredential(gateway, legacy, { environment, home, ...options });
  return legacy;
}

async function confirmKeychainUnlock({ input, output }) {
  const terminal = createInterface({ input, output, terminal: true });
  try {
    const answer = await terminal.question(
      "[statewright] Try unlocking the macOS default keychain? It may remain unlocked until macOS locks it again. [y/N] ",
    );
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

export function unlockMacKeychain({ spawnProcess = spawn } = {}) {
  return new Promise((resolveUnlock, rejectUnlock) => {
    // Let Apple's tool own the password prompt. Never receive the password in
    // Node, pass it in argv, or substitute a shell command for this binary.
    const child = spawnProcess("/usr/bin/security", ["unlock-keychain"], {
      stdio: "inherit",
      shell: false,
    });
    child.once("error", rejectUnlock);
    child.once("exit", (code) => resolveUnlock(code === 0));
  });
}

export async function resolveTuiGatewayApiKey(environment = process.env, {
  platform = process.platform,
  allowUnlock = true,
  input = process.stdin,
  output = process.stderr,
  lookup = resolveGatewayApiKey,
  confirm = confirmKeychainUnlock,
  unlock = unlockMacKeychain,
} = {}) {
  try {
    return await lookup(environment);
  } catch (error) {
    if (error?.code !== "CREDENTIAL_STORE_UNAVAILABLE" || platform !== "darwin" || !allowUnlock) throw error;
    if (!input.isTTY || !output.isTTY) {
      throw new CredentialStoreError(
        "macOS Keychain could not read the gateway credential; retry in an interactive terminal to unlock the default keychain",
        "CREDENTIAL_STORE_UNAVAILABLE",
      );
    }
    output.write("[statewright] macOS Keychain could not read this gateway credential from this terminal.\n");
    let approved = false;
    try { approved = await confirm({ input, output }); } catch { /* cancelled */ }
    if (!approved) {
      throw new CredentialStoreError("Keychain unlock was cancelled", "CREDENTIAL_UNLOCK_CANCELLED");
    }
    let unlocked = false;
    try { unlocked = await unlock(); } catch { /* preserve a bounded, secret-free error */ }
    if (!unlocked) {
      throw new CredentialStoreError("Keychain unlock did not complete; gateway credential remains unavailable", "CREDENTIAL_UNLOCK_FAILED");
    }
    try {
      return await lookup(environment);
    } catch (retryError) {
      if (retryError?.code === "CREDENTIAL_MISSING") throw retryError;
      throw new CredentialStoreError(
        "Keychain unlocked, but this terminal still cannot read the gateway credential; check the item's access approval or the SSH security session",
        "CREDENTIAL_STORE_UNAVAILABLE",
      );
    }
  }
}

async function cli() {
  const operation = process.argv[2];
  const gateway = process.argv[3];
  if (!gateway || !["get", "set", "status", "delete"].includes(operation)) process.exit(2);
  if (operation === "get") process.stdout.write(`${await getGatewayCredential(gateway)}\n`);
  else if (operation === "set") {
    let secret = "";
    for await (const chunk of process.stdin) {
      secret += chunk;
      if (secret.length > 16 * 1024) process.exit(2);
    }
    await setGatewayCredential(gateway, secret);
  } else {
    const response = await invokeCredentialHelper({ operation, gateway: canonicalGateway(gateway) });
    process.stdout.write(`${JSON.stringify(response)}\n`);
    if (!response.ok) process.exitCode = response.status === "missing" ? 3 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error) => {
    process.stderr.write(`[statewright] ${error.message}\n`);
    process.exitCode = error?.code === "CREDENTIAL_MISSING" ? 3 : 1;
  });
}
