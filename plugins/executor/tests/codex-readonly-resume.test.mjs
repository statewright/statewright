import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCodexResumePermissions } from "../lib/codex-session-metadata.mjs";

// Native Codex 0.160.0 -s read-only snapshot, without a named profile.
const readonly = () => ({
  type: "managed", network: "restricted",
  file_system: { type: "restricted", entries: [
    { path: { type: "special", value: { kind: "root" } }, access: "read" },
  ] },
});

async function fixture(t, profile, event = false) {
  const home = await mkdtemp(join(tmpdir(), "sw-readonly-resume-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const id = "01a14fe5-6b3b-7a70-9dad-b670408eca20";
  const directory = join(home, ".codex/sessions/2026/10/18");
  await mkdir(directory, { recursive: true });
  const settings = { approval_policy: "never", approvals_reviewer: "user", permission_profile: profile,
    cwd: "/fixture/project", runtime_workspace_roots: ["/fixture/project"] };
  await writeFile(join(directory, `rollout-2026-10-18T12-43-17-${id}.jsonl`), [
    { type: "session_meta", payload: { id, cwd: "/fixture/project" } },
    event
      ? { type: "event_msg", payload: { type: "thread_settings_applied", thread_id: id, thread_settings: settings } }
      : { type: "turn_context", payload: settings },
  ].map(JSON.stringify).join("\n") + "\n");
  return () => readCodexResumePermissions({ home, threadId: id });
}

for (const event of [false, true]) {
  test(`restores native unnamed read-only profile from ${event ? "settings event" : "turn context"}`, async t => {
    const read = await fixture(t, readonly(), event);
    assert.deepEqual(await read(), {
      sandbox: "read-only", approvalPolicy: "never", approvalsReviewer: "user", cwd: "/fixture/project",
      ...(event ? { runtimeWorkspaceRoots: ["/fixture/project"] } : {}),
    });
  });
}

const variants = {
  "network enabled": p => { p.network = "enabled"; },
  "empty rules": p => { p.file_system.entries = []; },
  "write access": p => { p.file_system.entries[0].access = "write"; },
  "extra deny rule": p => { p.file_system.entries.push({ path: { type: "path", path: "/private" }, access: "deny" }); },
  "narrower root": p => { p.file_system.entries[0].path.value = { kind: "project_roots" }; },
  "extra profile field": p => { p.future_policy = true; },
  "extra filesystem field": p => { p.file_system.glob_scan_max_depth = 2; },
  "extra rule field": p => { p.file_system.entries[0].missing_path_behavior = "skip"; },
};
for (const [name, mutate] of Object.entries(variants)) {
  test(`does not guess read-only permissions: ${name}`, async t => {
    const profile = readonly(); mutate(profile);
    const read = await fixture(t, profile);
    await assert.rejects(read(), { code: "STATEWRIGHT_SAVED_PERMISSIONS_UNREPRESENTABLE" });
  });
}
