# Changelog

All notable changes to statewright are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- Renamed `crates/demo` → `crates/cli`, binary `sw-demo` → `sw-agent`

### Added
- **[cli]** `--json-events` flag for JSONL event streaming (MCP gateway integration)
- **[cli]** `--config` flag for gateway-controlled model routing and guardrails
- **[cli]** `--state` flag for per-state execution (hybrid TUI/agent architecture)
- **[cli]** `--context-file` for passing context to single-state runs
- **[cli]** `TuiEvent` enum with Serialize + `emit_json()` for structured events
- **[cli]** `RunConfig` struct with per-state model routing and guardrail config
- **[cli]** Transition events include `trigger` and `rationale` fields
- **[gateway]** `statewright_run_agent` MCP tool — spawns sw-agent subprocess
- **[gateway]** `statewright_run_agent` added to `is_custom_tool` routing
- **[agent]** `OllamaClient` derives `Clone` for per-state client creation
- **[pi]** Bug fixes: statewright_transition match, pluginStepCount reset, test gate
- **[pi]** Parser improvements: edit_line alias, `<tool_code>` format, arrow format, tool/function aliases
- **[pi]** Experimental text-only Ollama provider (gated behind `STATEWRIGHT_EXPERIMENTAL=1`)

## [1.1.0] — 2026-06-01

Plugin orchestration mode for local models that can't reliably navigate state machines on their own. The plugin drives transitions instead of relying on the model. Plus: self-hosted stack, Pi plugin rewrite, fork/join parallel execution, and per-state model routing.

### Added
- **[plugin/pi]** `meta.orchestration: "plugin"` — plugin-driven state machine navigation
- **[plugin/pi]** Programmatic reconnaissance — runs tests and reads source files without LLM involvement
- **[plugin/pi]** Sliding window context (6 messages) — prevents 33k token accumulation that kills small models
- **[plugin/pi]** Fresh system prompt per step with tool signatures matching the Rust harness format
- **[plugin/pi]** Test result steering — immediate guidance on pass/fail, last-resort auto-transition near nudge limit
- **[plugin/pi]** Fuzzy transition matching — resolves target state names and partial event names to correct events
- **[plugin/pi]** `transition` tool call recovery — maps `{"name": "transition", "args": {"event": "PLAN_READY"}}` to gateway calls (Rust harness compatibility)
- **[plugin/pi]** `<call:tool{args}<tool_call|>` recovery regex — catches gemma4's native Pi tool call format
- **[plugin/pi]** Gemma role fix — rewrites `role: "tool"` → `role: "tool_responses"` in provider requests
- **[plugin/pi]** 256-color powerline status bar with state/provider/model/thinking/iteration segments
- **[plugin/pi]** ANSI-colored tool results — diff formatting for edits, fill-to-EOL backgrounds, cyan tool headers
- **[plugin/pi]** Message formatter — replaces raw JSON with dim thought + cyan tool arrows after recovery
- **[plugin/pi]** Stream abort via `ctx.abort()` — kills runaway streams, corrective on next turn
- **[plugin/pi]** Gateway error passthrough — shows actual error text instead of "Gateway not reachable"
- **[engine]** `meta` field passthrough via `serde(flatten)` — no gateway changes needed for new meta fields
- **[gateway]** `allowed_commands` and `meta` included in `get_state` response

### Changed
- **[plugin/pi]** Unified inactivity monitor replaces rambling watchdog — shared nudge counter, escalating messages
- **[plugin/pi]** Inactivity timer not reset by tool calls — only resets on state transitions
- **[plugin/pi]** Auto-FAIL refreshes state and logs errors (was silently swallowed)
- **[plugin/pi]** Blocked tool calls no longer reset inactivity counter
- **[plugin/pi]** JSON `tool_calls` parsed before markdown code blocks (prevents thought-field code leakage)
- **[plugin/pi]** Bash enforcement blocks `sed -i` even when Bash is in allowed_tools
- **[plugin/pi]** Consistent `statewright_transition` naming across system prompt, nudges, and tool signatures
- **[plugin/pi]** FAIL transition labeled as "UNRECOVERABLE ERROR ONLY" in system prompt
- **[harness]** `parse_llm_response` catches markdown code blocks from local models

### Fixed
- **[plugin/pi]** `applyModelRouting` no longer re-arms inactivity timer on every turn (prevented timer from firing)
- **[plugin/pi]** `pi.exec` stdout extraction in edit handler (was matching against JSON wrapper, not file content)
- **[plugin/pi]** `find` command in programmatic recon uses grouped `-o` for multiple extensions
- **[plugin/pi]** Suppress "Continue with the next action" after workflow completion

