#!/usr/bin/env node
// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { randomBytes } from 'node:crypto'

/**
 * `eph-usage` — the statusline shim (ADR-0019).
 *
 * Engines that render a status line hand the renderer a JSON document on stdin.
 * Claude Code's carries a `rate_limits` block: the account's rolling 5-hour and
 * 7-day windows, each as a used-percentage and the epoch second it resets. That
 * is the only signal in this system that tracks what the Architect actually
 * pays against, and — unlike a token budget — it **resets**, which is what lets
 * a company that runs for days be paced instead of merely capped.
 *
 * This shim's whole job: read that document, write what it saw to
 * `<harness home>/usage.json`, and print a short human line back so the
 * Architect can see the same number the harness is steering on.
 *
 * Usage (as written into an engine's settings by its adapter):
 *   node eph-usage.mjs --out <path-to-usage.json>
 *
 * Environment, from the spawn plan (SDD §3):
 *   EPH_AGENT_ID
 *
 * **Fail-open, always** (SDD §10, and the same rule `eph-hook.mjs` follows).
 * The status line renders on the agent's critical path; a shim that threw, hung
 * or exited non-zero would cost the agent its turn over a telemetry file.
 * Every path here exits 0, and trouble goes to stderr only.
 *
 * Stdout is what the engine draws, so nothing but the status text is ever
 * written there.
 */

/** @param {readonly string[]} argv @returns {{ out: string | null }} */
function parseArgs(argv) {
  /** @type {string | null} */
  let out = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && i + 1 < argv.length) out = argv[++i] ?? null
  }
  return { out }
}

/** @returns {Promise<string>} */
function readStdin() {
  return new Promise((resolve) => {
    let buf = ''
    // A status line that never gets its input must still render. Without this
    // the shim would hang holding the engine's draw, which is the one failure
    // mode a fail-open shim is not allowed to have.
    const timer = setTimeout(() => resolve(buf), 2000)
    timer.unref?.()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buf += chunk
    })
    process.stdin.on('end', () => {
      clearTimeout(timer)
      resolve(buf)
    })
    process.stdin.on('error', () => {
      clearTimeout(timer)
      resolve(buf)
    })
  })
}

/**
 * One window as the harness stores it, or null when the engine did not report
 * it. `resets_at` is epoch SECONDS on the wire and epoch MILLISECONDS here —
 * converted once, at the boundary, so nothing downstream has to remember which
 * unit it is holding.
 *
 * @param {unknown} raw
 * @returns {{ usedPercent: number, resetsAt: number } | null}
 */
function windowOf(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  const used = /** @type {Record<string, unknown>} */ (raw)['used_percentage']
  const resets = /** @type {Record<string, unknown>} */ (raw)['resets_at']
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
  if (typeof resets !== 'number' || !Number.isFinite(resets) || resets <= 0) return null
  return { usedPercent: used, resetsAt: Math.round(resets * 1000) }
}

/**
 * Temp-then-rename (invariant §4). `usage.json` is read by the harness on a
 * timer while several agents' status lines write it, so a reader must never
 * see a half-written file. The temp name carries random bytes because two
 * agents rendering at once would otherwise collide on it.
 *
 * @param {string} file @param {string} data
 */
function writeAtomic(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, file)
}

/** @param {{ usedPercent: number } | null} w @param {string} label */
function part(w, label) {
  return w ? `${label} ${Math.round(w.usedPercent)}%` : null
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2))
  const raw = await readStdin()

  /** @type {Record<string, unknown>} */
  let status = {}
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) status = parsed
  } catch {
    // Not JSON — nothing to observe. The status line still renders.
  }

  const limits = status['rate_limits']
  const fiveHour = windowOf(
    typeof limits === 'object' && limits !== null
      ? /** @type {Record<string, unknown>} */ (limits)['five_hour']
      : null
  )
  const sevenDay = windowOf(
    typeof limits === 'object' && limits !== null
      ? /** @type {Record<string, unknown>} */ (limits)['seven_day']
      : null
  )

  // The engine reports no windows until after its first API response, and none
  // at all for accounts that have no subscription limit. A report is written
  // either way: "we looked and there was nothing" is a fact the harness needs,
  // and its absence is what tells the Watch the shim is not running at all.
  if (out) {
    try {
      writeAtomic(
        out,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            observedAt: Date.now(),
            agentId: process.env['EPH_AGENT_ID'] ?? null,
            fiveHour,
            sevenDay
          },
          null,
          2
        )}\n`
      )
    } catch (err) {
      process.stderr.write(`eph-usage: could not write ${out}: ${String(err)}\n`)
    }
  }

  const shown = [part(fiveHour, '5h'), part(sevenDay, '7d')].filter(Boolean)
  process.stdout.write(shown.length > 0 ? shown.join(' · ') : 'usage —')
}

main().catch((err) => {
  process.stderr.write(`eph-usage: ${String(err)}\n`)
  process.exit(0)
})
