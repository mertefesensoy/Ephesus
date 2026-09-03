#!/usr/bin/env node
/**
 * Grep-able invariant tripwires (ENGINEERING-STANDARDS §5). These are the rules
 * a reviewer cannot reliably hold in their head, so CI holds them instead.
 *
 * 1. ADR-0004 / invariant §4 — only the main process runs git, and only through
 *    `src/main/git.ts`. A `git` invocation anywhere else is the failure mode the
 *    whole single-committer design exists to prevent.
 * 2. Invariant §5 — `log.jsonl` and the cost ledger are append-only. A truncating
 *    write to either is a rewrite of the book of record — and since M3.2 the
 *    ledger is a SQL table, so the rewrite vector is `UPDATE`/`DELETE`, which a
 *    `writeFileSync` pattern cannot see.
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
 * `test/` is scanned for the SECRET rules only. ADR-0004's single-committer
 * rule governs the running app's Agora, while TEST-STRATEGY §6 explicitly wants
 * integration tests against "real fs and real git in temp dirs" — extending the
 * git tripwire there would fail CI for a rule that was never about tests.
 */
const SECRET_RULES_ONLY = ['test']

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
 * The ledger's rewrite vector now that it is a SQLite table. No allowlist: not
 * one line of this app has a reason to update or delete a spend row, and the
 * whole "a restart cannot zero your spend" guarantee rests on that staying
 * true. `cost_fold_cursor` is deliberately NOT covered — it is metadata about
 * reading, not a record of spend, and it is meant to be updated.
 */
const LEDGER_REWRITE = /(UPDATE|DELETE\s+FROM)\s+cost_ledger\b/i

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

/**
 * Invariant §6 / UI-DESIGN §6 — the floor's model modules own no clock.
 *
 * `src/renderer/src/floor/` is projections: which frame, which pose, which
 * overlay all follow from a time the CALLER supplies, so replaying the same
 * snapshots draws the same floor and a test can pin a moment. The M6 close-out
 * audit mutated the overlay frame and the walk bob to read `Date.now()` and
 * every case stayed green — a module reading its own clock is exactly the
 * "second source of truth" ADR-0014 forbids, and it is invisible to a suite
 * that never advances a clock.
 *
 * `FloorCanvas.tsx` is exempt: it is the component, not a model. It owns the
 * ticker, and it is where `Date.now()` legitimately enters and is passed down.
 */
const FLOOR_MODEL_DIR = 'src/renderer/src/floor/'
const RENDERER_CLOCK =
  /\bDate\.now\s*\(|\bnew Date\s*\(|\bsetInterval\s*\(|\brequestAnimationFrame\s*\(/
const CLOCK_ALLOWLIST = new Set(['src/renderer/src/floor/FloorCanvas.tsx'])
/** Path separators differ by platform; the rules above are written with `/`. */
const slashed = (rel) => rel.split(path.sep).join('/')
/**
 * Comment lines, skipped for the clock rule ONLY. These modules document the
 * clock they refuse to own, and a tripwire that fired on its own rationale
 * would teach the next author to delete the rationale. Every other rule here
 * still reads comments — a secret-shaped string is a leak wherever it sits.
 */
const IS_COMMENT = /^\s*(\/\/|\/\*|\*)/

const failures = []
for (const dir of SEARCH_DIRS) {
  const appRules = !SECRET_RULES_ONLY.includes(dir)
  for (const file of walk(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file)
    const text = fs.readFileSync(file, 'utf8')
    text.split('\n').forEach((line, i) => {
      if (appRules && GIT_INVOCATION.test(line) && !GIT_ALLOWLIST.has(rel)) {
        failures.push(
          `${rel}:${i + 1}  git is invoked outside src/main/git.ts — ADR-0004 allows exactly one committer`
        )
      }
      if (appRules && TRUNCATING_LOG_WRITE.test(line)) {
        failures.push(
          `${rel}:${i + 1}  truncating write to an append-only record — invariant §5 forbids rewriting it`
        )
      }
      if (appRules && LEDGER_REWRITE.test(line)) {
        failures.push(
          `${rel}:${i + 1}  UPDATE/DELETE against cost_ledger — the ledger is append-only (invariant §5, ADR-0011)`
        )
      }
      const floorModel =
        slashed(rel).startsWith(FLOOR_MODEL_DIR) && !CLOCK_ALLOWLIST.has(slashed(rel))
      if (appRules && floorModel && !IS_COMMENT.test(line)) {
        const clock = line.match(RENDERER_CLOCK)
        if (clock) {
          failures.push(
            `${rel}:${i + 1}  ${clock[0]} in a floor model — UI-DESIGN §6 makes these projections; take the clock as an argument (M6.10)`
          )
        }
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

/**
 * 5. The seam rule, first half (ENGINEERING-STANDARDS §6.7, M8.0) — every
 *    production module is reachable from an application entry point, or its
 *    unreachability is a recorded decision. The walk lives in
 *    `scripts/reachability.cjs` (it needs the compiler's module resolution,
 *    not a regex); this file is where CI runs it, so one command still covers
 *    every tripwire. The M6 Herald — 1,406 lines only tests could reach — is
 *    the defect it exists to catch, and it is the first entry on its allowlist.
 */
const { reachabilityFailures, reachableModules } = require('./reachability.cjs')
failures.push(...reachabilityFailures())

if (failures.length > 0) {
  console.error('Invariant tripwire failures:\n')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('')
  process.exit(1)
}
const { reached, universe, typeOnly } = reachableModules()
console.log(
  `invariants ok (${SEARCH_DIRS.join(', ')}; reachability ${String(reached.size)}/${String(universe.size)} src modules reached, ${String(universe.size - reached.size)} unreachable by recorded decision, ${String(typeOnly.size)} type-only)`
)
