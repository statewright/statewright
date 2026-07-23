import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAppServerArgs,
  validateWorkflowName,
} from "../scripts/statewright-codex.mjs";

test("app-server configuration explicitly injects the isolated MCP session id", () => {
  assert.deepEqual(buildAppServerArgs("br_codex_test-123"), [
    "app-server",
    "--stdio",
    "-c",
    'mcp_servers.statewright.env.STATEWRIGHT_MCP_SESSION_ID="br_codex_test-123"',
  ]);
});
test("invalid transport session ids cannot inject Codex configuration", () => {
  assert.throws(() => buildAppServerArgs('br_codex_bad"value'), /contain only/);
});

test("the launcher accepts Statewright display names and rejects control characters", () => {
  assert.doesNotThrow(() => validateWorkflowName("[magent] desktop-android-pulse v1"));
  assert.throws(() => validateWorkflowName("bad\nworkflow"), /printable/);
});
