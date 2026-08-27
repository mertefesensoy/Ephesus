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
 * 3. ENGINEERING-STANDARDS §5 / ADR-0010 — credentials reach code in exactly one
 *    way. Nothing outside `watch/` and `herald/` reads a credential out of the
 *    process environment, and no fixture anywhere carries a secret-shaped
 *    string: the M1 audit found one (`ghp_…`) and renamed it, and a tripwire is
 *    the only thing that keeps the next one out.
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SEARCH_DIRS = ['src', 'shims', 'scripts', 'test']

/**
 * The tripwire file itself carries the patterns it hunts for; scanning it would
 * be a guaranteed self-match.
 */
const SELF = path.join('scripts', 'check-invariants.cjs')

/**
 * Files allowed to invoke git, relative to the repo root. ADR-0004's rule is
 * about the Agora: the running app has exactly one committer, `src/main/git.ts`.
 * The two development-repo tools below run outside the app process against this
 * repository itself (arming hooks, scanning commit attribution) and can never
 * touch a harness home — name new exceptions here explicitly or not at all.
 */
const GIT_ALLOWLIST = new Set([
  path.join('src', 'main', 'git.ts'),
  path.join('scripts', 'arm-hooks.cjs'),
  path.join('scripts', 'check-attribution.cjs')
])

const GIT_INVOCATION = /(execFile|execFileSync|exec|execSync|spawn|spawnSync)\s*\(\s*['"`]git['"`]/
const TRUNCATING_LOG_WRITE = /writeFileSync\s*\([^)]*\b(log\.jsonl|cost_ledger|costLedger)\b/

/**
 * A credential read straight out of the environment. ADR-0010 routes every
 * credential through the broker, so the only modules with a reason to touch one
 * are the Watch (which owns the broker) and the Herald (which calls a voice
 * provider from main). `EPH_*` harness variables are not credentials.
 */
const ENV_SECRET_READ = /process\.env\s*(\.\s*[A-Za-z_$][\w$]*|\[\s*['"`][^'"`]*['"`]\s*\])/g
const SECRET_NAMED = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i
/**
 * `EPH_*` are the harness's own spawn-scoped variables (agent id, hook token,
 * agent directory) — capabilities the harness mints and the shim is designed to
 * read, declared in the spawn plan and inspectable from the agent card
 * (ENGINEERING-STANDARDS §4). They are not credentials and the broker has
 * nothing to do with them.
 */
const HARNESS_ENV = /EPH_/
const ENV_SECRET_ALLOWED_DIRS = [
  path.join('src', 'main', 'watch'),
  path.join('src', 'main', 'herald')
]

/**
 * Provider-issued credential prefixes. Deliberately prefix-anchored and
 * length-bounded rather than entropy-based: a heuristic that fires on any long
 * random-looking string would flag every hook token fixture in the suite, and a
 * tripwire nobody trusts gets deleted.
 */
const SECRET_SHAPED = new RegExp(
  [
    'sk-[A-Za-z0-9_-]{16,}',
    'gh[pousr]_[A-Za-z0-9]{16,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'xox[baprs]-[A-Za-z0-9-]{10,}',
    'AKIA[0-9A-Z]{12,}',
    'AIza[0-9A-Za-z_-]{30,}',
    '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  ].join('|')
)

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
      if (rel === SELF) return
      if (!ENV_SECRET_ALLOWED_DIRS.some((dir) => rel.startsWith(dir + path.sep))) {
        for (const match of line.matchAll(ENV_SECRET_READ)) {
          if (SECRET_NAMED.test(match[0]) && !HARNESS_ENV.test(match[0])) {
            failures.push(
              `${rel}:${i + 1}  credential read from process.env outside src/main/watch/ or src/main/herald/ — ADR-0010 routes every credential through the broker`
            )
          }
        }
      }
      if (SECRET_SHAPED.test(line)) {
        failures.push(
          `${rel}:${i + 1}  secret-shaped string — ENGINEERING-STANDARDS §5 forbids one in code or fixtures`
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
