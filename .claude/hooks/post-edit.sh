#!/bin/sh
# PostToolUse hook: auto-format the edited file when tooling is available.
# Defensive by design — exits 0 (never blocks) and no-ops until the project
# scaffold (M0.1) has installed prettier. Reads the hook payload from stdin.

payload=$(cat)
# Extract "file_path":"..." without requiring jq.
file=$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

[ -n "$file" ] || exit 0
[ -f "$file" ] || exit 0
[ -f package.json ] || exit 0
[ -d node_modules ] || exit 0

case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.css)
    npx --no-install prettier --write "$file" >/dev/null 2>&1
    ;;
esac

case "$file" in
  *.ts|*.tsx)
    npx --no-install eslint --fix "$file" >/dev/null 2>&1
    ;;
esac

exit 0
