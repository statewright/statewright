# Dev shell-AST authority canary receipt

> Public excerpt sanitized 2026-10-10; operational details omitted or generalized.
> Historical results below were not rerun for this documentation cleanup.

Date: 2026-09-27. Source:
`5e51ceda7858da1c7bf0b53b05ddcfe6ef932935`.
Scope: build, deploy, and authenticated live canary against the development
gateway only. Staging and production were not promoted, and no plugin release
or branch merge was performed.

## Historical deployment scope

The development gateway was tested with AST authority and shadow enabled.
Private registry digests, rollout topology and deployment repair operations
are omitted; they are not public implementation requirements.

## Repair discovered by the first authority canary

An earlier authority build from `e027b038ad4cd28b527f920cb61e831b8a6ffcc2`
classified the corpus correctly, but safe compound reads were still denied by
downstream capability enforcement. The adapter mapper and pre-call interceptor
were independently re-running the legacy string classifier after the AST
pipeline had selected a resolved effect.

The repair carries the pipeline result through those boundaries. A resolved
read-only shell call can map only to a state's general `Read`/`read_file`
capability, and a local write only to `Write`/`write_file`. Explicit command
allowlists, blocked environment checks, edit limits, and capability
requirements remain in force. Risky or uncertain effects never use this
bypass. Gateway and native-hook regressions cover the safe compound-read and
hidden-write cases.

## Validation executed

The following checks were executed successfully in the feature worktree:

- Focused AST authority and fallback tests.
- Gateway RPC integration tests, including compound-read allow and hidden
  `git push` denial at the adapter boundary.
- Native hook regression for the same allow/deny pair.
- `cargo test --workspace`: gateway 307 passed, one ignored; all other
  workspace suites and doctests passed with no failures.
- A final `cargo test -p statewright-mcp-gateway`: 307 passed, one ignored,
  no failures.
- `git diff --check`.

Formatting was intentionally deferred to the final merge boundary and is not
claimed by this receipt.

## Authenticated authority canary

A disposable development user signed up through PocketBase, minted a key using
`POST /api/keys/generate`, initialized a real streamable MCP session, and
loaded the `bugfix` workflow. Ten `statewright_adapter_pre_tool` calls produced
the following asserted results:

| Case | Decision | Deterministic result |
| --- | --- | --- |
| Compound `if` read with `git rev-parse`, `tmux`, and `tail` | allow | `shell_ast`, Low/Local |
| Read-only loop over Git revisions | allow | `shell_ast`, Low/Local |
| Nested command substitution containing `git push` | deny | `shell_ast`, High/External |
| Shell-consumed heredoc containing `git push` | deny | `shell_ast`, High/External |
| Process substitution containing `git push` | deny | `shell_ast`, High/External |
| Logical OR leading to `git push` | deny | `shell_ast`, High/External |
| Conditional recursive deletion | deny | `shell_ast`, Critical/Local |
| Data heredoc redirected by `cat` | deny | `shell_ast`, Moderate/Local |
| Malformed shell input | deny | legacy `shell`, Moderate/Unknown |
| Opaque executable | deny | `shell_ast`, Moderate/Unknown |

Every case received a System One semantic status of `Assessed`. Gateway logs
independently recorded the AST comparison receipts and semantic assessments.
The malformed input fell back conservatively to the legacy classifier; the
opaque executable remained uncertain and denied.

## Cleanup and remaining gate

The canary key was revoked. Cleanup removed one workflow run, one workflow, two
consents, and the disposable user. A follow-up authenticated query returned
zero users with the canary prefix. Each temporary PocketBase superuser used for
cleanup was deleted, and no raw credential is retained in this receipt or the
repository.

The development gate is satisfied. Before a controlled staging promotion or
final merge, run the formatter, review its diff, rerun proportionate tests if
formatting changes tracked files, and preserve a clean Git tree. Staging and
production remain unchanged until that explicit promotion decision.

## Subsequent staging promotion

Later on 2026-09-27, the development-tested gateway was promoted to staging.
Deployment identities and private operational receipts are omitted.

The reusable authenticated canary in
`scripts/canary/live-shell-ast-authority.mjs` then passed all ten cases against
the staging MCP endpoint: both compound reads were allowed;
the hidden external writes, recursive deletion, data heredoc, malformed input,
and opaque executable were denied with the expected source, risk, and exposure;
and every case had semantic status `Assessed`. The canary revoked its key and
deleted its synthetic user. A server-side query confirmed zero remaining
shell-AST canary users and zero temporary cleanup superusers.

Companion application/OAuth deployment and backup records are outside this
public gateway receipt. Production was not changed.

## Final release-prep integration

The later `release/codex-0.3.4-prep` integration performed the formatter work
that this development receipt deliberately deferred. The broad Rust cleanup is
isolated in `6ce64ba` (`style: format Rust workspace`), followed by generated
Claude managed-client synchronization in `8a9ae59`. A fresh integrated
`cargo test --workspace` passed, including 310 gateway tests with zero failures
and one ignored test. This later local evidence does not replace or rerun the
staging canary above, and no production change was made.
