import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHostLaunch,
  hostRoutingMode,
  hostSupportsLiveRouting,
  SUPPORTED_HOSTS,
} from "../lib/host-adapters.mjs";

const state = {
  state: "implementing",
  model: "openai/gpt-5.6-terra",
  thinking_level: "medium",
};
const base = {
  cwd: "/repo",
  prompt: "Fix it",
  hostSessionId: "session-1",
  hostArgs: [],
};

test("every supported TUI has an executor launch contract", () => {
  assert.deepEqual(SUPPORTED_HOSTS, ["pi", "claude", "opencode", "cursor", "omx"]);
  for (const host of SUPPORTED_HOSTS) {
    const launch = buildHostLaunch({ ...base, host }, state);
    assert.ok(launch.command);
    assert.ok(launch.args.includes("Fix it") || launch.args.includes("--prompt"));
  }
});

test("Pi and OpenCode apply workflow routes live", () => {
  assert.equal(hostSupportsLiveRouting("pi"), true);
  assert.equal(hostSupportsLiveRouting("opencode"), true);
  assert.equal(hostSupportsLiveRouting("claude"), false);
  assert.equal(hostRoutingMode("claude"), "restart");
  assert.equal(hostRoutingMode("cursor"), "startup");

  const pi = buildHostLaunch({ ...base, host: "pi" }, state);
  assert.deepEqual(pi.args.slice(0, 2), ["--session-id", "session-1"]);
  assert.ok(pi.args.includes("openai/gpt-5.6-terra"));
  assert.ok(pi.args.includes("medium"));

  const opencode = buildHostLaunch({ ...base, host: "opencode" }, state);
  assert.ok(opencode.args.includes("openai/gpt-5.6-terra"));

  const claude = buildHostLaunch({ ...base, host: "claude" }, state, true);
  assert.ok(claude.args.includes("--resume"));
  assert.ok(!claude.args.includes("--session-id"));

  const omx = buildHostLaunch({ ...base, host: "omx" }, state);
  assert.ok(omx.args.includes("gpt-5.6-terra"));
  assert.ok(omx.args.some((arg) => arg.includes("model_reasoning_effort")));
});
