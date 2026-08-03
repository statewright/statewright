import { chmod, readFile, rename, writeFile } from "node:fs/promises";

const MAX_LEASE_AGE_MS = 15_000;

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export class ExecutorLease {
  constructor(path, fields) {
    this.path = path;
    this.fields = fields;
    this.timer = null;
  }

  async start() {
    await this.refresh();
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, 2_000);
    this.timer.unref?.();
    return this;
  }

  async refresh() {
    await writeJsonAtomic(this.path, {
      version: 1,
      ...this.fields,
      pid: process.pid,
      updated_at: new Date().toISOString(),
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export async function validateExecutorLease(environment, now = Date.now()) {
  const path = environment.STATEWRIGHT_EXECUTOR_LEASE;
  const expectedId = environment.STATEWRIGHT_EXECUTOR_ID;
  if (!path || !expectedId || environment.STATEWRIGHT_DELIVERY_ACTIVE !== "1") {
    return { valid: false, reason: "no active Statewright executor lease" };
  }
  try {
    const lease = JSON.parse(await readFile(path, "utf8"));
    const age = now - Date.parse(lease.updated_at);
    if (lease.executor_id !== expectedId) {
      return { valid: false, reason: "executor lease identity mismatch" };
    }
    if (!Number.isFinite(age) || age < -5_000 || age > MAX_LEASE_AGE_MS) {
      return { valid: false, reason: "executor lease is stale" };
    }
    if (
      environment.STATEWRIGHT_DELIVERY_MANIFEST
      && lease.manifest_path !== environment.STATEWRIGHT_DELIVERY_MANIFEST
    ) {
      return { valid: false, reason: "executor delivery manifest mismatch" };
    }
    return { valid: true, lease };
  } catch (error) {
    return { valid: false, reason: `executor lease unavailable: ${error.message}` };
  }
}
