import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectClaudeTranscriptUsage } from "../scripts/transcript-telemetry.mjs";

function transcriptRecord(id, input, cacheWrite, cacheRead, output, timestamp) {
  return JSON.stringify({
    uuid: `outer-${id}-${timestamp}`,
    timestamp,
    message: {
      id,
      role: "assistant",
      model: "claude-opus-4-6",
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
      },
    },
  });
}

test("projects deduplicated exact Claude transcript usage into the active state epoch", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-claude-telemetry-"));
  const session = "session-1";
  const project = join(home, ".claude", "projects", "-tmp-project");
  const stateFile = join(home, "state.json");
  const epochFile = join(home, "epoch");
  const ledgerFile = join(home, "ledger.json");
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  };
  try {
    await mkdir(project, { recursive: true });
    await writeFile(stateFile, JSON.stringify({
      run_id: "run-1", workflow: "agentic-engineering-default-v1", state: "baseline", context_budget_bytes: 64000,
    }));
    await writeFile(epochFile, "3\n");
    const transcript = join(project, `${session}.jsonl`);
    await writeFile(transcript, [
      transcriptRecord("message-1", 11, 2, 3, 5, "2026-08-04T00:00:00.000Z"),
      transcriptRecord("message-1", 11, 2, 3, 5, "2026-08-04T00:00:01.000Z"),
    ].join("\n") + "\n");

    const options = { home, sessionId: session, threadId: "swc_session", stateFile, epochFile, ledgerFile, pbUrl: "http://example.test", apiKey: "key" };
    const first = await projectClaudeTranscriptUsage(options);
    assert.equal(first.projected, true);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].events[0].token_usage_delta, {
      input_tokens: 11, cache_write_input_tokens: 2, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 21,
    });
    assert.equal(requests[0].events[0].state_budget.state_epoch, 3);
    assert.equal(requests[0].events[0].thread_id, "swc_session");

    assert.equal((await projectClaudeTranscriptUsage(options)).projected, false);
    await writeFile(transcript, `${transcriptRecord("message-2", 7, 0, 1, 2, "2026-08-04T00:01:00.000Z")}\n`, { flag: "a" });
    const second = await projectClaudeTranscriptUsage(options);
    assert.equal(second.projected, true);
    assert.deepEqual(requests[1].events[0].state_budget.token_usage, {
      input_tokens: 18, cache_write_input_tokens: 2, cached_input_tokens: 4, output_tokens: 7, reasoning_output_tokens: 0, total_tokens: 31,
    });

    await writeFile(stateFile, JSON.stringify({
      run_id: "run-1", workflow: "agentic-engineering-default-v1", state: "completed", context_budget_bytes: 64000,
    }));
    await writeFile(epochFile, "4\n");
    await writeFile(transcript, `${transcriptRecord("message-3", 2, 0, 0, 1, "2026-08-04T00:02:00.000Z")}\n`, { flag: "a" });
    const terminal = await projectClaudeTranscriptUsage(options);
    assert.equal(terminal.projected, true);
    assert.equal(requests[2].events[0].state, "completed");
    assert.equal(requests[2].events[0].state_budget.state_epoch, 4);
    assert.deepEqual(requests[2].events[0].token_usage_delta, {
      input_tokens: 2, cache_write_input_tokens: 0, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 3,
    });
    assert.doesNotMatch(await readFile(ledgerFile, "utf8"), /assistant content|tool_result|prompt/i);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(home, { recursive: true, force: true });
  }
});
