#!/bin/bash
# Run sw-agent on a DeepSWE task and prepare for verification.
#
# Usage:
#   ./deepswe-run.sh <task_dir> [model_url] [model_name] [max_steps]
#
# Example:
#   ./deepswe-run.sh /tmp/deep-swe/tasks/psd-tools-blend-range-api \
#     https://qwen2-5-coder-14b.ollama.casa.enhasa.cloud/v1 qwen3:8b 25

set -euo pipefail

TASK_DIR="${1:?Usage: deepswe-run.sh <task_dir> [model_url] [model_name] [max_steps] [workflow]}"
MODEL_URL="${2:-https://qwen2-5-coder-14b.ollama.casa.enhasa.cloud/v1}"
MODEL_NAME="${3:-qwen3:8b}"
MAX_STEPS="${4:-50}"
WORKFLOW="${5:-bugfix}"  # bugfix or tdd-greenfield

# Escalation defaults to devstral-small-2:24b — override via env
ESCALATION_URL="${SW_ESCALATION_URL:-$MODEL_URL}"
ESCALATION_MODEL="${SW_ESCALATION_MODEL:-devstral-small-2:24b}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HARNESS="$SCRIPT_DIR/../../../target/release/sw-agent"
RESULTS_DIR="${TASK_DIR}/results/$(date +%s)"
mkdir -p "$RESULTS_DIR"

TASK_NAME=$(basename "$TASK_DIR")
TASK_TOML="$TASK_DIR/task.toml"
INSTRUCTION="$TASK_DIR/instruction.md"

# Extract metadata
REPO_URL=$(grep 'repository_url' "$TASK_TOML" | sed 's/.*= "//' | sed 's/"//')
BASE_COMMIT=$(grep 'base_commit_hash' "$TASK_TOML" | sed 's/.*= "//' | sed 's/"//')
LANGUAGE=$(grep 'language = ' "$TASK_TOML" | head -1 | sed 's/.*= "//' | sed 's/"//')
TITLE=$(grep 'display_title' "$TASK_TOML" | head -1 | sed 's/.*= "//' | sed 's/"//')

echo "=== DeepSWE Task: $TASK_NAME ==="
echo "Title: $TITLE"
echo "Language: $LANGUAGE"
echo "Repo: $REPO_URL"
echo "Commit: ${BASE_COMMIT:0:12}"
echo "Model: $MODEL_NAME"
echo "Escalation: $ESCALATION_MODEL"
echo ""

# Step 1: Clone repo at base commit
WORKDIR=$(mktemp -d)
echo "[1/4] Cloning repo..."
git clone --filter=blob:none --quiet "$REPO_URL" "$WORKDIR/repo" 2>/dev/null
cd "$WORKDIR/repo"
git reset --hard "$BASE_COMMIT" --quiet 2>/dev/null
echo "  Checked out at ${BASE_COMMIT:0:12}"

# Step 2: Read instruction
TASK_TEXT=$(cat "$INSTRUCTION")
echo "[2/4] Instruction loaded ($(wc -l < "$INSTRUCTION") lines)"

# Step 3: Run sw-agent
echo "[3/4] Running sw-agent (workflow: $WORKFLOW)..."

# Select machine flag based on workflow
MACHINE_FLAG="--use-hardcoded-machine"
if [ "$WORKFLOW" = "tdd-greenfield" ]; then
  MACHINE_FLAG="--tdd-greenfield"
fi

SW_ESCALATION_URL="$ESCALATION_URL" SW_ESCALATION_MODEL="$ESCALATION_MODEL" \
"$HARNESS" \
  --workdir "$WORKDIR/repo" \
  --task "$TASK_TEXT" \
  --ollama-url "$MODEL_URL" \
  --model "$MODEL_NAME" \
  --max-steps "$MAX_STEPS" \
  $MACHINE_FLAG \
  --no-restore \
  --log 2>&1 | tee "$RESULTS_DIR/harness.log" | \
  grep -E "COMPLETED|ABORT|FAILED|LOCALIZE|AUTO-TEST|ESCALATE|TDD|RED|GREEN" | head -10

# Step 4: Capture diff
echo ""
echo "[4/4] Capturing patch..."
cd "$WORKDIR/repo"
git add -A 2>/dev/null
PATCH=$(git diff HEAD)
if [ -z "$PATCH" ]; then
  echo "  No changes made"
  echo "# No changes" > "$RESULTS_DIR/patch.diff"
else
  echo "$PATCH" > "$RESULTS_DIR/patch.diff"
  LINES=$(echo "$PATCH" | wc -l)
  FILES=$(echo "$PATCH" | grep "^diff --git" | wc -l)
  echo "  $FILES file(s), $LINES line(s) of diff"
fi

# Save metadata
cat > "$RESULTS_DIR/meta.json" << EOF
{
  "task": "$TASK_NAME",
  "model": "$MODEL_NAME",
  "escalation_model": "$ESCALATION_MODEL",
  "workflow": "$WORKFLOW",
  "language": "$LANGUAGE",
  "max_steps": $MAX_STEPS,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "workdir": "$WORKDIR/repo"
}
EOF

echo ""
echo "=== Results ==="
echo "Patch: $RESULTS_DIR/patch.diff"
echo "Log: $RESULTS_DIR/harness.log"
echo "Workdir: $WORKDIR/repo (kept for verification)"
echo ""
echo "To verify with Pier:"
echo "  pier run -p $TASK_DIR --agent oracle --include-task-name $TASK_NAME"
