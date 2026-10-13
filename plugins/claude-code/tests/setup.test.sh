#!/usr/bin/env bash
set -euo pipefail
# Consumer setup no longer writes settings or activates legacy hook ownership.
exec node --test plugins/claude-code/tests/native-install.test.mjs plugins/claude-code/tests/native-migration.test.mjs
