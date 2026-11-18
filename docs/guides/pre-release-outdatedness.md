# Pre-release outdatedness sweep

`task check:pre-release` runs a focused public-surface outdatedness sweep before
a release. Retired or deprecated LLM model IDs are a hard failure. Dependency
audits, older MCP specification dates, documented CLI flags, and stale version
pins are reported as warnings unless a local asset is clearly missing.

```sh
task check:pre-release
# or:
node --test scripts/check-retired-models.test.mjs scripts/pre-release-outdatedness.test.mjs
node scripts/pre-release-outdatedness.mjs
```

The sweep is also wired into `task test:plugin-release` and `task release`.

## Retired and deprecated model IDs

The catalog lives at [`scripts/retired-model-ids.json`](../scripts/retired-model-ids.json).
`scripts/check-retired-models.mjs` scans tracked files (`git ls-files`) and
fails on a whole-token match of any catalog id in the public surface: `README.md`,
`docs/`, `templates/`, `examples/`, and plugin `README.md`, `docs/`, and
`workflows/` trees. Hits in other first-party files (tests, implementation
heuristics) are reported as warnings. Tokens treat `-`, `.`, and `_` as part of
the id when they continue it, so a retired id that is a prefix of a current one
(for example `gpt-5` vs `gpt-5.6-sol`) does not match, while `gpt-4.` still
matches. The catalog itself, `scripts/fixtures/pre-release-outdatedness/`, and
`vendor/` or `node_modules/` paths are skipped.

### Updating the catalog

1. Open the official deprecation pages:
   - [Anthropic model deprecations](https://docs.claude.com/en/docs/about-claude/model-deprecations)
   - [OpenAI deprecations](https://platform.openai.com/docs/deprecations)
2. Add or update only model ids those pages actually list. Do not invent ids or
   dates. Omit API endpoints and product features that are not model ids.
3. For each entry set `id`, `provider` (`anthropic` or `openai`), `status`
   (`retired` or `deprecated`), `deprecated_on` and `retired_on` when the page
   gives those dates, `replacement` when the page gives one, `source`, and
   `date_checked` (ISO date).
4. OpenAI's page uses **Shutdown** for models that no longer accept requests;
   record those as `status: "retired"` with `retired_on` set to the shutdown
   date.
5. Run `task check:pre-release` and confirm the tests pass.

When a default, example, or template still names a retired or deprecated model,
switch it to a current id from the provider's models overview (for Anthropic,
prefer the current Sonnet id) and record the source in the pull request.
