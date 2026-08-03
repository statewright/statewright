import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAppServerArgs,
  deliveryAgentEnvironment,
  validateWorkflowName,
} from "../scripts/statewright-codex.mjs";

test("app-server binds the complete proxy transport shipped with the launcher", () => {
  const args = buildAppServerArgs("br_codex_test-123");
  assert.deepEqual(args.slice(0, 5), [
    "app-server",
    "--stdio",
    "-c",
    'mcp_servers.statewright_adapter.command="bash"',
    "-c",
  ]);
  assert.match(
    args[5],
    /mcp_servers[.]statewright_adapter[.]args=.*plugins\/codex\/mcp-proxy[.]sh/,
  );
  assert.equal(args[6], "-c");
  assert.match(args[7], /env_vars=.*STATEWRIGHT_GATEWAY_URL.*STATEWRIGHT_API_KEY/);
  assert.equal(args[8], "-c");
  assert.equal(
    args[9],
    'mcp_servers.statewright_adapter.env.STATEWRIGHT_MCP_SESSION_ID="br_codex_test-123"',
  );
  assert.equal(args[10], "-c");
  assert.equal(args[11], 'mcp_servers.statewright.command="bash"');
  assert.equal(args[12], "-c");
  assert.match(
    args[13],
    /mcp_servers[.]statewright[.]args=.*plugins\/codex\/mcp-proxy[.]sh/,
  );
  assert.equal(args[14], "-c");
  assert.equal(args[15], "mcp_servers.statewright.enabled=false");
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
