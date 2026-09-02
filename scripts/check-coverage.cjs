#!/usr/bin/env node
/**
 * The seam rule's second half (ENGINEERING-STANDARDS §6, item 7 — M8.0): no
 * subsystem falls below the coverage floor it was measured at, and no
 * production module lands that no test reaches.
 *
 * ## Why a per-subsystem ratchet, and never a number
 *
 * TEST-STRATEGY §2 is right that overall line coverage "incentivizes junk
 * tests", and a single threshold is the classic check that cannot fail: it
 * rises while the wiring stays untested, because a thousand lines of new
 * validator tests hide two hundred lines of new boot wiring nobody drove. So
 * the record here is per SUBSYSTEM, and it is a ratchet — the floor is what
 * was last measured, it rises by re-measurement (`--update`), and it falls only
 * when a human edits `coverage-floors.json` with a reason in the diff.
 *
 * ## Why the condition is recorded beside the figure, once
 *
 * The 2026-09-02 timeout-margin episode produced six measurements of one
 * number, four wrong, because each was taken in a different condition and
 * quoted without it. Coverage has the same property: `process.platform`
 * branches, tests gated to one OS, and timing-dependent paths all move the
 * figure between machines. So floors are recorded PER PLATFORM with the
 * commit, node version and command they were measured under, and a run on a
 * platform with no recorded floor FAILS — it cannot say "no regression" when
 * it has nothing to compare against (the probe rule: could-not-establish must
 * fail, not pass).
 *
 * ## The subsystem map is total on purpose
 *
 * Every file in the coverage report must belong to exactly one subsystem. A
 * new file that belongs to none fails the check, so adding a module forces a
 * decision about what it is part of; a member that no longer matches a file
 * fails too, so the map cannot describe a tree that has moved on.
 *
 * ## What "untested" means here
 *
 * A production file with lines to cover, none of them covered, and no
 * function entered: no test reaches it at all. That is the coverage-side
 * shape of the M6 Herald defect (which `reachability.cjs` catches from the
 * application's side). Known cases are listed per platform; `--update` removes
 * a file the moment a test reaches it and NEVER adds one — a new untested
 * module is added by hand, which is the review point.
 *
 * Contract: `run(options)` never throws on a fault it can name. It returns the
 * exit code, the failure lines, the rendered table and the measurement, so a
 * test can drive it without a process. Reads the report, the floors file and
 * `.git/HEAD`; writes only the floors file (with `--update`) and the emitted
 * measurement (with `--emit`).
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const DEFAULT_SUMMARY = path.join('coverage', 'coverage-summary.json')
const DEFAULT_FLOORS = path.join('scripts', 'coverage-floors.json')
const SCHEMA_VERSION = 1
const METRICS = ['lines', 'branches', 'functions', 'statements']
const COMMAND = 'npm run test:coverage'

/** Path separators differ by platform; every path this module reports uses `/`. */
const slashed = (p) => p.split(path.sep).join('/')
const round2 = (n) => Math.round(n * 100) / 100
const pct = (covered, total) => (total === 0 ? 100 : round2((covered / total) * 100))

function walk(dir, keep, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, keep, out)
    else if (keep(entry.name)) out.push(full)
  }
  return out
}

/**
 * Contract: every production file the map must account for, root-relative and
 * sorted — the same set `vitest.config.mts`'s `coverage.include` names
 * (`src/**\/*.{ts,tsx}` less declarations, `shims/**\/*.mjs`). The two lists are
 * kept in step by hand; a file in one and not the other surfaces as either an
 * unassigned report entry or an unassigned disk file, and fails.
 */
function productionFiles(root) {
  const src = walk(
    path.join(root, 'src'),
    (name) => /\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)
  )
  const shims = walk(path.join(root, 'shims'), (name) => name.endsWith('.mjs'))
  return [...src, ...shims].map((file) => slashed(path.relative(root, file))).sort()
}

/**
 * Contract: the short id of the commit HEAD points at, read from the git
 * directory without invoking git (ADR-0004's tripwire allows `git` in exactly
 * three files, and a CI stamp is not a reason to be a fourth). Understands a
 * worktree's `.git` FILE and packed refs. Returns 'unknown' rather than throwing.
 */
