import assert from "node:assert/strict";
import test from "node:test";
import { annotateStatewrightReadTool, annotateToolsListResponse } from "../lib/tool-annotations.mjs";

test("only the three proven Statewright reads gain absent annotations", () => {
  for (const name of ["statewright_get_state", "statewright_get_usage", "statewright_list_workflows"]) {
    assert.deepEqual(annotateStatewrightReadTool({ name }).annotations, {
      readOnlyHint: true, destructiveHint: false, openWorldHint: false,
    });
  }
  for (const name of ["statewright_transition", "statewright_load_workflow", "statewright_pause",
    "statewright_deactivate", "statewright_create_workflow", "statewright_force_state",
    "statewright_report_runtime_usage", "statewright_run_agent", "unknown", "toString"]) {
    const tool = { name };
    assert.equal(annotateStatewrightReadTool(tool), tool);
  }
});

test("explicit upstream hints and metadata survive conservatively", () => {
  for (const annotations of [{ readOnlyHint: false }, { destructiveHint: true }, { openWorldHint: true },
    { readOnlyHint: null }, null, []]) {
    const tool = { name: "statewright_get_state", annotations };
    assert.equal(annotateStatewrightReadTool(tool), tool);
  }
  const tool = { name: "statewright_get_usage", annotations: { title: "Usage", vendorHint: 1, readOnlyHint: true } };
  assert.deepEqual(annotateStatewrightReadTool(tool).annotations, {
    title: "Usage", vendorHint: 1, readOnlyHint: true, destructiveHint: false, openWorldHint: false,
  });
  assert.deepEqual(tool.annotations, { title: "Usage", vendorHint: 1, readOnlyHint: true });
});

test("enrichment leaves SSE, invalid JSON, other methods and unmatched replies byte-identical", () => {
  const request = Buffer.from('{"method":"tools/list","id":1}');
  const body = Buffer.from('{ "result": {"tools": [{"name":"statewright_get_state"}]}, "id":1 }\n');
  for (const [req, res, type] of [
    [request, body, "text/event-stream"],
    [Buffer.from('{"method":"tools/call","id":1}'), body, "application/json"],
    [Buffer.from('{"method":"tools/list","id":2}'), body, "application/json"],
    [request, Buffer.from("not json"), "application/json"],
    [Buffer.from("not json"), body, "application/json"],
    [request, Buffer.from('{"error":{"code":-1},"id":1}'), "application/json"],
  ]) assert.equal(annotateToolsListResponse(req, res, type), res);
  assert.equal(JSON.parse(annotateToolsListResponse(request, body, "application/json; charset=utf-8"))
    .result.tools[0].annotations.readOnlyHint, true);
});
