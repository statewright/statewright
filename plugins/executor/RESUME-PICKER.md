# Resume picker input provenance

The display contract is `[original directory] latest submitted input`.

The directory comes from the rollout's first `session_meta` record. Text comes
from native `history.jsonl`, matched by `session_id`; later entries replace
earlier ones. Rollout user-role messages are not a reliable input source because
they include plugin, environment, and hook injections. Never recover labels by
keyword filtering those messages or appending saved thread titles.

Only immutable rollout metadata is cached. Input history is refreshed for every
list request. Both `name` and `preview` are replaced in the returned list; saved
thread metadata, identity, status, and pagination cursors are preserved. Entries
without submitted input and known subagent threads are omitted. Terminal
automation is indistinguishable from typing in native input history.

## Local validation — 2026-09-11

- Statewright transport tests: 28 passed, including refreshed input with cached
  metadata, original cwd, hidden entries, preserved cursors, and exact labels.
- Native TUI: verified the picker displays the current thread's latest submitted
  input and original directory with no extra suffix or stale title.
- The local-model companion uses the same formatter. Its picker selection also
  restores the durable managed client identity before native resume; that fix
  stays in the companion. A previously failing saved local-model session loaded
  its transcript and reached the ready prompt through the actual picker.
- Independent review: formatter approved; companion root-binding race identified,
  fixed with synchronous reservation, regression tested, and re-reviewed.
- No new model prompt was submitted during resume validation. No staging or
  production deployment was performed. Test fixtures use synthetic directories.

Workflow: `76753200-c689-45c3-99e3-25984b8fa9e1`. Both local launchers read these
source files on next launch; an already running resident retains its loaded code.
Rollback is reverting the corresponding local commits and relaunching that
client. No saved conversation or native input-history file is rewritten.
