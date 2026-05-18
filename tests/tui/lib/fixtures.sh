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

teardown_fixture() {
  if [ -n "$FIXTURE_DIR" ] && [ -d "$FIXTURE_DIR" ]; then
    rm -rf "$FIXTURE_DIR"
  fi
}
