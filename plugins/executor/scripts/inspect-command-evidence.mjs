// Read-only diagnostic: never invokes the supplied command. Payloads and
// filesystem paths stay out of the report.
import { collectCommandEvidence } from "../lib/command-evidence.mjs";

const [cwd, command] = process.argv.slice(2);
if (!cwd || !command || process.argv.length !== 4) {
  throw new Error("Usage: inspect-command-evidence.mjs CWD COMMAND (inspection only)");
}
const evidence = await collectCommandEvidence("exec_command", { cmd: command, workdir: cwd });
process.stdout.write(`${JSON.stringify({
  schema: "statewright/command-evidence-diagnostic/v1", executed: false,
  inspected: evidence !== null, complete: evidence?.complete ?? false,
  reason: evidence?.reason ?? null, units: evidence?.commands.length ?? 0,
  files: evidence?.files.length ?? 0, collected_at_ms: evidence?.collected_at_ms ?? null,
})}\n`);
