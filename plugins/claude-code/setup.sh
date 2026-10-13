#!/usr/bin/env bash
# The pre-0.3.4 manual-hook bootstrap is intentionally no longer executable.
set -euo pipefail
echo "Statewright 0.3.4 uses Claude's native plugin integration; setup.sh no longer installs hooks or a launcher." >&2
echo "Install/update statewright@statewright with Claude's plugin manager. See README.md for manual-hook migration." >&2
exit 1
