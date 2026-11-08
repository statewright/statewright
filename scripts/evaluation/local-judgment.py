#!/usr/bin/env python3
"""Isolated diagnostic evaluation only. Never executes commands or authorizes tools.

prepare downloads a pinned public checkpoint; evaluate is offline and accepts
only the synthetic public corpus emitted by the companion Rust example.
No server, hooks, resident configuration or enforcement thresholds are changed.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import time

FILES = ("rl_agent_config.json", "model.safetensors", "encoder/config.json",
         "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json")
REVISION = "7b928d828b7b0e022f929d9bd2e44165aa270148"


def digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def json_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def capture_input(path):
    with open(path, "rb") as stream:
        data = stream.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise ValueError("bounded synthetic input file required")
    return json.loads(data), hashlib.sha256(data).hexdigest()


def emit(path, value):
    with open(path, "x") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False, allow_nan=False)
        stream.write("\n")


def versions():
    return {item.metadata["Name"]: item.version for item in importlib.metadata.distributions()}


def token_evidence(agent, state, questions, build_sequence, render_options):
    truncated = False
    counts = {}
    for key, question in questions.items():
        internal = agent._to_internal(question)
        bounded, _ = build_sequence(agent.tok, state, internal, agent.cfg["max_len"], agent.cfg["head_max_len"])
        complete, _ = build_sequence(agent.tok, state, internal, 1_000_000, 1_000_000)
        option_cut = any(len(agent.tok(" " + option, add_special_tokens=False)["input_ids"]) > 48
                         for option in render_options(internal))
        truncated |= bounded != complete or option_cut
        counts[key] = {"bounded": len(bounded), "complete": len(complete), "option_truncated": option_cut}
    return truncated, counts


def case_questions(corpus, case):
    profile = case.get("question_profile")
    if profile is None:
        return corpus["questions"][case["task"]]
    profiles = corpus.get("question_profiles", {})
    if not isinstance(profile, str) or profile not in profiles or not profiles[profile]:
        raise ValueError("unknown or empty frozen question profile")
    return profiles[profile]


def validate_public_corpus(corpus):
    supported = (("statewright/synthetic-judgment-evaluation/v1", "public_synthetic"),
                 ("statewright/public-effect-set-evaluation/v1", "public_command_data"))
    if (corpus.get("schema"), corpus.get("classification")) not in supported:
        raise ValueError("only explicit public evaluation inputs are supported")
    cases = corpus.get("cases")
    if not isinstance(cases, list) or not 1 <= len(cases) <= 128:
        raise ValueError("case count outside bounded diagnostic corpus")
    identities = [(case["id"], case["arm"]) for case in cases]
    if len(set(identities)) != len(identities):
        raise ValueError("duplicate case/arm")
    for case in cases:
        case_questions(corpus, case)
    return cases


def main():
    harness_hash = digest(Path(__file__))
    started_at = datetime.now(timezone.utc).isoformat()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "evaluate"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "mps"), default="mps")
    parser.add_argument("--checkpoint", choices=("english", "typed-decisions"), default="english")
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    if not str(root).startswith("/Volumes/sidecar/") or not os.path.ismount("/Volumes/sidecar"):
        raise ValueError("evaluation storage requires the mounted Sidecar volume")
    if args.output.exists():
        raise ValueError("refusing to overwrite a prior receipt")
    os.environ["HF_HOME"] = str(root / "hf-cache")
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["USE_TF"] = "0"
    manifest_path = root / ("checkpoint.json" if args.checkpoint == "english" else "checkpoint-typed-decisions.json")
    prefix = "" if args.checkpoint == "english" else "typed-decisions/"
    if args.action == "prepare":
        if manifest_path.exists():
            raise ValueError("checkpoint already prepared; verify/reuse its receipt")
        stat = os.statvfs(root)
        if stat.f_bavail * stat.f_frsize < 5 * 1024**3:
            raise ValueError("less than 5 GiB available for bounded checkpoint preparation")
        from huggingface_hub import snapshot_download
        snapshot = Path(snapshot_download(
            "convaiinnovations/laya", revision=REVISION, token=False,
            allow_patterns=[prefix + name for name in FILES], cache_dir=root / "hf-cache" / "hub", max_workers=2,
        ))
        if snapshot.name != REVISION:
            raise ValueError("resolved checkpoint differs from requested immutable revision")
        snapshot = snapshot / prefix
        manifest = {"schema": "statewright/local-checkpoint/v1", "repository": "convaiinnovations/laya",
                    "revision": REVISION, "checkpoint": args.checkpoint, "snapshot": str(snapshot),
                    "files": {name: digest(snapshot / name) for name in FILES}, "packages": versions()}
        emit(manifest_path, manifest)
        emit(args.output, manifest)
        print(json.dumps({"checkpoint": str(manifest_path), "revision": REVISION, "file_count": len(FILES)}))
        return
    if not args.input:
        raise ValueError("bounded synthetic input file required")
    corpus, input_hash = capture_input(args.input)
    cases = validate_public_corpus(corpus)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("revision") != REVISION or set(manifest.get("files", {})) != set(FILES):
        raise ValueError("unsupported checkpoint manifest")
    snapshot = Path(manifest["snapshot"])
    if not snapshot.resolve().is_relative_to(root):
        raise ValueError("checkpoint escaped evaluation storage")
    for name, expected in manifest["files"].items():
        if digest(snapshot / name) != expected:
            raise ValueError(f"checkpoint preimage changed: {name}")
    if importlib.metadata.version("laya") != "0.3.20":
        raise ValueError("token completeness inspection is pinned to Laya 0.3.20")
    import laya
    import torch
    import laya.agent
    import laya.common
    from laya.common import build_sequence, render_options
    runtime_paths = {"laya.agent": Path(laya.agent.__file__), "laya.common": Path(laya.common.__file__)}
    runtime_hashes = {name: digest(path) for name, path in runtime_paths.items()}
    packages = versions()
    torch.set_num_threads(4)
    started = time.perf_counter()
    agent = laya.Agent(str(snapshot), device=args.device, token=False)
    load_ms = (time.perf_counter() - started) * 1000
    if str(agent.device) != args.device:
        raise RuntimeError("requested evaluation device unavailable; no silent fallback")
    loaded_hashes = {name: digest(snapshot / name) for name in FILES}
    # The vendor may normalize tokenizer_config on load. Preserve both sets of
    # hashes: nominal Hub revision alone does not describe effective bytes.
    rows = []
    for case in cases:
        questions = case_questions(corpus, case)
        state = case["state"]
        truncated, token_counts = token_evidence(agent, state, questions, build_sequence, render_options)
        row = {"id": case["id"], "task": case["task"], "arm": case["arm"],
               "input_hash": json_hash(state), "questions_hash": json_hash(questions),
               "expected": case["expected"], "tokens": token_counts, "truncated": truncated}
        row["question_profile"] = case.get("question_profile")
        row["diagnostic_context"] = {key: case[key] for key in ("draft_effect", "heuristic_risk", "heuristic_exposure") if key in case}
        for key in ("heuristic", "case_kind", "source"):
            if key in case:
                row[key] = case[key]
        if truncated:
            row.update(status="abstain_truncated", latency_ms=None)
        else:
            started = time.perf_counter()
            result = agent.predict(state, questions)
            if args.device == "mps":
                torch.mps.synchronize()
            row.update(status="assessed", latency_ms=(time.perf_counter() - started) * 1000,
                       result=result, result_hash=json_hash(result), actual_device=str(agent.device))
            if str(agent.device) != args.device:
                raise RuntimeError("inference silently changed devices; measurement invalid")
        rows.append(row)
        print(json.dumps({"id": row["id"], "arm": row["arm"], "status": row["status"], "latency_ms": row["latency_ms"]}), flush=True)
    receipt = {"schema": "statewright/local-judgment-diagnostic/v1", "enforcement": "none",
               "label_status": corpus["label_status"], "input_file_hash": input_hash,
               "harness_hash": harness_hash, "checkpoint": manifest,
               "started_at": started_at, "completed_at": datetime.now(timezone.utc).isoformat(),
               "runtime_source_hashes": runtime_hashes,
               "provenance_unchanged": digest(args.input) == input_hash and digest(Path(__file__)) == harness_hash
                   and all(digest(path) == runtime_hashes[name] for name, path in runtime_paths.items())
                   and all(digest(snapshot / name) == value for name, value in loaded_hashes.items()),
               "loaded_file_hashes": loaded_hashes, "packages": packages, "requested_device": args.device,
               "actual_device": str(agent.device), "load_ms": load_ms,
               "max_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, "rows": rows}
    emit(args.output, receipt)
    if not receipt["provenance_unchanged"]:
        raise RuntimeError("evaluation inputs/source changed during inference; receipt invalid for acceptance")


if __name__ == "__main__":
    main()
