# Syntax validation uses execution authority

## Decision

Normalize bounded syntax checks into a shared internal `SyntaxValidation`
intent, mapped to the existing `BoundedLocalExecution` capability. This extends
the runner-intent boundary rather than adding a command bypass to enforcement.
The first adapters are Node's existing `--check <relative-file>` and Bash's
`-n [--] <relative-file>`. Node's accepted behavior is unchanged.

This repairs a missing validation shape, not general command understanding.
Unknown interpreters, arbitrary scripts and opaque effects still require
their ordinary evidence/approval path. This does not resolve the separate
human-effect evidence contract for capability-restricted workflow states.

## Evidence and trust boundary

The prior parser returned `Passthrough` for a literal noninteractive Bash
syntax check. A regression test observed this before the implementation;
the test passed only after normalization was added. Commands in tests are
inert input strings and are never submitted to a shell.

Bash documents `-n` as syntax checking without executing the input commands,
and separately documents noninteractive startup handling. References, accessed
2026-11-06:

- [Set builtin](https://www.gnu.org/s/bash/manual/html_node/The-Set-Builtin.html)
- [Bash startup files](https://www.gnu.org/software/bash/manual/html_node/Bash-Startup-Files.html)

Do not infer a read-only sandbox from that flag. Interpreter startup and
inherited configuration remain part of the existing trusted execution
environment. The explicit execution capability is still required; `Read`,
`Write`, a command label, or a basename does not grant it. This uses the
existing executable-spelling trust boundary, not binary attestation.

Only one literal relative file is accepted. No interactive/login flags, inline
command strings, stdin/process substitution, unknown options, extra operands,
absolute/parent paths, untrusted executable paths or explicit startup-environment
injection can acquire this intent. Other shells are not assumed equivalent.
Transparent `command`/`env` wrappers use the existing shared normalizer.
Every surrounding AST leaf and redirection retains its own capability/risk.

## Validation and release boundary

Coverage includes positive parser shapes, negative startup/argument/path forms,
no read-only authority, six independent workflow-policy cases, and composition
with local writes, unresolved programs, destructive operations and networking.
Both AST-authority configurations are exercised in the resolver tests.

Native execution, approval dialogs and original-denial acceptance are separate
gates. No ledger entry may be cleared solely from these in-memory tests. No
model, threshold, workflow policy, subscription or approval protocol changes.
Deployment requires a new exact coordinated candidate; the already installed
candidate is not silently relabeled as containing this source change.

Executed source validation: default gateway suite450passed/0failed/7ignored;
metering-enabled gateway suite455passed/0failed/20ignored. The private static
ledger audit made95decisions without executing commands. The initial full-suite
run retained one stale uncertainty-eligibility expectation (449passed/1failed/
7ignored); the corrected test now asserts the explicit execution-capability
requirement and retains a separate unresolved Bash-entrypoint case. Independent
read-only review confirmed that repair. Ignored tests and native UI remain
separate from these passing source checks.

Rollback is a scoped revert of the syntax-intent adapter and its new tests;
Node checks retain their previous validation classification. Do not remove
explicit-denial or runtime-injection checks to obtain a passing result.
