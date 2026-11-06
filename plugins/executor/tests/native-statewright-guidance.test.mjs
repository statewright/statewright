import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NATIVE_STATEWRIGHT_GUIDANCE, nativeWorkflowEntryPrompt, nativeApprovalResultPrompt } from "../lib/native-statewright-guidance.mjs";
import { handleExecutorHook } from "../../codex/scripts/executor-hook.mjs";

test("native connector guidance identifies exact native tools and forbids silent web/file fallback", () => {
  const text = NATIVE_STATEWRIGHT_GUIDANCE;
  for (const term of ["mcp__statewright__statewright_*", "mcp__plugin_statewright_statewright__statewright_*",
    "codex_apps.statewright_ai.*", "mcp__codex_apps__statewright_*", "even for workflow listing or status",
    "separate session", "absent, fails, or requires login", "park dependent workflow actions",
    "infer live state from saved files", "does not activate a workflow"]) assert.ok(text.includes(term), term);
  assert.ok(nativeWorkflowEntryPrompt("intake").includes(text));
  assert.match(nativeWorkflowEntryPrompt("intake"), /Call the advertised local statewright_get_state tool first/);
});

test("approval outcome guidance requires a complete applied release, never a still-pending hint", () => {
  const release={approvalId:'apr',fromState:'review',state:{run_id:'run',run_session_id:'session',state:'review',pending_approval:null}};
  assert.match(nativeApprovalResultPrompt(release),/approved and applied/);
  for(const changed of [{...release,approvalId:null},{...release,state:{...release.state,run_id:null}},
    {...release,state:{...release.state,run_session_id:null}},
    {...release,state:{...release.state,pending_approval:{approval_id:'apr'}}}]) {
    assert.throws(()=>nativeApprovalResultPrompt(changed),/no verified applied decision/);
  }
});

for (const state of [{state: "implement"}, {state: "complete", isFinal: true},
  {state: "intake", additionalContext: "Caller-supplied state instructions"}])
test(`executor prompt retains native connector selection (${state.state})`, async () => {
  const calls = [];
  const output = await handleExecutorHook("user-prompt", {}, {
    adapterUrl: "http://127.0.0.1:1", adapterToken: "fixture-only",
    fetch: async (url, options) => {
      calls.push([url, options.method]);
      return {ok: true, text: async () => JSON.stringify(state)};
    },
  });
  assert.ok(output.hookSpecificOutput.additionalContext.includes(NATIVE_STATEWRIGHT_GUIDANCE));
  assert.deepEqual(calls, [["http://127.0.0.1:1/hooks/state", "GET"]], "guidance does not load a workflow or invoke another connector");
});

for (const path of ["plugins/codex/skills/statewright-native/SKILL.md", "plugins/claude-code/skills/statewright/SKILL.md"])
test(`${path}: connector rule is available before workflow activation`, async () => {
  const text = await readFile(path, "utf8");
  assert.match(text, /^---\nname: \S+\ndescription: .+\n/);
  for (const term of ["mcp__statewright__statewright_*", "codex_apps.statewright_ai.*", "separate session",
    "exact local", "park dependent workflow", "saved files"]) assert.ok(text.includes(term), term);
});
