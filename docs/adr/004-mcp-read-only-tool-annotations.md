# MCP read-only tool annotations

Date: 2026-09-10. Status: implemented locally; gateway deployment not performed.
Base: `74f16eb`. Control run: `6d39b93d-e007-490c-9f89-7df8616ebd46`.

## Context and decision

`ToolInfo` dropped annotations, so native Codex conservatively requested approval
for Statewright read tools. User-configured `approve` means auto-approve; it was
not the cause. Correct tool metadata instead of broadening global permissions.

Preserve upstream standard hints and extension fields. Mark only three proven
reads (`statewright_get_state`, `statewright_get_usage`,
`statewright_list_workflows`) with `readOnlyHint: true`, `destructiveHint: false`,
and `openWorldHint: false`. Unknown and mutating tools retain conservative
defaults. Hints inform client behavior; gateway enforcement remains authoritative.

For existing gateway deployments, the managed bridge fills missing hints for
those same three tools in matching, successful JSON `tools/list` replies. It
preserves explicit contradictory or malformed annotations instead of overriding
them. SSE, failures, unmatched replies and other methods remain byte-identical.
Remove this compatibility enrichment after supported gateways all emit hints.
The bridge is already authenticated and targets the selected Statewright gateway;
it does not annotate arbitrary external MCP servers.

## Evidence and boundaries

Gateway library suite: 194 passed, one existing ignored test. Three focused
annotation tests pass. Six bridge/helper tests pass. Repository-generated Claude
managed bundle parity passes. Independent non-editing review found no permission
blocker. A personal native App Server preflight observed both read hints, and a
live Terra turn called both tools successfully with `approvalPolicy: never` and
zero approval callbacks.

Installed external Claude caches are stale (including prior unrelated files);
the broader installed-runtime check reports that drift. They were not updated.
No cluster deploy, push, global permission changes or active-TUI intervention.
Only generic MCP metadata changes belong here; personal Qwen provider routing
and telemetry wiring remain in `/Users/ben/plugins/codex-local-models`.

Rollback: revert this commit and regenerate the repository-managed Claude bundle.
New managed bridges pick up the source repair on launch. Serving gateways require
their normal separate deployment to expose native Rust annotations directly.
