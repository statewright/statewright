# statewright-engine

Pure state machine execution engine for AI agent guardrails. No LLM in the loop — deterministic evaluation of states, transitions, guards, and tool restrictions.

```rust
use statewright_engine::{MachineDefinition, resolve_transition, validate_definition};

let def: MachineDefinition = serde_json::from_str(json)?;
validate_definition(&def)?;
let result = resolve_transition(&def, "planning", "READY", &context);
```

Apache 2.0. No runtime dependencies beyond serde.

[docs.statewright.ai](https://docs.statewright.ai) | [GitHub](https://github.com/statewright/statewright)
