import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAppServerArgs,
  deliveryAgentEnvironment,
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

test("delivery agent environment excludes cluster and publishing credentials", () => {
  const environment = deliveryAgentEnvironment(
    {
      PATH: "/bin",
      HOME: "/home/test",
      KUBECONFIG: "/secret/kubeconfig",
      AWS_ACCESS_KEY_ID: "secret",
      GH_TOKEN: "secret",
      STRIPE_SECRET_KEY: "secret",
      STATEWRIGHT_API_KEY: "required-for-statewright",
    },
    "br_codex_test",
  );

  assert.equal(environment.PATH, "/bin");
  assert.equal(environment.HOME, "/home/test");
  assert.equal(environment.KUBECONFIG, "/dev/null");
  assert.equal(environment.STATEWRIGHT_DELIVERY_ACTIVE, "1");
  assert.equal(environment.STATEWRIGHT_API_KEY, "required-for-statewright");
  assert.equal(environment.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.STRIPE_SECRET_KEY, undefined);
});
