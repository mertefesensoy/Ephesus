#!/bin/sh
# Stop hook: when a session ends with TypeScript files modified but a red
# typecheck, surface it instead of letting the session end silently green-less.
# No-ops until the scaffold exists. Never blocks more than once per stop
# (respects stop_hook_active).

payload=$(cat)
printf '%s' "$payload" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0

[ -f package.json ] || exit 0
[ -d node_modules ] || exit 0
grep -q '"typecheck"' package.json || exit 0

git status --porcelain 2>/dev/null | grep -qE '\.(ts|tsx)$' || exit 0

if ! npm run --silent typecheck >/tmp/eph-typecheck.log 2>&1; then
  echo '{"decision":"block","reason":"Typecheck is failing on your modified TypeScript files. ENGINEERING-STANDARDS.md requires green typecheck at every commit — fix the errors in /tmp/eph-typecheck.log before finishing (or explicitly tell the Architect why you are stopping red)."}'
  exit 0
fi

exit 0
