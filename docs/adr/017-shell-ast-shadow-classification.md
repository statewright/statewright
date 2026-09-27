# ADR 017: Shadow Bash AST classification before enforcement

## Status

Accepted for development shadow evaluation. The AST result is not an authorization
input.

## Context

The production shell classifier recognizes common commands and splits simple
pipelines and logical chains. That is insufficient for the compound programs
agents routinely submit: conditionals, loops, command substitutions, nested
shells, process substitutions, and heredocs can hide an executable effect
behind a harmless leading token. Adding more regular-expression exceptions
would repeat the same failure mode.

Heredocs require consumer-aware handling. Quoting the delimiter controls
expansion by the outer shell; it does not make the body inert. A body consumed
by `bash` or `sh` is executable shell code, while the same body consumed by
`cat` is data. Foreign interpreters and unknown consumers require their own
intent classification rather than pretending their source is Bash.

## Decision

Add a Tree-sitter Bash parser as an opt-in development shadow:

- walk every executable AST node across pipelines, logical chains,
  substitutions, loops, and conditional branches;
- recursively parse constant `bash -c` programs and heredocs bound to a known
  shell consumer, including quoted heredocs;
- classify output redirections independently from heredoc contents;
- treat known data consumers as data, foreign-language consumers as opaque,
  external consumers as external, and unknown consumers as opaque;
- retain deterministic operation precedence so one destructive or external
  node dominates harmless read nodes;
- cap source bytes, AST depth, executable-node count, and recursive shell
  depth; exceeding a bound yields an opaque result;
- leave the existing classifier authoritative while an explicitly selected
  development deployment sets `STATEWRIGHT_SHELL_AST_SHADOW=true` and records
  comparisons.

The comparison receipt contains only parse status, bounded counts, aggregate
risk/exposure bands, and disagreement direction. It never contains command
text, paths, arguments, heredoc bodies, or source code.

## Promotion criteria

The AST path may become authoritative only after a representative corpus shows:

1. no downgrade of known destructive, external, account, or mutating effects;
2. correct treatment of shell-code versus data heredocs;
3. bounded behavior on malformed and adversarial input;
4. materially fewer false denials on legitimate compound reads;
5. independent adversarial review of interpreter delegation and nested-shell
   limits;
6. a development canary showing that authorization decisions remain those of the
   existing classifier while comparison telemetry is collected.

System One remains the fallback for unresolved semantics. The development
shadow submits a separate, privacy-bounded AST operation shape to that model
for comparison; this response cannot influence authorization. Raw source and
heredoc contents remain local.

## Consequences

This adds a parser dependency and a small per-shell-call cost only when the
development flag is enabled. It gives us measured disagreement data instead of
replacing one heuristic with an uncalibrated parser. Non-shell interpreters
remain deliberately opaque until a language-specific parser or calibrated
System One code-intent contract exists.