function headCommit(root) {
  try {
    let gitDir = path.join(root, '.git')
    if (fs.statSync(gitDir).isFile()) {
      const pointer = fs.readFileSync(gitDir, 'utf8').trim()
      const match = /^gitdir:\s*(.+)$/.exec(pointer)
      if (match === null) return 'unknown'
      gitDir = path.resolve(root, match[1])
    }
    let commonDir = gitDir
    const commonFile = path.join(gitDir, 'commondir')
    if (fs.existsSync(commonFile)) {
      commonDir = path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim())
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*(.+)$/.exec(head)
    if (ref === null) return head.slice(0, 7)
    const refFile = path.join(commonDir, ref[1])
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim().slice(0, 7)
    const packed = path.join(commonDir, 'packed-refs')
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
        const [sha, name] = line.trim().split(/\s+/)
        if (name === ref[1] && sha !== undefined) return sha.slice(0, 7)
      }
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Contract: each file assigned to the one subsystem whose member names it — an
 * exact file beats a directory prefix, a longer prefix beats a shorter one — plus
 * a failure per file nobody claims, per file two subsystems claim at the same
 * rank, and per member that names nothing in the report. Pure.
 */
function assignSubsystems(files, subsystems) {
  const assigned = new Map()
  const failures = []
  const hits = new Map()
  for (const [name, def] of Object.entries(subsystems)) {
    for (const member of def.members) hits.set(`${name} ${member}`, 0)
  }
  for (const file of files) {
    let best = null
    for (const [name, def] of Object.entries(subsystems)) {
      for (const member of def.members) {
        const isDir = member.endsWith('/')
        if (isDir ? !file.startsWith(member) : file !== member) continue
        const rank = isDir ? member.length : Number.POSITIVE_INFINITY
        if (best === null || rank > best.rank) best = { name, member, rank, ties: [] }
        else if (rank === best.rank && best.name !== name) best.ties.push({ name, member })
      }
    }
    if (best === null) {
      failures.push(
        `${file}  belongs to no subsystem in scripts/coverage-floors.json — the map is total on purpose; say which subsystem this module is part of`
      )
      continue
    }
    if (best.ties.length > 0) {
      failures.push(
        `${file}  is claimed by more than one subsystem at the same rank (${[best.name, ...best.ties.map((t) => t.name)].join(', ')}) — fix the map`
      )
    }
    assigned.set(file, best.name)
    // Every tied member scored a hit: the duplicate claim is the fault, and it is
    // reported once above rather than again as a member that "names nothing".
    for (const { name, member } of [best, ...best.ties]) {
      hits.set(`${name} ${member}`, hits.get(`${name} ${member}`) + 1)
    }
  }
  for (const [key, count] of hits) {
    if (count > 0) continue
    const space = key.indexOf(' ')
    failures.push(
      `subsystem ${key.slice(0, space)}: member '${key.slice(space + 1)}' names nothing in the coverage report — moved, deleted or shadowed; fix the map so it describes the tree`
    )
  }
  return { assigned, failures }
}

const isUntested = (data) =>
  data.lines.total > 0 && data.lines.covered === 0 && data.functions.covered === 0

/**
 * Contract: the per-subsystem measurement of one coverage-summary report —
 * percentages per metric, the files no test reaches, which subsystem each file
 * belongs to, and the lowest-covered files of each subsystem (for the failure
 * message). The map is checked for totality over the report AND `diskFiles`
 * together: a type-only module produces no report entry, and it still has to
 * belong somewhere. Pure.
 */
function measure(summary, root, subsystems, diskFiles = []) {
  const files = Object.entries(summary)
    .filter(([key]) => key !== 'total')
    .map(([key, data]) => ({
      rel: slashed(path.isAbsolute(key) ? path.relative(root, key) : key),
      data
    }))
  const everyFile = [...new Set([...files.map((f) => f.rel), ...diskFiles])].sort()
  const { assigned, failures } = assignSubsystems(everyFile, subsystems)
  const per = {}
  for (const name of Object.keys(subsystems)) {
    per[name] = { files: [], untested: [], covered: {}, total: {} }
    for (const metric of METRICS) {
      per[name].covered[metric] = 0
      per[name].total[metric] = 0
    }
  }
  for (const file of files) {
    const name = assigned.get(file.rel)
    if (name === undefined) continue
    const slot = per[name]
    // Older istanbul summaries print 'Unknown' for 0/0; the arithmetic below never does.
    slot.files.push({ rel: file.rel, lines: pct(file.data.lines.covered, file.data.lines.total) })
    for (const metric of METRICS) {
      slot.covered[metric] += file.data[metric].covered
      slot.total[metric] += file.data[metric].total
    }
    if (isUntested(file.data)) slot.untested.push(file.rel)
  }
  const floors = {}
  const untested = []
  const lowest = {}
  const grand = { covered: {}, total: {} }
  for (const metric of METRICS) {
    grand.covered[metric] = 0
    grand.total[metric] = 0
  }
  for (const [name, slot] of Object.entries(per)) {
    floors[name] = {}
    for (const metric of METRICS) {
      floors[name][metric] = pct(slot.covered[metric], slot.total[metric])
      grand.covered[metric] += slot.covered[metric]
      grand.total[metric] += slot.total[metric]
    }
    floors[name].files = slot.files.length
    untested.push(...slot.untested)
    lowest[name] = slot.files
      .slice()
      .sort((a, b) => a.lines - b.lines)
      .slice(0, 3)
      .map((f) => `${f.rel} ${String(f.lines)}%`)
  }
  const total = {}
  for (const metric of METRICS) total[metric] = pct(grand.covered[metric], grand.total[metric])
  return {
    failures,
    floors,
    untested: untested.sort(),
    lowest,
    total,
    subsystemOf: Object.fromEntries(assigned)
  }
}

/**
 * Contract: what a measurement says against one platform's recorded floors,
 * in three lists that fail — subsystems with no floor, floors regressed past
 * the tolerance, production modules no test reaches that the record does not
 * know — and one that does not (notes: things `--update` would ratchet). Pure.
 */
function compare(measurement, block, tolerance, platform) {
  const missing = []
  const regressions = []
  const newUntested = []
  const notes = []
  for (const [name, measured] of Object.entries(measurement.floors)) {
    const floor = block.floors[name]
    if (floor === undefined) {
      missing.push(
        `subsystem ${name}: no floor recorded for platform ${platform} — a new subsystem is measured before it is gated; run \`node scripts/check-coverage.cjs --update\` on ${platform} and commit the file`
      )
      continue
    }
    for (const metric of METRICS) {
      const have = measured[metric]
      const want = floor[metric]
      if (have < want - tolerance) {
        regressions.push(
          `subsystem ${name}: ${metric} ${String(have)}% is below its ${platform} floor of ${String(want)}% (tolerance ${String(tolerance)}) — lowest files: ${measurement.lowest[name].join(', ')}`
        )
      } else if (have > want) {
        notes.push(
          `subsystem ${name}: ${metric} ${String(have)}% is above its floor of ${String(want)}% — --update ratchets it`
        )
      }
    }
  }
  const known = new Set(block.untested)
  for (const file of measurement.untested) {
    if (known.has(file)) continue
    newUntested.push(
      `${file}  no test reaches this production module (subsystem ${measurement.subsystemOf[file]}) — the seam rule (ENGINEERING-STANDARDS §6.7): write the test, or record the decision by adding it to platforms.${platform}.untested in scripts/coverage-floors.json`
    )
  }
  const now = new Set(measurement.untested)
  for (const file of block.untested) {
    if (!now.has(file)) notes.push(`now tested: ${file} — --update removes it from the record`)
  }
  return { missing, regressions, newUntested, notes }
}

/**
 * Contract: the floors document after one measurement is folded in. Floors
 * only rise; a platform with no block is seeded (floors AND untested list); an
 * existing block loses the untested entries a test now reaches and gains none.
 * Returns the changes made and the regressions it refused to hide. Pure.
 */
function ratchet(doc, platform, measurement, condition) {
  const changes = []
  const regressions = []
  const next = { ...doc, platforms: { ...doc.platforms } }
  const existing = doc.platforms[platform]
  if (existing === undefined) {
    next.platforms[platform] = {
      measured: condition,
      floors: measurement.floors,
      untested: measurement.untested
    }
    changes.push(
      `seeded platform ${platform}: ${String(Object.keys(measurement.floors).length)} subsystems, ${String(measurement.untested.length)} untested modules recorded`
    )
    return { doc: next, changes, regressions }
  }
  const floors = {}
  for (const [name, measured] of Object.entries(measurement.floors)) {
    const old = existing.floors[name]
    floors[name] = { ...measured }
    if (old === undefined) {
      changes.push(`subsystem ${name}: recorded on ${platform} for the first time`)
      continue
    }
    for (const metric of METRICS) {
      if (measured[metric] > old[metric]) {
        changes.push(
          `subsystem ${name}: ${metric} ${String(old[metric])}% → ${String(measured[metric])}%`
        )
      } else if (measured[metric] < old[metric] - doc.tolerance) {
        regressions.push(
          `subsystem ${name}: ${metric} ${String(measured[metric])}% is below its floor of ${String(old[metric])}% — --update never lowers a floor; fix the regression or edit the file with a reason`
        )
        floors[name][metric] = old[metric]
      } else if (measured[metric] < old[metric]) {
        floors[name][metric] = old[metric]
      }
    }
  }
  const now = new Set(measurement.untested)
  const untested = existing.untested.filter((file) => now.has(file))
  for (const file of existing.untested) {
    if (!now.has(file)) changes.push(`now tested: ${file}`)
  }
  next.platforms[platform] = { measured: condition, floors, untested }
  return { doc: next, changes, regressions }
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function validateFloors(doc) {
  if (typeof doc !== 'object' || doc === null) return 'not an object'
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    return `schemaVersion ${String(doc.schemaVersion)} (expected ${String(SCHEMA_VERSION)})`
  }
  if (typeof doc.tolerance !== 'number' || doc.tolerance < 0 || doc.tolerance > 5) {
    return 'tolerance must be a number of percentage points between 0 and 5'
  }
  if (typeof doc.subsystems !== 'object' || doc.subsystems === null) return 'subsystems missing'
  for (const [name, def] of Object.entries(doc.subsystems)) {
    if (!Array.isArray(def.members) || def.members.length === 0) {
      return `subsystem ${name} has no members`
    }
    for (const member of def.members) {
      if (typeof member !== 'string' || member.includes('\\')) {
        return `subsystem ${name}: member ${JSON.stringify(member)} must be a /-separated path`
      }
    }
  }
  if (typeof doc.platforms !== 'object' || doc.platforms === null) return 'platforms missing'
  for (const [platform, block] of Object.entries(doc.platforms)) {
    if (typeof block.floors !== 'object' || !Array.isArray(block.untested) || !block.measured) {
      return `platform ${platform} block is incomplete (needs measured, floors, untested)`
    }
  }
  return null
}

function renderTable(measurement, block, tolerance) {
  const rows = [
    ['subsystem', 'files', 'lines', 'branch', 'funcs', 'stmts', 'untested', 'floor(lines)']
  ]
  for (const [name, f] of Object.entries(measurement.floors)) {
    const floor = block === undefined ? undefined : block.floors[name]
    const untested = measurement.untested.filter(
      (file) => measurement.subsystemOf[file] === name
    ).length
    rows.push([
      name,
      String(f.files),
      String(f.lines),
      String(f.branches),
      String(f.functions),
      String(f.statements),
      String(untested),
      floor === undefined
        ? '—'
        : `${String(floor.lines)}${f.lines < floor.lines - tolerance ? ' ✗' : ''}`
    ])
  }
  rows.push([
    'TOTAL',
    String(Object.values(measurement.floors).reduce((n, f) => n + f.files, 0)),
    String(measurement.total.lines),
    String(measurement.total.branches),
    String(measurement.total.functions),
    String(measurement.total.statements),
    String(measurement.untested.length),
    ''
  ])
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)))
  return rows
    .map((r) =>
      r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ')
    )
    .join('\n')
}

