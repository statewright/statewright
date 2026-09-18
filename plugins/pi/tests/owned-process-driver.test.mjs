import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { ownedProcessDriver } from "./fixtures/owned-process-driver.mjs";

test("POSIX emergency fixture reap observes actual exit even when graceful close and SIGTERM are ignored",
  { timeout: 5_000, skip: process.platform === "win32" }, async t => {
    const schema = "statewright/owned-reap-fixture/v1";
    const code = `const schema=${JSON.stringify(schema)};
      process.on("SIGTERM",()=>process.send({schema,type:"sigterm-seen",pid:process.pid}));
      process.on("message",()=>{});
      process.send({schema,type:"ready",pid:process.pid});`;
    const child = spawn(process.execPath, ["-e", code], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const control = ownedProcessDriver(child, { schema, timeoutMs: 2_000 });
    t.after(async () => { if (!control.exited) await control.terminate({ graceMs: 100, killMs: 1_000 }); });
    await control.wait("ready");
    await assert.rejects(control.close({ deadlineMs: 100 }), /observation timed out/);
    assert.equal(control.exited, false, "observation expiry does not mean terminal");
    child.kill("SIGTERM");
    await control.wait("sigterm-seen");
    const result = await control.terminate({ graceMs: 50, killMs: 1_000 });
    assert.deepEqual(result, { code: null, signal: "SIGKILL" });
    assert.equal(control.exited, true);
    assert.equal(child.signalCode, "SIGKILL");
    assert.deepEqual(await control.close(), result);
  });
