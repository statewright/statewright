import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareManagedApproval } from "../lib/approval-evidence.mjs";

test("managed approval preparation fetches the bound receipt and uploads exact evidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "statewright-approval-evidence-"));
  const artifact = join(cwd, "review.md");
  await writeFile(artifact, "bounded review\n");
  const calls = [];
  const receipt = {
    status: "pending",
    approval_id: "apr_one",
    run_id: "run_one",
    record_id: "record_one",
    context_snapshot: {
      evidence_packet: {
        schema: "statewright/evidence-packet/v1",
        artifacts: [{ local_path: "review.md", label: "Review", classification: "confidential" }],
      },
    },
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/runtime-approval")) {
      assert.deepEqual(JSON.parse(options.body), {
        approval_id: "apr_one",
        run_id: "run_one",
        run_session_id: "gateway_one",
      });
      assert.equal(options.headers["x-statewright-client-id"], "client_one");
      return new Response(JSON.stringify(receipt), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    assert.equal(options.body.get("approval_id"), "apr_one");
    assert.equal(options.body.get("run_id"), "run_one");
    assert.equal(options.body.get("label"), "Review");
    assert.equal(options.body.get("classification"), "confidential");
    assert.match(options.body.get("digest"), /^sha256:[a-f0-9]{64}$/);
    assert.equal(await options.body.get("file").text(), "bounded review\n");
    return new Response('{"id":"evidence_one"}', { status: 201, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await prepareManagedApproval({
      request: { approval_id: "apr_one", run_id: "run_one", run_session_id: "gateway_one", client_id: "client_one" },
      apiKey: "secret",
      gatewayUrl: "https://mcp.example.test/",
      pbUrl: "https://statewright.example.test/",
      cwd,
      clientId: "client_one",
      fetchImpl,
    });
    assert.equal(result.reviewUrl, "https://statewright.example.test/approvals/record_one");
    assert.equal(calls.length, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("managed approval preparation rejects a foreign client before network access", async () => {
  await assert.rejects(prepareManagedApproval({
    request: { approval_id: "apr_one", run_id: "run_one", run_session_id: "gateway_one", client_id: "foreign" },
    apiKey: "secret",
    gatewayUrl: "https://mcp.example.test",
    pbUrl: "https://statewright.example.test",
    cwd: process.cwd(),
    clientId: "client_one",
    fetchImpl: async () => { throw new Error("must not fetch"); },
  }), /mismatched client identity/);
});
