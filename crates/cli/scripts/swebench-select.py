#!/usr/bin/env python3
"""Select a deterministic subset of SWE-bench Verified instances.

Usage:
    python3 swebench-select.py [--n 50] [--lang python] [--seed 42] [--out instances.txt]

Fetches from HuggingFace datasets API, filters by language, outputs instance IDs.
"""
import json
import urllib.request
import argparse
import hashlib

def fetch_all_instances():
    """Fetch all SWE-bench Verified instances from HuggingFace."""
    instances = []
    offset = 0
    while offset < 600:
        url = (
            f"https://datasets-server.huggingface.co/rows?"
            f"dataset=princeton-nlp%2FSWE-bench_Verified&config=default&split=test"
            f"&offset={offset}&length=100"
        )
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                data = json.loads(resp.read())
                rows = data.get("rows", [])
                if not rows:
                    break
                for r in rows:
                    instances.append(r["row"])
                offset += 100
        except Exception as e:
            print(f"Warning: fetch failed at offset {offset}: {e}")
            break
    return instances

def main():
    parser = argparse.ArgumentParser(description="Select SWE-bench Verified instances")
    parser.add_argument("--n", type=int, default=50, help="Number of instances to select")
    parser.add_argument("--lang", default="python", help="Filter by language (default: python, 'all' for no filter)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for deterministic selection")
    parser.add_argument("--out", default="instances.txt", help="Output file")
    parser.add_argument("--json", action="store_true", help="Also write full instance data as JSON")
    args = parser.parse_args()

    print(f"Fetching SWE-bench Verified instances...")
    instances = fetch_all_instances()
    print(f"  Total: {len(instances)} instances")

    # Filter by language (SWE-bench Verified is all Python, but check anyway)
    if args.lang != "all":
        # SWE-bench uses repo names — Python repos are the default
        # All SWE-bench Verified instances are Python
        pass

    # Deterministic selection: hash-based shuffle with seed
    def sort_key(inst):
        h = hashlib.sha256(f"{args.seed}:{inst['instance_id']}".encode()).hexdigest()
        return h

    instances.sort(key=sort_key)
    selected = instances[:args.n]

    # Write instance IDs
    with open(args.out, "w") as f:
        for inst in selected:
            f.write(inst["instance_id"] + "\n")

    print(f"  Selected: {len(selected)} instances → {args.out}")

    # Optionally write full JSON
    if args.json:
        json_path = args.out.replace(".txt", ".json")
        with open(json_path, "w") as f:
            json.dump(selected, f, indent=2)
        print(f"  Full data → {json_path}")

    # Summary
    repos = set(inst["repo"] for inst in selected)
    print(f"  Repos: {len(repos)} unique")
    for inst in selected[:5]:
        print(f"    {inst['instance_id']}")
    if len(selected) > 5:
        print(f"    ... and {len(selected) - 5} more")

if __name__ == "__main__":
    main()
