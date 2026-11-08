# Execution structure and remote reads

Shell syntax and CLI delegation are different boundaries. A shell AST sees a
remote launcher as a command; it does not by itself resolve the process that
launcher starts, or the script a package manager selects.

## Decision

Use shared literal invocation structure to preserve operation position, known
option arity, and delegated argv boundaries. Unknown option semantics remain
incomplete evidence. Represent delegated commands as children with their
execution location; parse literal nested shell programs as shell ASTs. Preserve
private argv locally and send only bounded code-owned labels, effects, hierarchy
and explicit evidence-loss markers to a semantic assessor.

Recognized remote observation has its own `RemoteRead` effect class. It requires
the existing `Read` capability, not generic network or mutation authority. Keep
external exposure in every reducer, including package lifecycle units. Explicit
Read denial still wins. `LowLocal` explicitly excludes external reads; broader
policies can admit proven remote reads without calling them local.

Expand literal package scripts with separately recorded pre/post hooks. Bind
forwarded arguments only to the selected script, retain installed runner and
manifest evidence, and assess every resolved unit. A test name is not a safety
proof: repository execution continues to require its execution capability.

## Limits and safety

- Parsing does not establish target identity, account permission, executable
  provenance, or permission to run a remote process.
- Remote execution keeps an unresolved parent boundary even when an inner
  utility is recognizable. It is not granted `Read` merely by unwrapping it.
- Mixed local execution/remote observation remains unresolved until the policy
  supports its full capability union; it must not be mislabeled local.
- Missing operands, unsupported flags, expansions and truncation are not read
  evidence. Known writes/destruction cannot be erased by a read companion.
- Semantic provider activation, held-out calibration, scores and thresholds
  are unchanged. Evaluation-only providers remain evaluation-only.
- Pending native approval is not denial or failure. Preserve the original
  waiting request; do not cancel or issue `BLOCKED` solely because of silence.

Rollback is a source revert of the execution-evidence change. No data migration
or workflow definition change is required. Source tests do not prove installed
runtime behavior; coordinated packaging and staging acceptance remain separate.