function parseArgs(argv) {
  const options = {
    update: false,
    from: null,
    emit: null,
    summary: null,
    floors: null,
    platform: null
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--update') options.update = true
    else if (arg === '--from') options.from = argv[++i] ?? null
    else if (arg === '--emit') options.emit = argv[++i] ?? null
    else if (arg === '--summary') options.summary = argv[++i] ?? null
    else if (arg === '--floors') options.floors = argv[++i] ?? null
    else if (arg === '--platform') options.platform = argv[++i] ?? null
    else return { error: `unknown argument: ${arg}` }
  }
  return options
}

/**
 * Contract: see the header. `options.root` defaults to the repository; every
 * path option is resolved against it. Returns `{ exitCode, failures, notes,
 * table, measurement, changes }`.
 */
function run(options = {}) {
  const root = options.root ?? ROOT
  const platform = options.platform ?? process.platform
  const floorsPath = path.resolve(root, options.floors ?? DEFAULT_FLOORS)
  const summaryPath = path.resolve(root, options.summary ?? DEFAULT_SUMMARY)
  const out = { exitCode: 0, failures: [], notes: [], table: '', measurement: null, changes: [] }
  const fail = (line) => {
    out.failures.push(line)
    out.exitCode = 1
    return out
  }

  let doc
  try {
    doc = loadJson(floorsPath)
  } catch (err) {
    return fail(
      `coverage floors could not be read from ${slashed(path.relative(root, floorsPath))}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const shape = validateFloors(doc)
  if (shape !== null)
    return fail(`scripts/coverage-floors.json is not a valid floors record: ${shape}`)

  let measurement
  let condition
  if (options.from !== null && options.from !== undefined) {
    let emitted
    try {
      emitted = loadJson(path.resolve(root, options.from))
    } catch (err) {
      return fail(
        `emitted measurement could not be read: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (emitted.platform !== platform) {
      return fail(
        `emitted measurement is for platform ${String(emitted.platform)}, not ${platform} — pass --platform ${String(emitted.platform)} to record it`
      )
    }
    measurement = emitted.measurement
    condition = emitted.measured
  } else {
    let summary
    try {
      summary = loadJson(summaryPath)
    } catch (err) {
      return fail(
        `coverage could not be established: no report at ${slashed(path.relative(root, summaryPath))} (${err instanceof Error ? err.message : String(err)}) — run \`${COMMAND}\` first`
      )
    }
    measurement = measure(summary, root, doc.subsystems, productionFiles(root))
    condition = {
      at: new Date().toISOString(),
      commit: headCommit(root),
      platform,
      node: process.version,
      os: `${os.type()} ${os.release()}`,
      command: COMMAND
    }
  }
  out.measurement = measurement
  for (const failure of measurement.failures) fail(failure)

  if (options.emit !== null && options.emit !== undefined) {
    const emitPath = path.resolve(root, options.emit)
    fs.mkdirSync(path.dirname(emitPath), { recursive: true })
    fs.writeFileSync(
      emitPath,
      `${JSON.stringify({ platform, measured: condition, measurement }, null, 2)}\n`
    )
    out.notes.push(`measurement written to ${slashed(path.relative(root, emitPath))}`)
  }

  const block = doc.platforms[platform]
  out.table = renderTable(measurement, block, doc.tolerance)

  if (options.update) {
    // A broken map is not ratcheted over: the numbers would be about the wrong tree.
    if (measurement.failures.length > 0) return out
    const { doc: next, changes, regressions } = ratchet(doc, platform, measurement, condition)
    for (const regression of regressions) fail(regression)
    out.changes = changes
    fs.writeFileSync(floorsPath, `${JSON.stringify(next, null, 2)}\n`)
    // What --update never does is add an untested module to the record, so a
    // new one is still a failure here — the file was written, the gap was not hidden.
    const after = compare(measurement, next.platforms[platform], doc.tolerance, platform)
    for (const failure of after.newUntested) fail(failure)
    return out
  }

  if (block === undefined) {
    return fail(
      `no coverage floors are recorded for platform ${platform} — nothing to compare against, so this run cannot claim "no regression"; run \`node scripts/check-coverage.cjs --update\` on ${platform} (or --update --from <emitted.json> --platform ${platform}) and commit scripts/coverage-floors.json`
    )
  }
  const { missing, regressions, newUntested, notes } = compare(
    measurement,
    block,
    doc.tolerance,
    platform
  )
  for (const failure of [...missing, ...regressions, ...newUntested]) fail(failure)
  out.notes.push(...notes)
  return out
}

/** @returns {number} the process exit code, so a test can call this without exiting. */
function main(argv) {
  const options = parseArgs(argv.slice(2))
  if (options.error !== undefined) {
    console.error(options.error)
    console.error(
      'usage: node scripts/check-coverage.cjs [--update] [--from <emitted.json>] [--emit <path>] [--summary <path>] [--floors <path>] [--platform <name>]'
    )
    return 2
  }
  const result = run(options)
  if (result.table !== '') console.log(`${result.table}\n`)
  for (const change of result.changes) console.log(`  ratchet: ${change}`)
  for (const note of result.notes) console.log(`  note: ${note}`)
  if (result.failures.length > 0) {
    console.error('\nCoverage floor failures (the seam rule, ENGINEERING-STANDARDS §6.7):\n')
    for (const failure of result.failures) console.error(`  ${failure}`)
    console.error('')
    return result.exitCode
  }
  console.log(
    `coverage floors ok (${String(Object.keys(result.measurement.floors).length)} subsystems on ${options.platform ?? process.platform}; ${String(result.measurement.untested.length)} untested modules, all recorded)`
  )
  return 0
}

if (require.main === module) process.exit(main(process.argv))

module.exports = {
  SCHEMA_VERSION,
  METRICS,
  headCommit,
  productionFiles,
  assignSubsystems,
  measure,
  compare,
  ratchet,
  validateFloors,
  renderTable,
  parseArgs,
  run,
  main
}
