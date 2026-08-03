#!/usr/bin/env bash
# Test fixture setup — create temp directories with files for testing

FIXTURE_DIR=""

setup_fixture() {
  FIXTURE_DIR=$(mktemp -d /tmp/sw-tui-test-XXXXXX)
  mkdir -p "$FIXTURE_DIR/site/pb/hooks"
  mkdir -p "$FIXTURE_DIR/site/pb/migrations"
  mkdir -p "$FIXTURE_DIR/src"
  mkdir -p "$FIXTURE_DIR/.git"

  # Git init so branch operations work
  cd "$FIXTURE_DIR" && git init -q && git checkout -b main -q
  echo "test" > "$FIXTURE_DIR/src/main.rs"
  echo '/// <reference path="../pb_data/types.d.ts" />' > "$FIXTURE_DIR/site/pb/hooks/test.pb.js"
  echo 'console.log("test hook")' >> "$FIXTURE_DIR/site/pb/hooks/test.pb.js"
  git add -A && git commit -q -m "initial"

  echo "$FIXTURE_DIR"
}

setup_sympy_fixture() {
  FIXTURE_DIR=$(mktemp -d /tmp/sw-tui-sympy-XXXXXX)
  cp -r "$SCRIPT_DIR/../crates/cli/fixtures/sympy-21847/"* "$FIXTURE_DIR/" 2>/dev/null || \
    cp -r "$(dirname "$SCRIPT_DIR")/crates/cli/fixtures/sympy-21847/"* "$FIXTURE_DIR/" 2>/dev/null || \
    cp -r "/Users/$USER/dev/statewright/crates/cli/fixtures/sympy-21847/"* "$FIXTURE_DIR/"
  rm -rf "$FIXTURE_DIR/__pycache__" "$FIXTURE_DIR/.pytest_cache" "$FIXTURE_DIR/.opencode"
  cd "$FIXTURE_DIR" && git init -q && git checkout -b main -q
  git add -A && git commit -q -m "initial: sympy-21847 itermonomials bug"
  echo "$FIXTURE_DIR"
}

setup_checkout_fixture() {
  FIXTURE_DIR=$(mktemp -d /tmp/sw-tui-checkout-XXXXXX)
  cp -r "$SCRIPT_DIR/fixtures/checkout_bug/"* "$FIXTURE_DIR/"
  cd "$FIXTURE_DIR" && git init -q && git checkout -b main -q
  git add -A && git commit -q -m "initial: checkout with failing validation tests"
  echo "$FIXTURE_DIR"
}

setup_weather_fixture() {
  FIXTURE_DIR=$(mktemp -d /tmp/sw-tui-weather-XXXXXX)
  cp -r "$SCRIPT_DIR/fixtures/weather_bug/"* "$FIXTURE_DIR/"
  cd "$FIXTURE_DIR" && git init -q && git checkout -b main -q
  git add -A && git commit -q -m "initial: weather classifier with failing tests"
  echo "$FIXTURE_DIR"
}

setup_delivery_fixture() {
  local root
  root=$(mktemp -d /tmp/sw-tui-delivery-XXXXXX)
  local hooks="$root/.statewright/delivery-hooks"
  local runs="$root-runs"
  local evidence="$root-evidence"
  mkdir -p "$hooks"

  cat > "$root/RESULT.txt" <<'EOF'
TODO
EOF
  cat > "$root/Taskfile.yml" <<'EOF'
version: '3'

tasks:
  test:
    cmds:
      - test "$(cat RESULT.txt)" = "DELIVERED"
EOF
  cat > "$hooks/Taskfile.yml" <<'EOF'
version: '3'

tasks:
  delivery:prepare:
    cmds:
      - |
        printf '%s\n' prepare >> "$STATEWRIGHT_DELIVERY_EVIDENCE_PATH/hook-actions.log"
        printf '%s\n' '{"ok":true,"action":"prepare"}'
  delivery:deploy:
    cmds:
      - |
        test "$(cat "$STATEWRIGHT_DELIVERY_PRIMARY_WORKTREE/RESULT.txt")" = "DELIVERED"
        printf '%s\n' deploy >> "$STATEWRIGHT_DELIVERY_EVIDENCE_PATH/hook-actions.log"
        printf '%s\n' '{"ok":true,"action":"deploy"}'
  delivery:validate:
    cmds:
      - |
        test "$(cat "$STATEWRIGHT_DELIVERY_PRIMARY_WORKTREE/RESULT.txt")" = "DELIVERED"
        printf '%s\n' validate >> "$STATEWRIGHT_DELIVERY_EVIDENCE_PATH/hook-actions.log"
        printf '%s\n' '{"ok":true,"action":"validate"}'
  delivery:discard:
    cmds:
      - |
        printf '%s\n' discard >> "$STATEWRIGHT_DELIVERY_EVIDENCE_PATH/hook-actions.log"
        printf '%s\n' '{"ok":true,"action":"discard"}'
EOF

  local digest
  digest=$(node "$SCRIPT_DIR/../../plugins/codex/scripts/statewright-delivery.mjs" \
    digest --root "$hooks" | jq -r '.sha256')
  cat > "$root/.statewright/delivery.json" <<EOF
{
  "version": 1,
  "enabled": true,
  "workspace": {
    "mode": "git_worktree",
    "root": "$runs",
    "repositories": [
      {
        "name": "smoke",
        "path": "..",
        "base_ref": "main",
        "target_branch": "main",
        "primary": true
      }
    ]
  },
  "hooks": {
    "root": "delivery-hooks",
    "taskfile": "Taskfile.yml",
    "bundle_sha256": "$digest",
    "environment_allowlist": ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"],
    "action_timeout_ms": 30000
  },
  "preview": {
    "evidence_root": "$evidence"
  },
  "promotion": {
    "mode": "manual"
  }
}
EOF

  (cd "$root" && git init -q && git checkout -b main -q && git add -A && \
    git commit -q -m "initial delivery smoke fixture")
  echo "$root"
}

teardown_delivery_fixture() {
  local root="$1"
  rm -rf "$root" "$root-runs" "$root-evidence"
}

teardown_fixture() {
  if [ -n "$FIXTURE_DIR" ] && [ -d "$FIXTURE_DIR" ]; then
    rm -rf "$FIXTURE_DIR"
  fi
}
