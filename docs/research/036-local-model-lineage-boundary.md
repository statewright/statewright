# Local model artifact identity versus upstream lineage

## Summary

The existing local 4-bit comparator is reproducibly identified, but its pinned
repository revision does not publish a model card identifying its upstream
training variant. The proposed 9B comparator publishes contradictory upstream
labels. These findings do not explain the measured errors; they limit what can
be concluded about the upstream model family from those measurements.

## Findings

1. The tested `mlx-community/Qwen3.5-4B-4bit` revision
   `0e7ffd5c629ef7719d4cbc04069232580bfa9d9c` has no README in the revision's
   published file inventory and returns `cardData: null`. Its published weight
   SHA256 is `5fb9acd0246866381cf8c5c354c6db1019f6498eec4ccb4f5edcc71ffeacb2db`,
   matching the previously recorded local artifact identity. That identifies
   tested bytes, not a proven conversion lineage or training stage.
   [Pinned repository metadata](https://huggingface.co/api/models/mlx-community/Qwen3.5-4B-4bit/revision/0e7ffd5c629ef7719d4cbc04069232580bfa9d9c?blobs=true).
2. The proposed `mlx-community/Qwen3.5-9B-4bit` revision
   `8b2b98c00a6b4d291155e4890773ca8f769aee53` names
   `Qwen/Qwen3.5-9B-Base` in structured metadata but names `Qwen/Qwen3.5-9B`
   as the conversion source in its prose. Neither the filename nor a chat
   template resolves that inconsistency. The two published weight shards total
   5,950,221,072 bytes; disk size is not inference memory usage.
   [Pinned model card](https://huggingface.co/mlx-community/Qwen3.5-9B-4bit/blob/8b2b98c00a6b4d291155e4890773ca8f769aee53/README.md).
3. The upstream Base card explicitly distinguishes its pretraining-only purpose
   from direct interactive use. The presence of control tokens and a chat
   template therefore does not establish post-training. Its generic overview
   also contains broader family wording, so the variant-specific caveat matters.
   [Upstream Base card](https://huggingface.co/Qwen/Qwen3.5-9B-Base),
   [upstream non-Base card](https://huggingface.co/Qwen/Qwen3.5-9B).

## Evaluation consequence

Keep all existing scores and failure receipts. They remain observations about
the exact tested artifact, tokenizer, prompt, runtime and corpus. Do not relabel
the artifact as definitely Base, claim its failures prove a lineage defect, or
generalize them to all Qwen instruction models. The transition diagnostic still
disqualifies those exact tested configurations from enforcement.

Before calling a new comparator a scale-up of the same trained model, record
the upstream repository and immutable revision, training variant, converter
revision/options, quantization settings, and output hashes. Resolve contradictory
claims through conversion evidence or perform a reproducible conversion from a
selected official checkpoint. A community card assertion alone is weaker than
reproducible conversion evidence.

The current six-GiB advisory evaluation budget cannot be inferred sufficient for
the larger artifact from its shard size. An isolated resource-bounded comparison
may still evaluate the exact 9B artifact with this limitation recorded; it is not
a clean model-size ablation. Do not change production routing, download multiple
candidates speculatively, or enable semantic policy.
Use the same frozen public synthetic inputs and settings for a comparison, and
retain the separate requirement for human-adjudicated held-out acceptance.

## Method and limits

Focused primary-source metadata/card inspection on 2026-11-06; four sources
linked above. Pinned 4B README lookup returned 404; the revision API independently
showed no README, rather than interpreting a network failure as missing metadata.
No new weights, model inference, private input transmission, thresholds, runtime
configuration, workflow or entitlement changes. This is a provenance correction,
not evidence that a larger model would perform better.
