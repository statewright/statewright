# Local reference recall

`statewright_search_references` gives an agent a cheap, local RAG-style recall
path for the repository it is already working in. Use it when the answer may
live in an ADR, spec, workflow, validation artifact, or old commit and loading
all of that material into the prompt would waste context.

The tool is deliberately simpler than an embeddings service. It chunks an
allowlisted corpus, ranks lexical matches, and returns bounded excerpts with
enough provenance to verify them:

```text
statewright_search_references(
  query="session isolation paused workflow resume",
  limit=6
)
```

Each result includes:

- source class, path, and line range;
- source hash and the indexed commit SHA;
- the score and reasons that affected ranking; and
- a bounded excerpt for follow-up reading.

In a Git checkout, the first query creates an index under Git's private
metadata. Later queries reuse unchanged chunks and re-ingest files whose tracked
head or stat signature changed. A read-only Git directory falls back to an
in-memory query; a non-Git directory can search eligible files but has no commit
history or persistent index. Recent commits are indexed alongside repository
files when Git history is available.

## Corpus and privacy boundary

The index considers guidance and documentation, workflows, source code, and
bounded Statewright validation summaries. It excludes ignored and generated
directories, oversized files, secret-shaped paths, and files containing common
credential patterns. Repository text stays in the plugin process; the managed
gateway receives no indexed artifact or query result.

This is a retrieval aid, not an authority. A hit can be stale, an ADR can have
been superseded, and lexical ranking does not prove causality. Use the returned
path, line range, hash, and commit to inspect the source before making a factual
claim or reversing an implementation decision.

## Good query shapes

Lexical ranking has more signal when a query includes concrete anchors:

- a symbol or changed path plus the failure: `Gateway session_id cross client`;
- a validation signature: `final_verification_unavailable all children`;
- a decision and its constraint: `ADR local recall secrets excluded`; or
- a rejected hypothesis: `Mcp-Session-Id API key collision`.

Use recall at stitch boundaries rather than before every tool call. Intake can
recover the governing spec, triage can search failed hypotheses, and
adversarial review can compare the final diff with prior ADRs and commits. That
keeps the retrieval cost small and gives each result a specific decision to
inform.

The command is packaged by the Codex, Claude Code, OMX, Pi, Cursor, and
opencode integrations. In Codex and Claude Code it is exposed by the local MCP
proxy; in clients with a companion MCP, that server exposes only reference
search and no workflow or network operations.
