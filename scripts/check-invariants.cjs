#!/usr/bin/env node
/**
 * Grep-able invariant tripwires (ENGINEERING-STANDARDS §5). These are the rules
 * a reviewer cannot reliably hold in their head, so CI holds them instead.
 *
 * 1. ADR-0004 / invariant §4 — only the main process runs git, and only through
 *    `src/main/git.ts`. A `git` invocation anywhere else is the failure mode the
 *    whole single-committer design exists to prevent.
 * 2. Invariant §5 — `log.jsonl` and the cost ledger are append-only. A truncating
 *    write to either is a rewrite of the book of record.
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SEARCH_DIRS = ['src', 'shims', 'scripts']

/** Files allowed to invoke git, relative to the repo root. */
const GIT_ALLOWLIST = new Set([path.join('src', 'main', 'git.ts')])

const GIT_INVOCATION = /(execFile|execFileSync|exec|execSync|spawn|spawnSync)\s*\(\s*['"`]git['"`]/
const TRUNCATING_LOG_WRITE = /writeFileSync\s*\([^)]*\b(log\.jsonl|cost_ledger|costLedger)\b/

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

const failures = []
for (const dir of SEARCH_DIRS) {
  for (const file of walk(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file)
    const text = fs.readFileSync(file, 'utf8')
    text.split('\n').forEach((line, i) => {
      if (GIT_INVOCATION.test(line) && !GIT_ALLOWLIST.has(rel)) {
        failures.push(
          `${rel}:${i + 1}  git is invoked outside src/main/git.ts — ADR-0004 allows exactly one committer`
        )
      }
      if (TRUNCATING_LOG_WRITE.test(line)) {
        failures.push(
          `${rel}:${i + 1}  truncating write to an append-only record — invariant §5 forbids rewriting it`
        )
      }
    })
  }
}

if (failures.length > 0) {
  console.error('Invariant tripwire failures:\n')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('')
  process.exit(1)
}
console.log(`invariants ok (${SEARCH_DIRS.join(', ')})`)
