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
  cp -r "$SCRIPT_DIR/../crates/demo/fixtures/sympy-21847/"* "$FIXTURE_DIR/" 2>/dev/null || \
    cp -r "$(dirname "$SCRIPT_DIR")/crates/demo/fixtures/sympy-21847/"* "$FIXTURE_DIR/" 2>/dev/null || \
    cp -r "/Users/$USER/dev/statewright/crates/demo/fixtures/sympy-21847/"* "$FIXTURE_DIR/"
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

teardown_fixture() {
  if [ -n "$FIXTURE_DIR" ] && [ -d "$FIXTURE_DIR" ]; then
    rm -rf "$FIXTURE_DIR"
  fi
}
