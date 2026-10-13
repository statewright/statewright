#!/usr/bin/env bash
# Install through Claude's native plugin manager. No hook or credential writes.
set -euo pipefail
if [[ "${1:-}" == "--help" ]]; then
  echo "Usage: install.sh [--update]. Uses native claude, or STATEWRIGHT_CLAUDE_BIN."
  exit 0
fi
if [[ "$#" -gt 1 || ( "$#" -eq 1 && "$1" != "--update" ) ]]; then
  echo "Usage: install.sh [--update]" >&2
  exit 2
fi
CLAUDE_NATIVE_BIN="${STATEWRIGHT_CLAUDE_BIN:-claude}"
if [[ "${1:-}" == "--update" ]]; then
  "$CLAUDE_NATIVE_BIN" plugin update statewright@statewright
else
  "$CLAUDE_NATIVE_BIN" plugin marketplace add statewright/statewright
  "$CLAUDE_NATIVE_BIN" plugin install statewright@statewright
fi
echo "Reload plugins in Claude Code, or reopen Desktop Code."
echo "If you previously ran setup.sh, follow the manual-hook migration in this plugin's README before starting a workflow."
