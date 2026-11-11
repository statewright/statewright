import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalGateway } from "./gateway-profile.mjs";

export const APPROVAL_ORIGIN_HEADER = "x-statewright-approval-origin";
export const validApprovalOriginProof = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

// A private host capability, separate from account credentials and model-visible
// context. Stable across reconnects; its hash is captured only at run creation.
// Never repair an insecure/malformed store by replacing an existing capability.
export async function approvalOriginProof({home = homedir(), clientId, gatewayUrl}) {
  // POSIX modes do not establish Windows ACL privacy. Until an owner-only ACL
  // store is supported, omit this capability; authenticated remote review is
  // still available, but an unproven host cannot claim originating-owner review.
  if (process.platform === "win32") return undefined;
  if (typeof clientId !== "string" || !clientId || clientId.length > 256 || /[\x00-\x1f\x7f]/.test(clientId)) {
    throw new Error("Approval origin requires a bounded managed client identity");
  }
  const gateway = canonicalGateway(gatewayUrl);
  const directory = join(home, ".statewright", "approval-origins");
  await mkdir(directory, {recursive:true, mode:0o700});
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || parent.uid !== process.getuid()) {
    throw new Error("Approval origin storage is not private");
  }
  const filename = join(directory, `${createHash("sha256").update(JSON.stringify([gateway, clientId])).digest("hex")}.json`);
  let handle;
  try {
    handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const value = {version:1, gateway, client_id:clientId, proof:randomBytes(32).toString("hex")};
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    return value.proof;
  } catch (error) {
    if (error.code !== "EEXIST") throw new Error("Approval origin capability could not be created");
  } finally { await handle?.close(); }
  handle = null;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 || stat.nlink !== 1
        || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
      throw new Error("Invalid origin storage");
    }
    const value = JSON.parse(await handle.readFile("utf8"));
    if (value.version !== 1 || value.gateway !== gateway || value.client_id !== clientId
        || !validApprovalOriginProof(value.proof)
        || Object.keys(value).sort().join(",") !== "client_id,gateway,proof,version") {
      throw new Error("Invalid origin identity");
    }
    return value.proof;
  } catch { throw new Error("Approval origin provenance is unavailable; existing capability preserved"); }
  finally { await handle?.close(); }
}