### Also in this release
- **[self-hosted]** Docker Compose stack: gateway + PocketBase + Vue UI
- **[self-hosted]** Vue workflow editor with VueFlow graph visualization
- **[self-hosted]** PocketBase: 5 collections, public rules, gateway webhook, admin bootstrap
- **[self-hosted]** 43 Playwright E2E tests
- **[self-hosted]** PB lint post-hook catches 15+ deprecated Goja patterns
- **[self-hosted]** Anonymous telemetry via Umami
- **[plugin/pi]** Full rewrite for managed cloud gateway with MCP transport
- **[plugin/pi]** Tool execution recovery — catches JSON/code-block tool calls from local models
- **[plugin/pi]** Bash discernment — safe read-only commands pass through, writes blocked
- **[plugin/pi]** Auto-continuation nudges when model stalls
- **[plugin/pi]** Per-state model routing via `setModel()`
- **[plugin/pi]** Per-state thinking level control
- **[plugin/pi]** Native tool restrictions via `setActiveTools()`
- **[plugin/pi]** Rambling watchdog with stream abort
- **[plugin/pi]** 22 vitest tests
- **[plugin/omx]** Oh My Codex plugin with TypeScript hooks, 48 tests
- **[plugin/codex]** Codex CLI plugin ported from Claude Code with interrupts + fork/join
- **[plugin/claude-code]** Fork-branch-worker agent for parallel execution
- **[engine]** Fork/join schema — branch definitions, join strategies, on_complete/on_fail
- **[engine]** Interrupt schema with `$return` target resolution
- **[gateway]** MCP gateway crate with optional metering (FSL-1.1-Apache-2.0)
- **[gateway]** `allowed_commands`, `blocked_env`, `env_overrides` per state
- **[gateway]** Workflow log capture via PocketBase REST
- **[harness]** TUI E2E test harness: headless terminal, 13 scenarios, multi-agent support
- **[docs]** Fork/join guide, Pi plugin guide, updated READMEs

### Changed
- **[plugin/pi]** Session isolation for fork branches
- **[plugin/pi]** Watchdog timeout bumped to 45s
- **[plugin/pi]** Rationale enforcement on all transitions
- **[engine]** Guarded transitions with event data for context-aware branching

### Fixed
- **[plugin/pi]** Fork branch session routing preserves branch session ID
- **[plugin/pi]** Fork/join null context root cause, lock contention
- **[gateway]** Validate-before-write for `create_workflow`
- **[self-hosted]** Strict selectors for PB 0.37.3, `crypto.randomUUID` fallback
- **[docs]** Fixed all plugin search URLs, enforced transition rationale in guides

---

## [1.0.0] — 2026-05-19

First public release. State machine engine, Claude Code plugin, managed cloud gateway, five crates published to crates.io, cross-platform binaries on GitHub Releases.

### Added
- **[engine]** Pure Rust state machine engine — states, transitions, guards, final states, max iterations
- **[engine]** State definitions: `allowed_tools`, `instructions`, `max_iterations`, `blocked_env`, `env_overrides`
- **[engine]** Guard expressions with context-based evaluation
- **[engine]** Workflow validation: reachability, final state requirements, guard consistency
- **[agent]** LLM agent guardrail layer — prompt templates, tool enforcement, execution loop
- **[agent]** Ollama client with native and raw tool calling modes
- **[agent]** `parse_llm_response` — extracts structured actions from free-text LLM output
- **[harness]** Demo harness: bug-fix and TDD workflows against local models
- **[plugin/claude-code]** Claude Code plugin: stdio MCP proxy, dormant hooks, tool enforcement
- **[plugin/claude-code]** Bash guardrail bypass classification
- **[plugin/claude-code]** Tool discovery: scan MCP servers, upload catalog to PB
- **[plugin/claude-code]** `/statewright` slash command: start, stop, list, status
- **[plugin/claude-code]** PostToolUse transition notices with available tools
- **[plugin/claude-code]** `statewright_search_docs` — docs RAG via search index
- **[plugin/claude-code]** Block scripting interpreters in non-write states
- **[plugin/claude-code]** Workflow log capture: async PostToolUse, project-scoped, opt-in
- **[plugin/claude-code]** Command discovery: Taskfile/Makefile auto-detect
- **[plugin/claude-code]** Session isolation, MCP auto-approve, version update check
- **[gateway]** Managed cloud gateway at statewright.ai
- **[templates]** `bugfix` workflow template
- **[docs]** README with guardrails table, pricing, self-hosting guide
- **[legal]** FSL-1.1-Apache-2.0 license for gateway, Apache 2.0 for engine/agent/UI
- **[legal]** Patent pledge covering independent implementations
- **[ci]** GitHub Actions: tests, crate publish, cross-arch binaries (linux/darwin × amd64/arm64)

---

## [0.1.0] — 2026-04-28

Initial commit. Engine, agent, and Claude Code plugin scaffolding.

### Added
- **[engine]** State machine definition types and transition resolution
- **[plugin/claude-code]** Marketplace manifest and hook structure
- **[docs]** Project README

[Unreleased]: https://github.com/statewright/statewright/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/statewright/statewright/compare/v1...v1.1.0
[1.0.0]: https://github.com/statewright/statewright/releases/tag/v1
[0.1.0]: https://github.com/statewright/statewright/commit/464d0c3
