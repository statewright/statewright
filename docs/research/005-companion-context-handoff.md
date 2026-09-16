# Combined companion context handoff

Date: 2026-09-15. Local source changes; no deployment or live-session restart.

## Outcome and corrected scope

The intended stack is codex-local-models plus Statewright. Provider compatibility already belongs to `/Users/ben/plugins/codex-local-models`: its per-model HTTP adapter reconstructs plaintext from the exact thread's rollout, removes unsupported opaque items, preserves available checkpoint plaintext, normalizes the model slug, and bounds recent history. Statewright owns workflow routing and presentation. No native Codex fork is required by the cases validated here.

Earlier direct-endpoint probes omitted that adapter and used a synthetic Qwen catalog entry. They demonstrated failure of a different path. The companion now has a native regression probe using the launcher's actual merged native-cache/fallback/local catalog and production provider proxy, Python server and adapter. The probe assembles these components in isolation; it does not activate a production workflow or execute the gateway-connected `startRuntime` bootstrap.

## Gaps closed

- Recovery was performed before five-turn trimming, which could discard the reconstructed checkpoint. An internal-only message marker now reserves a bounded recovery prefix before trimming the remaining history. Available checkpoint plaintext is retained too. Recovery is bounded to a quarter of the configured input budget when necessary; current context/tool-pair safeguards still apply. This remains lossy context transfer, not decryption or a claim that encrypted content is a small fraction of meaning.
- Provider resume now verifies model as well as thread/provider. Failure recovery unsubscribes the newly attached connection before restoring the source; otherwise Codex can ignore the restoration override. Failed restoration invalidates cached thread metadata. Rejected preparation releases the route and does not start inference.
- The adapter emits a prompt-free recovery event. The launcher validates the originating model and event identifiers; the app-server proxy renders one warning per checkpoint for its matching active thread/model. Statewright supplies the wording. This uses native yellow warning styling, not ANSI injection or an unsupported custom color field.
- The companion consumes Statewright's shared hard-interrupt notice formatter for fixed authoritative routes immediately before its own boundary interruption. It does not guess a ladder winner or reclassify operator interruptions. Native terminal events are retained.
- The standalone Statewright proxy no longer silently falls back to a raw remote Qwen endpoint. An unconfigured Qwen route fails before detachment. The intended companion path uses its registered, launcher-owned compatibility profiles; an explicitly configured standalone endpoint remains the operator's responsibility.

## Validation

- 166 companion Node tests passed, including five real-native regression scenarios enabled with `RUN_NATIVE_CONTEXT_TESTS=1`.
- 61 Python tests passed, including combined recovery + five-turn trimming, strict byte budgets, tool-pair preservation and unchanged source rollout.
- 105 targeted Statewright tests passed: existing handoff presentation/interrupt behavior and the new no-silent-bypass guard.
- Native scenarios: ordinary OpenAI → Qwen → OpenAI, interrupted turns, an opaque checkpoint followed by seven Qwen turns, a source usage counter that forces local compaction, and an injected oversized return counter that forces OpenAI compaction. All destination requests—including compaction/prewarm—use accepted model names. Counter fixtures exercise branches; they are not GPU capacity benchmarks.
- The opaque scenario checks that the original plaintext sentinel reaches every Qwen request after the five-turn cutoff, ciphertext does not, and exactly one recovery warning appears. All native turns complete successfully; the interruption case preserves two interrupted terminals followed by completion.
- One live Qwen canary used synthetic history and a synthetic opaque checkpoint, fresh native home/thread, the real compatibility adapter and the deployed Qwen3.8-27B endpoint. Qwen returned the original `TOKEN_0` sentinel. The same thread then completed through the local OpenAI fixture. No real OpenAI authentication or existing session history was used.

The testing-expert approach kept production integration logic real and substituted only external app-server/model-service boundaries in the corresponding tests. The native probes use the actual native app-server instead of its protocol fixture.

## Reproduce

From `/Users/ben/plugins/codex-local-models`:

```sh
RUN_NATIVE_CONTEXT_TESTS=1 node --test tests/*.test.mjs
PYTHONPATH=python /Users/ben/.local/share/codex-local-models/venv/bin/python -m unittest discover -s tests -p 'test_*.py'
node scripts/probe-context-roundtrip.mjs --opaque
node scripts/probe-context-roundtrip.mjs --opaque --live-qwen
```

The last command contacts the live Qwen service; all other listed native probes use loopback model fixtures. Native tests are opt-in because they require this machine's pinned Codex 0.153.4 binary, model cache, Statewright checkout and companion Python environment. Probe-created homes are isolated temporary directories and existing sessions remain untouched.

## Limits and activation

Changes load on the companion's next normal relaunch. No running pane, global plugin installation, user auth or persisted session history was modified. These checks do not certify a fully live OpenAI/Qwen/OpenAI workflow, model-generated tool use after transfer, arbitrary attachments, or semantic preservation of all historical facts. The live canary proves one bounded plaintext-recovery task; original rollouts remain the source for omitted detail. Later inference failures are still native turn failures, not automatically retried across providers, avoiding duplicate side effects.
