#!/bin/bash
# Claude Code post-hook: catch deprecated/broken PocketBase patterns (0.37.x baseline)
# Matches: *.pb.js, *.pb.ts, pb_hooks/*, pb_migrations/*, pb_data/hooks/*
#
# Install in .claude/settings.json:
#   "hooks": {
#     "PostToolUse": [{
#       "matcher": "Edit|Write",
#       "command": "/path/to/pb-lint.sh \"$CLAUDE_TOOL_INPUT_FILE_PATH\""
#     }]
#   }

FILE="$1"
[[ -z "$FILE" ]] && exit 0

case "$FILE" in
  *.pb.js|*.pb.ts|*pb_hooks/*|*pb_migrations/*|*pb_data/hooks/*) ;;
  *) exit 0 ;;
esac

[[ ! -f "$FILE" ]] && exit 0

ISSUES=$(mktemp)
trap "rm -f $ISSUES" EXIT

# --- Pre-0.23 hook events ---
grep -n 'onBeforeCreate\|onAfterCreate\|onBeforeUpdate\|onAfterUpdate\|onBeforeDelete\|onAfterDelete' "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — use onRecordCreate\/Update\/Delete with e.next()/' >> "$ISSUES"

grep -n 'onRecordBeforeCreateRequest\|onRecordBeforeUpdateRequest\|onRecordBeforeDeleteRequest\|onRecordAfterCreateRequest\|onRecordAfterUpdateRequest\|onRecordAfterDeleteRequest' "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — use onRecordCreate\/Update\/Delete (no Request suffix)/' >> "$ISSUES"

grep -n 'onModelBeforeCreate\|onModelAfterCreate\|onModelBeforeUpdate\|onModelAfterUpdate\|onModelBeforeDelete\|onModelAfterDelete' "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — model hooks removed, use onRecordCreate\/Update\/Delete/' >> "$ISSUES"

# Hook collection filter as first arg (should be last)
grep -n 'onRecordCreate\s*(\s*["'"'"']' "$FILE" \
  | sed 's/^/  WRONG_ARG: /' | sed 's/$/ — collection name goes LAST: onRecordCreate(fn, "collection")/' >> "$ISSUES"
grep -n 'onRecordUpdate\s*(\s*["'"'"']' "$FILE" \
  | sed 's/^/  WRONG_ARG: /' | sed 's/$/ — collection name goes LAST: onRecordUpdate(fn, "collection")/' >> "$ISSUES"
grep -n 'onRecordDelete\s*(\s*["'"'"']' "$FILE" \
  | sed 's/^/  WRONG_ARG: /' | sed 's/$/ — collection name goes LAST: onRecordDelete(fn, "collection")/' >> "$ISSUES"

# --- Pre-0.23 DAO / record access ---
grep -n '\$app\.dao()' "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — use app.findRecordById(), app.save(), etc./' >> "$ISSUES"

grep -n 'saveRecord(' "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — use app.save(record)/' >> "$ISSUES"

grep -n 'deleteRecord(' "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — use app.delete(record)/' >> "$ISSUES"

grep -n 'e\.model\b' "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — use e.record/' >> "$ISSUES"

grep -n '\$models\.\|new SchemaField' "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — use new Record(collection) or fields: [...] in Collection/' >> "$ISSUES"

# record.getString(), getBool(), getInt() etc — only .get()/.set() exist
grep -n 'record\.getString\|record\.getBool\|record\.getInt\|record\.getFloat\|record\.getStringSlice\|record\.getDateTime' "$FILE" \
  | sed 's/^/  BROKEN: /' | sed 's/$/ — use record.get("field"), typed getters do not exist/' >> "$ISSUES"

# --- Schema vs fields ---
grep -n 'schema\s*:\s*\[' "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — use fields: [...] (schema was renamed to fields in 0.23)/' >> "$ISSUES"

# options wrapper on field defs (should be flat)
grep -n '"options"\s*:\s*{' "$FILE" \
  | grep -v '//' \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — field properties are flat now, not nested in options: {}/' >> "$ISSUES"

# --- Auth renames ---
grep -n 'requireAdminAuth' "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — renamed to requireSuperuserAuth in 0.23+/' >> "$ISSUES"

grep -n 'requireAdminOrRecordAuth' "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — renamed to requireSuperuserOrRecordAuth/' >> "$ISSUES"

grep -n "c\.get.*authRecord" "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — use e.auth or c.auth (direct property)/' >> "$ISSUES"

grep -n '["'"'"']_users["'"'"']' "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — collection is "users" not "_users"/' >> "$ISSUES"

# --- Goja runtime ---
grep -n '\basync \|\bawait ' "$FILE" \
  | sed 's/^/  GOJA: /' | sed 's/$/ — async\/await not available in Goja/' >> "$ISSUES"

grep -n '\brequire(' "$FILE" \
  | sed 's/^/  GOJA: /' | sed 's/$/ — require() not available, use PB globals/' >> "$ISSUES"

grep -n '^\s*import \|^\s*export ' "$FILE" \
  | sed 's/^/  GOJA: /' | sed 's/$/ — ES modules not available, each .pb.js is standalone/' >> "$ISSUES"

grep -n '\?\.' "$FILE" | grep -v '//' \
  | sed 's/^/  GOJA: /' | sed 's/$/ — optional chaining (?.) not supported, use \&\& guard/' >> "$ISSUES"

grep -n '??' "$FILE" | grep -v '//' \
  | sed 's/^/  GOJA: /' | sed 's/$/ — nullish coalescing (??) not supported, use ternary/' >> "$ISSUES"

grep -n 'new Promise\|setTimeout\s*(\|setInterval\s*(\|\.then\s*(\|\.catch\s*(' "$FILE" \
  | sed 's/^/  GOJA: /' | sed 's/$/ — no Promises\/timers in Goja, all ops are synchronous/' >> "$ISSUES"

grep -n 'e\.httpContext' "$FILE" \
  | sed 's/^/  DEPRECATED: /' | sed 's/$/ — event IS the context now, access request from e directly/' >> "$ISSUES"

grep -n 'new BadRequestError\|new NotFoundError\|new ForbiddenError\|new UnauthorizedError' "$FILE" \
  | sed 's/^/  BROKEN: /' | sed 's/$/ — these constructors do not exist, use e.json(status, {error: msg})/' >> "$ISSUES"

# --- Missing e.next() ---
if grep -q 'onRecordCreate\|onRecordUpdate\|onRecordDelete' "$FILE"; then
  if ! grep -q 'e\.next()' "$FILE"; then
    echo "  MISSING: e.next() — record hooks must call e.next() to continue the chain" >> "$ISSUES"
  fi
fi

# --- Migration checks ---
if grep -q 'migrate(' "$FILE"; then
  if grep -q "type: 'base'" "$FILE" && ! grep -q "autodate" "$FILE"; then
    echo "  WARNING: No autodate fields — PB 0.22+ does not auto-create created/updated" >> "$ISSUES"
  fi
fi

if [[ -s "$ISSUES" ]]; then
  echo "PB lint — $(basename "$FILE"):"
  cat "$ISSUES"
  exit 1
fi
