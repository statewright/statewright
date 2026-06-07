#!/bin/bash
# Run sw-agent on a SWE-bench instance and evaluate the result.
#
# Usage:
#   ./swebench-run.sh <instance_id> [model_url] [model_name]
#
# Example:
#   ./swebench-run.sh sympy__sympy-20590 https://qwen3-8b.ollama.casa.enhasa.cloud/v1 qwen3:8b

set -euo pipefail

INSTANCE_ID="${1:?Usage: swebench-run.sh <instance_id> [model_url] [model_name]}"
MODEL_URL="${2:-https://qwen2-5-coder-14b.ollama.casa.enhasa.cloud/v1}"
MODEL_NAME="${3:-qwen3:8b}"
RUN_ID="${4:-statewright-$(date +%s)}"
MAX_STEPS="${5:-25}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HARNESS="$SCRIPT_DIR/../../../target/release/sw-agent"
WORKDIR=$(mktemp -d)
PREDICTIONS="$WORKDIR/predictions.jsonl"

echo "=== SWE-bench Run ==="
echo "Instance: $INSTANCE_ID"
echo "Model: $MODEL_NAME @ $MODEL_URL"
echo "Workdir: $WORKDIR"
echo ""

# Step 1: Extract instance data from SWE-bench
echo "[1/5] Fetching instance data..."
python3 -c "
import json, urllib.request

# Find the instance in the dataset
offset = 0
found = None
while offset < 500:
    url = f'https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Verified&config=default&split=test&offset={offset}&length=100'
    with urllib.request.urlopen(url) as resp:
        data = json.loads(resp.read())
        for r in data.get('rows', []):
            if r['row']['instance_id'] == '$INSTANCE_ID':
                found = r['row']
                break
    if found:
        break
    offset += 100

if not found:
    print('ERROR: Instance not found')
    exit(1)

with open('$WORKDIR/instance.json', 'w') as f:
    json.dump(found, f, indent=2)

print(f'  Repo: {found[\"repo\"]}')
print(f'  Base commit: {found[\"base_commit\"][:12]}')
print(f'  Difficulty: {found.get(\"difficulty\", \"unknown\")}')
print(f'  Problem: {found[\"problem_statement\"][:100]}...')
"

# Step 2: Clone repo at base_commit
echo ""
echo "[2/5] Checking out repo..."
REPO=$(python3 -c "import json; d=json.load(open('$WORKDIR/instance.json')); print(d['repo'])")
COMMIT=$(python3 -c "import json; d=json.load(open('$WORKDIR/instance.json')); print(d['base_commit'])")
PROBLEM=$(python3 -c "import json; d=json.load(open('$WORKDIR/instance.json')); print(d['problem_statement'][:500])")

REPO_DIR="$WORKDIR/repo"
git clone --quiet "https://github.com/$REPO.git" "$REPO_DIR" 2>/dev/null
cd "$REPO_DIR"
git checkout --quiet "$COMMIT"
echo "  Checked out $REPO @ ${COMMIT:0:12}"

# Step 3: Apply test patch (so tests exist for the harness to run)
echo ""
echo "[3/5] Applying test patch..."
TEST_PATCH=$(python3 -c "import json; d=json.load(open('$WORKDIR/instance.json')); print(d['test_patch'])")
echo "$TEST_PATCH" | git apply --allow-empty 2>/dev/null || echo "  Warning: test patch had issues"
echo "  Test patch applied"

# Step 4: Run sw-agent
echo ""
echo "[4/5] Running sw-agent..."
"$HARNESS" \
  --workdir "$REPO_DIR" \
  --task "$PROBLEM" \
  --ollama-url "$MODEL_URL" \
  --model "$MODEL_NAME" \
  --max-steps "$MAX_STEPS" \
  --use-hardcoded-machine \
  --log 2>&1 | tee "$WORKDIR/harness.log" | grep -E "COMPLETED|ABORT|FAILED|SUCCESS|ESCALATE|AUTO-TEST" | head -5

# Step 5: Capture diff and write predictions
echo ""
echo "[5/5] Capturing patch..."
cd "$REPO_DIR"
PATCH=$(git diff)

if [ -z "$PATCH" ]; then
  echo "  No changes made — writing empty patch"
  PATCH="# No changes"
fi

python3 -c "
import json
pred = {
    'instance_id': '$INSTANCE_ID',
    'model_patch': '''$PATCH''',
    'model_name_or_path': '$MODEL_NAME'
}
with open('$PREDICTIONS', 'w') as f:
    f.write(json.dumps(pred) + '\n')
print(f'  Predictions written to $PREDICTIONS')
"

echo ""
echo "=== Run complete ==="
echo "Predictions: $PREDICTIONS"
echo "Log: $WORKDIR/harness.log"
echo ""
echo "To evaluate:"
echo "  python3 -m swebench.harness.run_evaluation --predictions_path $PREDICTIONS --instance_ids $INSTANCE_ID --run_id $RUN_ID --namespace ''"
