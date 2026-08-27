#!/usr/bin/env node
// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * A scripted stand-in for the real `mempalace` CLI (MemPalace 3.x), built the
 * way `fake-engine` stands in for a real engine: a real spawnable program that
 * speaks the real command surface and prints the real output shapes.
 *
 * It exists because ADR-0016 makes MemPalace an *optional* external — CI has no
 * Python and must never grow one — while the driver's behaviour (probe, mine,
 * scoped search, degradation) still has to be tested against a real subprocess
 * rather than a stub function.
 *
 * The surface it mirrors, verbatim from `mempalace --help` at 3.8.0:
 *   mempalace --version
 *   mempalace --palace <dir> mine <dir> --wing <w> --agent <a> --limit <n>
 *   mempalace --palace <dir> search <query> [--wing <w>] [--results <n>]
 *   mempalace --palace <dir> sync
 *
 * Behaviour is scripted through the environment, so one binary covers every
 * case the ladder has to survive:
 *   EPH_FAKE_MP_MODE = ok (default) | no-version | crash | garbage | slow
 *   EPH_FAKE_MP_VERSION = the version string to print (default 3.8.0)
 *   EPH_FAKE_MP_LOG = a file every invocation's argv is appended to, so a test
 *                     can assert that no daemon flag was ever passed.
 */

const MODE = process.env['EPH_FAKE_MP_MODE'] ?? 'ok'
const VERSION = process.env['EPH_FAKE_MP_VERSION'] ?? '3.8.0'
const LOG = process.env['EPH_FAKE_MP_LOG'] ?? ''

const argv = process.argv.slice(2)

if (LOG) {
  fs.appendFileSync(
    LOG,
    `${JSON.stringify({
      argv,
      autoSave: process.env['MEMPALACE_HOOKS_AUTO_SAVE'] ?? null,
      daemon: process.env['MEMPALACE_HOOKS_DAEMON'] ?? null
    })}\n`
  )
}

if (MODE === 'crash') {
  process.stderr.write('fake-mempalace: exploded\n')
  process.exit(3)
}

/** @param {string} name @returns {string | null} */
function flag(name) {
  const at = argv.indexOf(name)
  return at >= 0 ? (argv[at + 1] ?? null) : null
}

if (argv.includes('--version')) {
  if (MODE === 'no-version') {
    process.stdout.write('some other tool entirely\n')
    process.exit(0)
  }
  process.stdout.write(`MemPalace ${VERSION}\n`)
  process.exit(0)
}

const palaceFlag = flag('--palace')
if (!palaceFlag) {
  process.stderr.write('fake-mempalace: --palace is required\n')
  process.exit(2)
}
const palace = String(palaceFlag)
const storePath = path.join(palace, 'drawers.json')

/** @returns {Array<{wing: string, room: string, source: string, text: string}>} */
function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8'))
  } catch {
    return []
  }
}

/** @param {Array<{wing: string, room: string, source: string, text: string}>} drawers */
function writeStore(drawers) {
  fs.mkdirSync(palace, { recursive: true })
  fs.writeFileSync(storePath, JSON.stringify(drawers, null, 2))
}

const subcommand = argv.find((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--palace')

if (subcommand === 'mine') {
  const dir = argv[argv.indexOf('mine') + 1]
  const wing = flag('--wing') ?? path.basename(String(dir))
  const drawers = readStore().filter((d) => d.wing !== wing)
  let filed = 0
  /** @param {string} root */
  const walk = (root) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(root, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md')) {
        drawers.push({
          wing,
          room: 'general',
          source: path.relative(String(dir), full),
          text: fs.readFileSync(full, 'utf8')
        })
        filed += 1
      }
    }
  }
  walk(String(dir))
  writeStore(drawers)
  process.stdout.write(
    `  Done.\n  Files processed: ${String(filed)}\n  Drawers filed: ${String(filed)}\n`
  )
  process.exit(0)
}

if (subcommand === 'sync') {
  const drawers = readStore()
  writeStore(drawers)
  process.stdout.write(`  Pruned 0 drawers.\n`)
  process.exit(0)
}

if (subcommand === 'search') {
  if (MODE === 'garbage') {
    process.stdout.write('this output is not a result list at all\n')
    process.exit(0)
  }
  const at = argv.indexOf('search')
  const query = argv[at + 1] ?? ''
  const wing = flag('--wing')
  const results = Number.parseInt(flag('--results') ?? '5', 10) || 5
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((t) => t.length > 1)

  const scored = readStore()
    .filter((drawer) => wing === null || drawer.wing === wing)
    .map((drawer) => {
      const haystack = drawer.text.toLowerCase()
      const hits = terms.filter((term) => haystack.includes(term)).length
      return { drawer, sim: terms.length === 0 ? 0 : hits / terms.length }
    })
    .filter((row) => row.sim > 0)
    .sort((a, b) => b.sim - a.sim || a.drawer.source.localeCompare(b.drawer.source))
    .slice(0, results)

  const out = []
  out.push('='.repeat(60))
  out.push(`  Results for: "${query}"`)
  if (wing) out.push(`  Wing: ${wing}`)
  out.push('='.repeat(60))
  out.push('')
  scored.forEach((row, i) => {
    out.push(`  [${String(i + 1)}] ${row.drawer.wing} / ${row.drawer.room}`)
    out.push(`      Source: ${row.drawer.source}`)
    out.push(`      Match:  cosine_sim=${row.sim.toFixed(3)}  bm25=${row.sim.toFixed(3)}`)
    out.push('')
    for (const line of row.drawer.text.split('\n')) out.push(`      ${line}`)
    out.push('')
    out.push(`  ${'-'.repeat(56)}`)
  })
  process.stdout.write(`${out.join('\n')}\n`)
  process.exit(0)
}

process.stderr.write(`fake-mempalace: unknown command ${String(subcommand)}\n`)
process.exit(2)
