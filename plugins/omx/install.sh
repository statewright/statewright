#!/usr/bin/env bash
# Statewright OMX plugin installer
# Merges statewright hooks into .codex/hooks.json (OMX-compatible)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CODEX_DIR="${HOME}/.codex"
HOOKS_FILE="${CODEX_DIR}/hooks.json"

echo "[statewright] Installing OMX plugin..."

# Build if dist/hook.js missing
if [ ! -f "$SCRIPT_DIR/dist/hook.js" ]; then
  echo "[statewright] Building hook..."
  cd "$SCRIPT_DIR"
  npm install --production=false 2>/dev/null
  npx tsup src/hook.ts --format esm --out-dir dist --no-splitting 2>/dev/null
  cd - >/dev/null
fi

# Ensure .codex dir exists
mkdir -p "$CODEX_DIR"

# Read our hooks template
OUR_HOOKS=$(cat "$SCRIPT_DIR/hooks.json")

if [ -f "$HOOKS_FILE" ]; then
  # Merge: preserve existing hooks, add ours
  # Check if statewright hooks already present
  if grep -q "statewright" "$HOOKS_FILE" 2>/dev/null; then
    echo "[statewright] Hooks already installed in $HOOKS_FILE"
  else
    echo "[statewright] Merging hooks into existing $HOOKS_FILE"
    # Use jq to merge hook arrays per event
    if command -v jq &>/dev/null; then
      MERGED=$(jq -s '
        .[0] as $existing | .[1] as $new |
        {hooks: (
          ($existing.hooks // {}) | to_entries |
          map({key: .key, value: (
            .value + ($new.hooks[.key] // [])
          )}) |
          from_entries |
          . + (($new.hooks // {}) | to_entries | map(select(.key | IN($existing.hooks // {} | keys[]) | not)) | from_entries)
        )}
      ' "$HOOKS_FILE" <(echo "$OUR_HOOKS"))
      echo "$MERGED" > "$HOOKS_FILE"
    else
      echo "[statewright] jq not found. Add hooks from $SCRIPT_DIR/hooks.json to $HOOKS_FILE manually."
      exit 1
    fi
  fi
else
  # No existing hooks — write ours directly
  echo "$OUR_HOOKS" > "$HOOKS_FILE"
fi

echo "[statewright] Hooks installed at $HOOKS_FILE"

# Prompt for API key if missing
KEY_FILE="${HOME}/.statewright/api_key"
if [ ! -f "$KEY_FILE" ] || [ -z "$(cat "$KEY_FILE" 2>/dev/null)" ]; then
  echo ""
  echo "[statewright] No API key found."
  echo "  1. Sign up at https://statewright.ai/keys"
  echo "  2. Paste your key when prompted in your next OMX session"
  echo "  Or: echo 'sw_live_...' > ~/.statewright/api_key"
fi

echo "[statewright] Done."
