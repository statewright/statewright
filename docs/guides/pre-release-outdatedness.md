# Pre-release outdatedness sweep

`task check:pre-release` runs a focused public-surface outdatedness sweep before
a release. Retired or deprecated LLM model IDs and IDs that are no longer the
latest in their model line are hard failures on the public surface. Dependency
audits, older MCP specification dates, documented CLI flags, stale version pins,
catalog IDs whose retirement or shutdown falls within 30 days, and current-model
catalog entries checked more than 14 days ago are warnings unless a local asset
is clearly missing.

```sh
task check:pre-release
# or:
node --test scripts/check-retired-models.test.mjs scripts/check-current-models.test.mjs scripts/pre-release-outdatedness.test.mjs
node scripts/pre-release-outdatedness.mjs
```

The sweep is also wired into `task test:plugin-release` and `task release`.

## Retired and deprecated model IDs

The catalog lives at [`scripts/retired-model-ids.json`](../../scripts/retired-model-ids.json).
`scripts/check-retired-models.mjs` scans tracked files (`git ls-files`) and
fails on a whole-token match of any catalog id in the public surface: `README.md`,
`docs/`, `templates/`, `examples/`, and plugin `README.md`, `docs/`, and
`workflows/` trees. Hits in other first-party files (tests, implementation
heuristics) are reported as warnings. Tokens treat `-`, `.`, and `_` as part of
the id when they continue it, so a retired id that is a prefix of a current one
(for example a short `gpt-<n>` id versus a later `gpt-<n>.6-sol` id) does not
match, while a retired id followed by a sentence period still matches. Matching is case-insensitive for IDs of four or more characters. Shorter IDs stay
case-sensitive so plan codes do not false-positive. The catalog itself, `scripts/fixtures/pre-release-outdatedness/`, and
`vendor/` or `node_modules/` paths are skipped.

### Updating the catalog

1. Open the official deprecation pages:
   - [Anthropic model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)
   - [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)
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
switch it to the latest ID in the intended line from the provider's models
overview and record the source in the pull request.

## Latest model in each line

[`scripts/current-models.json`](../../scripts/current-models.json) records one
latest ID per verified provider line, with its official source URL and
`date_checked`. The current inventory covers Anthropic's Fable, Opus, Sonnet,
Haiku, and Mythos lines from the [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview),
and OpenAI's Astra, Sol, Terra, and Luna flagship lines from the [OpenAI models overview](https://developers.openai.com/api/docs/models).
The Claude overview shows Mythos 5.2 by name; its linked [Mythos model page](https://platform.claude.com/docs/en/models/mythos-5-2/overview)
provides the exact API ID recorded in the catalog.
The OpenAI overview does not print exact IDs for its specialized model groups,
so they are outside this inventory until an official models-page source confirms
their IDs and line membership.

`scripts/check-current-models.mjs` scans tracked files in the same public scope
as the retired-ID check. It recognizes provider-qualified routes and Bedrock IDs,
including the Bedrock version suffix, and checks dated IDs against the catalog's
latest alias. Bare GPT version IDs fail because the official current catalog
does not map them to a verified line; choose a specific current line ID instead.
A public example or workflow using an older ID fails even if that
ID remains available. A dated historical report can use an explicit exception
in [`scripts/current-model-allowlist.json`](../../scripts/current-model-allowlist.json).
Each exception names one path and one ID and gives a reason; it does not exempt
other files or other IDs in the same file. Use exceptions for immutable release
notes, migration records, and research evidence, not for active examples or
workflow defaults.

To refresh the inventory, open both official overviews, verify the latest exact
ID for every listed line, then update each entry's `id`, `source`, and
`date_checked` using the date you checked it. Add a line only when its exact ID
is shown by an official models-page source. Review public-surface failures and
update active docs, examples, templates, and workflows. Preserve historical
records through narrow, reasoned allowlist entries. Then run
`task check:pre-release`; a `date_checked` older than 14 UTC calendar days
produces a warning so the next release operator knows to recheck the pages.
