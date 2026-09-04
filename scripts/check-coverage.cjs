#!/usr/bin/env node
/**
 * The seam rule's second half (ENGINEERING-STANDARDS §6, item 7 — M8.0): no
 * subsystem falls below the coverage floor it was measured at, and no
 * production module lands that no test enters.
 *
 * ## Why a per-subsystem ratchet, and never a number
 *
 * TEST-STRATEGY §2 is right that overall line coverage "incentivizes junk
 * tests", and a single threshold is the classic check that cannot fail: it
 * rises while the wiring stays untested, because a thousand lines of new
 * validator tests hide two hundred lines of new boot wiring nobody drove. So
 * the record here is per SUBSYSTEM, and it is a ratchet — the floor is what
 * was last measured, it rises by re-measurement (`--update`), and it falls only
 * when a human edits `coverage-floors.json` with a reason in the diff. A floor
 * that lags reality by more than the recorded margin fails too: a ratchet
 * nobody turns is a number, not a record.
 *
 * ## Why the condition is recorded beside the figure, once
 *
 * The 2026-09-02 timeout-margin episode produced six measurements of one
 * number, four wrong, because each was taken in a different condition and
 * quoted without it. Coverage has the same property: `process.platform`
 * branches, tests gated to one OS, and timing-dependent paths all move the
 * figure between machines. So floors are recorded PER PLATFORM with the
 * commit, the ref, a git-free hash of the production tree, node, OS and the
 * command they were measured under; a run on a platform with no recorded
 * floor FAILS — it cannot say "no regression" when it has nothing to compare
 * against (the probe rule: could-not-establish must fail, not pass); and the
 * first record on a platform is an explicit verb, `--seed`, so that
 * `--update` can never quietly start over.
 *
 * ## Why a raise needs more than one run, and takes the lowest of them
 *
 * A floor is a claim that the suite REPRODUCES a figure, and one run cannot
 * make that claim. On 2026-09-04 `--update` ratcheted `terraces.functions`
 * from 84.65% to 85.15% on a single win32 measurement and the gate then
 * refused a branch that had not touched the subsystem. The cause is in the
 * subsystem, not the arithmetic: `FloorCanvas.tsx` fires a floating
 * `void Promise.all([app.init(…), loadSheets(), loadCharacters()])` that no
 * test awaits, so how far that chain gets before the file tears down decides
 * how many of its 324 lines were entered — 103, 113 and higher have all been
 * measured on the SAME production tree.
 *
 * So a raise is corroborated. Every measurement folds into a `candidate`
 * window kept per platform — the last `corroboratingRuns` runs, each with the
 * condition it was taken in, the identity of the report it read, and the
 * figures it measured. A floor rises only once that window is full, and only
 * to the window's metric-wise MINIMUM — never to what the newest run happened
 * to see. The window SLIDES rather than accumulating, because the tree hash
 * covers production files only: adding tests raises coverage without changing
 * it, and an all-time minimum per tree could never record that gain. It
 * restarts when the tree or the subsystem map changes, which are the two ways
 * of becoming a measurement of something else.
 *
 * Two runs agreeing was rejected as the rule, by measurement rather than by
 * taste: the pair the record calls corroborated (84.65 twice) is itself 0.49
 * points above what two later runs both read (84.16 twice, matching the linux
 * record exactly). Runs taken back to back share a machine's mood, so
 * agreement between them is not independence, and the minimum of more of them
 * is the only thing that gets monotonically closer to the truth. What this
 * CANNOT do is make correlated samples independent — three optimistic runs in
 * one session still raise a floor too far. It makes the ratchet strictly more
 * conservative than a single run, and it writes down the spread it saw.
 *
 * Only the RAISE path is corroborated. A regression past the tolerance fails
 * on the run that measured it, with no window and no second opinion: a gate
 * that waited for corroboration before failing would be a gate that lets the
 * first regression through.
 *
 * ## The map is total, and the report must be the tree
 *
 * Every production file belongs to exactly one subsystem: a file that belongs
 * nowhere fails, a member that names nothing fails. And the report and the
 * tree must agree in BOTH directions — a report entry with no file behind it,
 * or a file the report never saw, is a report about some other tree, and a
 * report older than the newest production file is refused before it can be
 * recorded. Nothing here can be fooled by a stale `coverage/` directory.
 *
 * ## What "untested" means here
 *
 * A production file none of whose functions any test enters — or, for a file
 * with no functions, none of whose lines any test runs. The first draft asked
 * only about lines, and a bare `import` of a module marks its top-level lines
 * covered, which let `src/main/config.ts` (one line of ten, no function ever
 * entered) pass as tested. That is the coverage-side shape of the M6 Herald
 * defect, which `reachability.cjs` catches from the application's side. Known
 * cases are listed per platform; `--update` removes a file the moment a test
 * enters it and NEVER adds one — a new untested module is added by hand, which
 * is the review point.
 *
 * Contract: `run(options)` never throws on a fault it can name. It returns the
 * exit code, the failure lines, the notes, the rendered table, the measurement
 * and the changes, so a test can drive it without a process. Reads the report,
 * the floors file, the production tree and `.git/HEAD`; writes only the floors
 * file (with `--update` or `--seed`, and only when something changed) and the
 * emitted measurement (with `--emit`).
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const DEFAULT_SUMMARY = path.join('coverage', 'coverage-summary.json')
const DEFAULT_FLOORS = path.join('scripts', 'coverage-floors.json')
const SCHEMA_VERSION = 3
const METRICS = ['lines', 'branches', 'functions', 'statements']
const COMMAND = 'npm run test:coverage'
/** A window wider than this is a policy nobody would run; see `corroboratingRuns`. */
const MAX_WINDOW_RUNS = 10
/** A source extension electron-vite would bundle that neither list below names. */
const SOURCE_LIKE = /\.(js|jsx|mjs|cjs|mts|cts)$/

/** Path separators differ by platform; every path this module reports uses `/`. */
const slashed = (p) => p.split(path.sep).join('/')
const round2 = (n) => Math.round(n * 100) / 100
const pct = (covered, total) => (total === 0 ? 100 : round2((covered / total) * 100))
const isPct = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100

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
 * kept in step by hand; `unexpectedSources` fails on anything under `src/`
 * that would be bundled but that neither list would ever see.
 */
function productionFiles(root) {
  const src = walk(
    path.join(root, 'src'),
    (name) => /\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)
  )
  const shims = walk(path.join(root, 'shims'), (name) => name.endsWith('.mjs'))
  return [...src, ...shims].map((file) => slashed(path.relative(root, file))).sort()
}

/** Contract: `src/**` files with a source-like extension neither list covers. Sorted. */
function unexpectedSources(root) {
  return walk(path.join(root, 'src'), (name) => SOURCE_LIKE.test(name))
    .map((file) => slashed(path.relative(root, file)))
    .sort()
}

/**
 * Contract: a short, git-free fingerprint of the production tree — sha256 over
 * every production file's path and bytes, in sorted order — so a recorded
 * condition can be checked against a checkout without trusting `.git/HEAD`,
 * which knows nothing about a dirty working tree.
 */
function treeHash(root) {
  const hash = crypto.createHash('sha256')
  for (const rel of productionFiles(root)) {
    hash.update(rel)
    hash.update('\0')
    hash.update(fs.readFileSync(path.join(root, rel)))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

/** Contract: the newest production file's mtime and name, or null for an empty tree. */
function newestSource(root) {
  let newest = null
  for (const rel of productionFiles(root)) {
    const mtimeMs = fs.statSync(path.join(root, rel)).mtimeMs
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { rel, mtimeMs }
  }
  return newest
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
 * Contract: the condition a measurement was taken under. `ref` is the CI ref
 * name when there is one (a pull_request run measures a synthetic merge
 * commit, and the record should say so) and `local` otherwise.
 */
function measuredCondition(root, platform) {
  return {
    at: new Date().toISOString(),
    commit: headCommit(root),
    ref: process.env.GITHUB_REF_NAME ?? 'local',
    tree: treeHash(root),
    platform,
    node: process.version,
    os: `${os.type()} ${os.release()}`,
    command: COMMAND
  }
}

/**
 * Contract: each file assigned to the one subsystem whose member names it — an
 * exact file beats a directory prefix, a longer prefix beats a shorter one — plus
 * a failure per file nobody claims, per file two subsystems claim at the same
 * rank, and per member that names nothing. Pure.
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
      `subsystem ${key.slice(0, space)}: member '${key.slice(space + 1)}' names nothing in the tree or the report — moved, deleted or shadowed; fix the map so it describes the tree`
    )
  }
  return { assigned, failures }
}

/** See the header: no function entered, or (with none to enter) no line run. */
const isUntested = (data) =>
  (data.functions.total > 0 && data.functions.covered === 0) ||
  (data.lines.total > 0 && data.lines.covered === 0 && data.functions.covered === 0)

/**
 * Contract: the per-subsystem measurement of one coverage-summary report —
 * percentages per metric, the files no test enters, which subsystem each file
 * belongs to, the lowest-covered files of each subsystem (for the failure
 * message), and the per-file counts (so an emitted measurement can be
 * re-read under a later rule). The map is checked for totality over the
 * report AND `diskFiles` together, and the two are required to be the same
 * set. Pure.
 */
function measure(summary, root, subsystems, diskFiles = []) {
  const reportFiles = Object.entries(summary)
    .filter(([key]) => key !== 'total')
    .map(([key, data]) => ({
      rel: slashed(path.isAbsolute(key) ? path.relative(root, key) : key),
      data
    }))
  const reportSet = new Set(reportFiles.map((f) => f.rel))
  const diskSet = new Set(diskFiles)
  const everyFile = [...new Set([...reportSet, ...diskSet])].sort()
  const { assigned, failures } = assignSubsystems(everyFile, subsystems)
  if (diskFiles.length > 0) {
    for (const file of everyFile) {
      if (!diskSet.has(file)) {
        failures.push(
          `${file}  is in the coverage report but not on disk — the report describes a tree that has moved on; run \`${COMMAND}\` again`
        )
      } else if (!reportSet.has(file)) {
        failures.push(
          `${file}  is on disk but absent from the coverage report — vitest's coverage.include and productionFiles() disagree, or the report is stale; run \`${COMMAND}\` again`
        )
      }
    }
  }
  const per = {}
  for (const name of Object.keys(subsystems)) {
    per[name] = { files: [], untested: [], covered: {}, total: {} }
    for (const metric of METRICS) {
      per[name].covered[metric] = 0
      per[name].total[metric] = 0
    }
  }
  const files = {}
  for (const file of reportFiles) {
    const name = assigned.get(file.rel)
    if (name === undefined) continue
    const slot = per[name]
    // Older istanbul summaries print 'Unknown' for 0/0; the arithmetic below never does.
    slot.files.push({ rel: file.rel, lines: pct(file.data.lines.covered, file.data.lines.total) })
    files[file.rel] = {}
    for (const metric of METRICS) {
      slot.covered[metric] += file.data[metric].covered
      slot.total[metric] += file.data[metric].total
      files[file.rel][metric] = {
        covered: file.data[metric].covered,
        total: file.data[metric].total
      }
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
    subsystemOf: Object.fromEntries(assigned),
    files,
    reportFiles: [...reportSet].sort()
  }
}

/**
 * Contract: what a measurement says against one platform's recorded floors,
 * in four lists that fail — subsystems or metrics with no numeric floor,
 * floors regressed past the tolerance, floors more than the recorded margin
 * BELOW reality (the ratchet nobody turned), production modules no test enters
 * that the record does not know — and one that does not (notes). Comparisons
 * are made on rounded values so a figure exactly at the edge is not a
 * floating-point regression. Pure.
 */
function compare(measurement, block, doc, platform) {
  const missing = []
  const regressions = []
  const stale = []
  const newUntested = []
  const notes = []
  const tolerance = doc.tolerance
  const lag = doc.ratchetLag
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
      if (!isPct(want)) {
        missing.push(
          `subsystem ${name}: no numeric ${metric} floor recorded for platform ${platform} — a missing key is not "no floor", it is a record that cannot be compared; restore it`
        )
        continue
      }
      if (round2(have) < round2(want - tolerance)) {
        regressions.push(
          `subsystem ${name}: ${metric} ${String(have)}% is below its ${platform} floor of ${String(want)}% (tolerance ${String(tolerance)}) — lowest files: ${measurement.lowest[name].join(', ')}`
        )
      } else if (round2(have - want) > lag) {
        stale.push(
          `subsystem ${name}: ${metric} ${String(have)}% is more than ${String(lag)} points above its ${platform} floor of ${String(want)}% — the record is stale; ratchet it (\`--update\`, or \`--update --from\` the CI artifact) and commit, remembering that a raise takes ${String(doc.corroboratingRuns)} runs of the same tree and rises only to their lowest`
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
      `${file}  no test enters this production module (subsystem ${measurement.subsystemOf[file]}) — the seam rule (ENGINEERING-STANDARDS §6.7): write the test, or record the decision by adding it to platforms.${platform}.untested in scripts/coverage-floors.json`
    )
  }
  const now = new Set(measurement.untested)
  const inReport = new Set(measurement.reportFiles)
  for (const file of block.untested) {
    if (now.has(file)) continue
    notes.push(
      inReport.has(file)
        ? `now tested: ${file} — --update removes it from the record`
        : `gone from the tree: ${file} — --update removes it from the record`
    )
  }
  return { missing, regressions, stale, newUntested, notes }
}

/**
 * Contract: the corroboration window after one measurement is folded in —
 * `{ tree, runs, floors }`, where `floors` is the ELEMENTWISE MINIMUM of the
 * metrics measured by exactly the runs in `runs`, newest last. A run is
 * identified by the coverage report it read (`run.report`), so offering the
 * same report twice adds nothing: two `--update` calls over one coverage run
 * are one measurement however many times they are made.
 *
 * The window restarts — rather than accumulating a minimum over things that
 * were never comparable — when the production tree changes, and when the
 * subsystem map changes (the map lives in this file, not in the tree, so it
 * can move under an unchanged hash). It does not restart on length: a full
 * window SLIDES, keeping the newest `keep` runs, because a floor that could
 * only rise on a window that had just been emptied would rise almost never.
 */
function foldCandidate(existing, measurement, run, keep, mapHash) {
  const entry = { ...run, floors: metricsOnly(measurement.floors) }
  const fresh = () => ({ tree: run.tree, map: mapHash, runs: [entry] })
  if (typeof existing !== 'object' || existing === null) return fresh()
  if (existing.tree !== run.tree) return fresh()
  // The map lives in this file, not in the tree, so it can move under an
  // unchanged hash; a minimum across two maps is a minimum across two subjects.
  // Compared by MEMBERSHIP, not by the set of names: moving a directory from
  // one subsystem to another leaves both names standing and changes what every
  // figure under them means.
  if (existing.map !== mapHash) return fresh()
  if (!Array.isArray(existing.runs) || existing.runs.length === 0) return fresh()
  if (existing.runs.some((r) => r.report === run.report)) return existing
  return { tree: run.tree, map: mapHash, runs: [...existing.runs, entry].slice(-keep) }
}

/**
 * Contract: a fingerprint of the subsystem MAP — every name and the members
 * under it. Pure.
 *
 * The name set is not the map. Moving `src/renderer/src/floor/` from
 * `terraces` to `panels` leaves both names in place and changes what every
 * figure under them means, and a minimum taken across that move is a minimum
 * across two different subjects. The first version of this guard compared
 * `Object.keys(...)` and would have folded straight through it.
 */
function subsystemMapHash(subsystems) {
  // JSON rather than a delimiter: it escapes for us, so no member string can
  // ever forge a boundary and make two different maps hash the same.
  const shape = Object.keys(subsystems ?? {})
    .sort()
    .map((name) => [name, [...(subsystems[name]?.members ?? [])].sort()])
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 12)
}

/** Contract: each subsystem's four metrics, without the descriptive file count. Pure. */
function metricsOnly(floors) {
  const out = {}
  for (const [name, floor] of Object.entries(floors)) {
    out[name] = {}
    for (const metric of METRICS) out[name][metric] = round2(floor[metric])
  }
  return out
}

/**
 * Contract: what the whole window reproduced — each subsystem's metric-wise
 * MINIMUM across every run in it, which is the most a floor may rise to. A
 * metric missing from any run is absent here rather than guessed. Pure.
 */
function windowFloors(candidate) {
  const out = {}
  const runs = candidate.runs
  for (const [name, floor] of Object.entries(runs[0].floors)) {
    out[name] = {}
    for (const metric of METRICS) {
      let low = floor[metric]
      for (const run of runs) {
        const seen = run.floors[name]?.[metric]
        if (!isPct(seen)) {
          low = undefined
          break
        }
        if (round2(seen) < round2(low)) low = seen
      }
      if (isPct(low)) out[name][metric] = round2(low)
    }
  }
  return out
}

/**
 * Contract: the floors document after one measurement is folded into an
 * EXISTING platform block. Floors only rise, and only as far as the
 * corroboration window supports (see `foldCandidate`); the untested list
 * loses what a test now enters or what is gone, and gains nothing; the
 * condition is re-stamped only when a FLOOR or the untested list changed, so
 * a refused update leaves the block byte-identical and a run that only
 * widens the window moves no stamp. Returns the changes made, the raises it
 * held back for want of corroboration, and the regressions it refused to
 * hide. Pure.
 */
function ratchet(doc, platform, measurement, condition, run) {
  const changes = []
  const held = []
  const regressions = []
  const existing = doc.platforms[platform]
  const candidate = foldCandidate(
    existing.candidate,
    measurement,
    run,
    doc.corroboratingRuns,
    subsystemMapHash(doc.subsystems)
  )
  const corroborated = candidate.runs.length >= doc.corroboratingRuns
  const supportedBy = windowFloors(candidate)
  const floors = {}
  for (const [name, measured] of Object.entries(measurement.floors)) {
    const old = existing.floors[name]
    floors[name] = { ...measured }
    if (old === undefined) {
      changes.push(`subsystem ${name}: recorded on ${platform} for the first time`)
      continue
    }
    for (const metric of METRICS) {
      // What the window as a whole reproduced, never what this run alone saw.
      const supported = supportedBy[name]?.[metric]
      if (!isPct(old[metric])) {
        changes.push(`subsystem ${name}: ${metric} floor restored (it had no numeric value)`)
        floors[name][metric] = isPct(supported) ? supported : measured[metric]
      } else if (round2(measured[metric]) > round2(old[metric])) {
        const rises = corroborated && isPct(supported) && round2(supported) > round2(old[metric])
        if (rises) {
          changes.push(
            `subsystem ${name}: ${metric} ${String(old[metric])}% → ${String(supported)}% (lowest of ${String(candidate.runs.length)} runs on tree ${candidate.tree})`
          )
          floors[name][metric] = supported
        } else {
          floors[name][metric] = old[metric]
          held.push(
            corroborated
              ? `subsystem ${name}: ${metric} measured ${String(measured[metric])}% but the lowest of ${String(candidate.runs.length)} runs on tree ${candidate.tree} is ${String(supported)}% — the floor stays at ${String(old[metric])}%, because a floor is what the suite reproduces`
              : `subsystem ${name}: ${metric} measured ${String(measured[metric])}% above its floor of ${String(old[metric])}%, and ${String(candidate.runs.length)} of ${String(doc.corroboratingRuns)} corroborating runs are recorded on tree ${candidate.tree} — run \`${COMMAND}\` and \`--update\` again without touching a production file`
          )
        }
      } else if (round2(measured[metric]) < round2(old[metric] - doc.tolerance)) {
        regressions.push(
          `subsystem ${name}: ${metric} ${String(measured[metric])}% is below its floor of ${String(old[metric])}% — --update never lowers a floor; fix the regression or edit the file with a reason`
        )
        floors[name][metric] = old[metric]
      } else {
        floors[name][metric] = old[metric]
      }
    }
    if (old.files !== measured.files && regressions.length === 0) {
      changes.push(`subsystem ${name}: ${String(old.files)} → ${String(measured.files)} files`)
    }
  }
  const now = new Set(measurement.untested)
  const inReport = new Set(measurement.reportFiles)
  const untested = existing.untested.filter((file) => now.has(file))
  for (const file of existing.untested) {
    if (now.has(file)) continue
    changes.push(inReport.has(file) ? `now tested: ${file}` : `gone from the tree: ${file}`)
  }
  const ratcheted = changes.length > 0
  // The window is evidence, so a run widening it is written even when no floor
  // moved — otherwise the run that corroborates the next raise is forgotten.
  // The STAMP still only moves for a floor or the untested list, so the
  // condition beside the figures never describes a run that did not set them.
  const changed = ratcheted || candidate !== existing.candidate
  const next = { ...doc, platforms: { ...doc.platforms } }
  next.platforms[platform] = {
    measured: ratcheted ? condition : existing.measured,
    candidate,
    floors,
    untested
  }
  return { doc: next, changes, held, regressions, changed, ratcheted }
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const isReason = (s) => typeof s === 'string' && s.trim().length >= 40
const CONDITION_KEYS = ['at', 'commit', 'ref', 'tree', 'platform', 'node', 'os', 'command']
/** A window's run is a condition plus the identity of the report it read. */
const RUN_KEYS = [...CONDITION_KEYS, 'report']

/**
 * Contract: null if this platform's corroboration window is absent (which is
 * legal — it is evidence a run accumulates, not a record a human seeds) or is
 * a window whose shape can be trusted, and otherwise the first fault in it.
 * A window that fails here is a hand edit that has to be read, so the message
 * names the platform.
 */
function validateCandidate(candidate, platform, keep) {
  if (candidate === undefined) return null
  const where = `platform ${platform} candidate`
  if (typeof candidate !== 'object' || candidate === null) return `${where} is not an object`
  if (typeof candidate.tree !== 'string' || candidate.tree.length === 0) {
    return `${where} has no tree — a window with no subject corroborates nothing`
  }
  if (!Array.isArray(candidate.runs) || candidate.runs.length === 0) {
    return `${where} has no runs`
  }
  if (candidate.runs.length > keep) {
    return `${where} holds ${String(candidate.runs.length)} runs, more than the ${String(keep)} a raise is measured over — the window slides, it does not collect`
  }
  const reports = new Set()
  for (const run of candidate.runs) {
    if (typeof run !== 'object' || run === null) return `${where}: a run is not an object`
    for (const key of RUN_KEYS) {
      if (typeof run[key] !== 'string' || run[key].length === 0) {
        return `${where}: a run lacks '${key}'`
      }
    }
    if (run.tree !== candidate.tree) {
      return `${where}: a run measured tree ${run.tree}, not the window's ${candidate.tree} — a minimum over different trees is a minimum over different subjects`
    }
    if (reports.has(run.report)) {
      return `${where}: two runs read the same report (${run.report}) — one coverage run offered twice is one measurement, however many times it is offered`
    }
    reports.add(run.report)
    if (typeof run.floors !== 'object' || run.floors === null) {
      return `${where}: the run of ${run.report} recorded no floors — a run with no figures corroborates nothing`
    }
    for (const [name, floor] of Object.entries(run.floors)) {
      for (const metric of METRICS) {
        if (!isPct(floor?.[metric])) {
          return `${where}: the run of ${run.report} lacks a numeric ${metric} for subsystem ${name}`
        }
      }
    }
  }
  return null
}

function validateFloors(doc) {
  if (typeof doc !== 'object' || doc === null) return 'not an object'
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    return `schemaVersion ${String(doc.schemaVersion)} (expected ${String(SCHEMA_VERSION)})`
  }
  if (typeof doc.tolerance !== 'number' || doc.tolerance < 0 || doc.tolerance > 1) {
    return 'tolerance must be a number of percentage points between 0 and 1'
  }
  if (!isReason(doc.toleranceReason)) {
    return 'toleranceReason must say how the tolerance was measured (at least 40 characters)'
  }
  if (typeof doc.ratchetLag !== 'number' || doc.ratchetLag < 0.5 || doc.ratchetLag > 10) {
    return 'ratchetLag must be a number of percentage points between 0.5 and 10'
  }
  if (!isReason(doc.ratchetLagReason)) {
    return 'ratchetLagReason must say why a floor may lag reality by that much (at least 40 characters)'
  }
  // Two is not a corroboration: the pair this rule was written for agreed with
  // each other and were still half a point above what the suite reproduces.
  if (!Number.isInteger(doc.corroboratingRuns) || doc.corroboratingRuns < 3) {
    return 'corroboratingRuns must be an integer of at least 3 — a floor one or two runs reached is not a floor the suite reproduces'
  }
  if (doc.corroboratingRuns > MAX_WINDOW_RUNS) {
    return `corroboratingRuns must be at most ${String(MAX_WINDOW_RUNS)}, the length at which a window restarts`
  }
  if (!isReason(doc.corroboratingRunsReason)) {
    return 'corroboratingRunsReason must say how that number was chosen (at least 40 characters)'
  }
  if (typeof doc.subsystems !== 'object' || doc.subsystems === null) return 'subsystems missing'
  const names = Object.keys(doc.subsystems)
  if (names.length === 0) return 'subsystems is empty'
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
    if (typeof block !== 'object' || block === null)
      return `platform ${platform} block is not an object`
    if (typeof block.measured !== 'object' || block.measured === null) {
      return `platform ${platform} block has no measured condition`
    }
    for (const key of CONDITION_KEYS) {
      if (typeof block.measured[key] !== 'string' || block.measured[key].length === 0) {
        return `platform ${platform} measured condition lacks '${key}'`
      }
    }
    if (typeof block.floors !== 'object' || block.floors === null) {
      return `platform ${platform} block has no floors`
    }
    for (const name of names) {
      const floor = block.floors[name]
      if (typeof floor !== 'object' || floor === null) {
        return `platform ${platform}: subsystem ${name} has no floor`
      }
      for (const metric of METRICS) {
        if (!isPct(floor[metric])) {
          return `platform ${platform}: subsystem ${name} lacks a numeric ${metric} floor`
        }
      }
      if (!Number.isInteger(floor.files) || floor.files < 0) {
        return `platform ${platform}: subsystem ${name} lacks an integer file count`
      }
    }
    for (const name of Object.keys(block.floors)) {
      if (!names.includes(name)) {
        return `platform ${platform}: floor for unknown subsystem ${name}`
      }
    }
    const candidateFault = validateCandidate(block.candidate, platform, doc.corroboratingRuns)
    if (candidateFault !== null) return candidateFault
    if (!Array.isArray(block.untested)) return `platform ${platform} block has no untested list`
    for (const file of block.untested) {
      if (typeof file !== 'string' || file.includes('\\')) {
        return `platform ${platform}: untested entry ${JSON.stringify(file)} must be a /-separated path`
      }
    }
  }
  return null
}

function validateEmitted(emitted, doc) {
  if (typeof emitted !== 'object' || emitted === null) return 'not an object'
  if (emitted.schemaVersion !== SCHEMA_VERSION) {
    return `schemaVersion ${String(emitted.schemaVersion)} (expected ${String(SCHEMA_VERSION)})`
  }
  if (typeof emitted.platform !== 'string') return 'platform missing'
  if (typeof emitted.measured !== 'object' || emitted.measured === null) return 'measured missing'
  for (const key of CONDITION_KEYS) {
    if (typeof emitted.measured[key] !== 'string') return `measured condition lacks '${key}'`
  }
  // The identity of the coverage report, not of this artifact: emitting the
  // same report twice must not buy a second corroborating run.
  if (typeof emitted.report !== 'string' || emitted.report.length === 0) {
    return "artifact lacks 'report', the identity of the coverage run behind it — re-emit it with a build of this script"
  }
  const m = emitted.measurement
  if (typeof m !== 'object' || m === null) return 'measurement missing'
  if (typeof m.floors !== 'object' || m.floors === null) return 'measurement.floors missing'
  const have = Object.keys(m.floors).sort()
  const want = Object.keys(doc.subsystems).sort()
  if (JSON.stringify(have) !== JSON.stringify(want)) {
    return `measurement covers subsystems [${have.join(', ')}] but the map has [${want.join(', ')}] — the artifact is from a different map; re-measure`
  }
  for (const name of want) {
    for (const metric of METRICS) {
      if (!isPct(m.floors[name][metric]))
        return `measurement.floors.${name}.${metric} is not a percentage`
    }
  }
  if (!Array.isArray(m.untested)) return 'measurement.untested missing'
  if (!Array.isArray(m.reportFiles)) return 'measurement.reportFiles missing'
  if (typeof m.lowest !== 'object' || m.lowest === null) return 'measurement.lowest missing'
  if (typeof m.subsystemOf !== 'object' || m.subsystemOf === null)
    return 'measurement.subsystemOf missing'
  if (typeof m.total !== 'object' || m.total === null) return 'measurement.total missing'
  for (const metric of METRICS) {
    if (!isPct(m.total[metric])) return `measurement.total.${metric} is not a percentage`
  }
  if (!Array.isArray(m.failures)) return 'measurement.failures missing'
  return null
}

function renderTable(measurement, block, doc) {
  const rows = [
    ['subsystem', 'files', 'lines', 'branch', 'funcs', 'stmts', 'untested', 'floor(lines)']
  ]
  for (const [name, f] of Object.entries(measurement.floors)) {
    const floor = block === undefined ? undefined : block.floors[name]
    const untested = measurement.untested.filter(
      (file) => measurement.subsystemOf[file] === name
    ).length
    let floorCell = '—'
    if (floor !== undefined && isPct(floor.lines)) {
      const mark =
        round2(f.lines) < round2(floor.lines - doc.tolerance)
          ? ' ✗'
          : round2(f.lines - floor.lines) > doc.ratchetLag
            ? ' ↑'
            : ''
      floorCell = `${String(floor.lines)}${mark}`
    }
    rows.push([
      name,
      String(f.files),
      String(f.lines),
      String(f.branches),
      String(f.functions),
      String(f.statements),
      String(untested),
      floorCell
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
    seed: false,
    from: null,
    emit: null,
    summary: null,
    floors: null,
    platform: null
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--update') options.update = true
    else if (arg === '--seed') options.seed = true
    else if (arg === '--from') options.from = argv[++i] ?? null
    else if (arg === '--emit') options.emit = argv[++i] ?? null
    else if (arg === '--summary') options.summary = argv[++i] ?? null
    else if (arg === '--floors') options.floors = argv[++i] ?? null
    else if (arg === '--platform') options.platform = argv[++i] ?? null
    else return { error: `unknown argument: ${arg}` }
  }
  if (options.update && options.seed)
    return { error: '--update and --seed are different verbs; pass one' }
  return options
}

function writeDoc(floorsPath, doc) {
  fs.writeFileSync(floorsPath, `${JSON.stringify(doc, null, 2)}\n`)
}

/**
 * Contract: see the header. `options.root` defaults to the repository; every
 * path option is resolved against it. Returns `{ exitCode, failures, notes,
 * table, measurement, changes, wrote }`.
 */
function run(options = {}) {
  const root = options.root ?? ROOT
  const platform = options.platform ?? process.platform
  const floorsPath = path.resolve(root, options.floors ?? DEFAULT_FLOORS)
  const summaryPath = path.resolve(root, options.summary ?? DEFAULT_SUMMARY)
  const out = {
    exitCode: 0,
    failures: [],
    notes: [],
    table: '',
    measurement: null,
    changes: [],
    wrote: false
  }
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
  let report
  if (options.from !== null && options.from !== undefined) {
    let emitted
    try {
      emitted = loadJson(path.resolve(root, options.from))
    } catch (err) {
      return fail(
        `emitted measurement could not be read: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    const bad = validateEmitted(emitted, doc)
    if (bad !== null) return fail(`emitted measurement is not usable: ${bad}`)
    if (emitted.platform !== platform) {
      return fail(
        `emitted measurement is for platform ${String(emitted.platform)}, not ${platform} — pass --platform ${String(emitted.platform)} to record it`
      )
    }
    measurement = emitted.measurement
    condition = emitted.measured
    report = emitted.report
  } else {
    let summary
    let reportMtimeMs
    try {
      summary = loadJson(summaryPath)
      reportMtimeMs = fs.statSync(summaryPath).mtimeMs
    } catch (err) {
      return fail(
        `coverage could not be established: no report at ${slashed(path.relative(root, summaryPath))} (${err instanceof Error ? err.message : String(err)}) — run \`${COMMAND}\` first`
      )
    }
    const newest = newestSource(root)
    if (newest !== null && newest.mtimeMs > reportMtimeMs) {
      return fail(
        `coverage report is stale: ${newest.rel} changed after the report was written — run \`${COMMAND}\` again before checking or recording anything`
      )
    }
    measurement = measure(summary, root, doc.subsystems, productionFiles(root))
    condition = measuredCondition(root, platform)
    // The report's own mtime, not the clock: `--update` run twice over one
    // coverage run reads one report and is one measurement, however long
    // apart the two invocations are.
    report = new Date(reportMtimeMs).toISOString()
  }
  out.measurement = measurement
  for (const failure of measurement.failures) fail(failure)
  for (const file of unexpectedSources(root)) {
    fail(
      `${file}  has a source extension neither vitest's coverage.include nor productionFiles() names — it would be bundled and never measured; widen both lists together, or move it`
    )
  }

  if (options.emit !== null && options.emit !== undefined) {
    const emitPath = path.resolve(root, options.emit)
    fs.mkdirSync(path.dirname(emitPath), { recursive: true })
    fs.writeFileSync(
      emitPath,
      `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, platform, measured: condition, report, measurement }, null, 2)}\n`
    )
    out.notes.push(`measurement written to ${slashed(path.relative(root, emitPath))}`)
  }

  const block = doc.platforms[platform]
  out.table = renderTable(measurement, block, doc)

  if (options.seed) {
    // A broken map or a report that is not the tree is not recorded over.
    if (out.failures.length > 0) return out
    if (block !== undefined) {
      return fail(
        `platform ${platform} already has floors recorded — --update ratchets them; to start over, delete the block by hand with a reason in the diff, never by re-seeding`
      )
    }
    const next = { ...doc, platforms: { ...doc.platforms } }
    next.platforms[platform] = {
      measured: condition,
      // The seeded run opens the window: it is a real measurement of this
      // tree, so the first --update after it is the second run, not the first.
      candidate: foldCandidate(
        null,
        measurement,
        { ...condition, report },
        doc.corroboratingRuns,
        subsystemMapHash(doc.subsystems)
      ),
      floors: measurement.floors,
      untested: measurement.untested
    }
    writeDoc(floorsPath, next)
    out.wrote = true
    out.changes.push(
      `seeded platform ${platform}: ${String(Object.keys(measurement.floors).length)} subsystems, ${String(measurement.untested.length)} untested modules recorded — REVIEW THE LIST, it is the first record and nothing checked it, and one run is not a floor the suite reproduces`
    )
    for (const file of measurement.untested) out.changes.push(`  untested: ${file}`)
    return out
  }

  if (options.update) {
    if (out.failures.length > 0) return out
    if (block === undefined) {
      return fail(
        `no coverage floors are recorded for platform ${platform} — the first record on a platform is \`--seed\` (or \`--seed --from <emitted.json> --platform ${platform}\`), never --update`
      )
    }
    const {
      doc: next,
      changes,
      held,
      regressions,
      changed,
      ratcheted
    } = ratchet(doc, platform, measurement, condition, { ...condition, report })
    if (regressions.length > 0) {
      for (const regression of regressions) fail(regression)
      out.notes.push('nothing written: a refused update leaves the record exactly as it was')
      return out
    }
    out.changes = changes
    out.notes.push(...held)
    if (changed) {
      writeDoc(floorsPath, next)
      out.wrote = true
      if (!ratcheted) {
        out.notes.push(
          'no floor moved: this run is recorded in the corroboration window, and the condition beside the floors still describes the run that set them'
        )
      }
    } else {
      out.notes.push('nothing to ratchet: the record is unchanged, condition included')
    }
    // What --update never does is add an untested module to the record, so a
    // new one is still a failure here — the file was written, the gap was not hidden.
    const after = compare(measurement, next.platforms[platform], doc, platform)
    for (const failure of after.newUntested) fail(failure)
    return out
  }

  if (block === undefined) {
    return fail(
      `no coverage floors are recorded for platform ${platform} — nothing to compare against, so this run cannot claim "no regression"; record the first measurement with \`node scripts/check-coverage.cjs --seed\` on ${platform} (or --seed --from <emitted.json> --platform ${platform}) and commit scripts/coverage-floors.json`
    )
  }
  const { missing, regressions, stale, newUntested, notes } = compare(
    measurement,
    block,
    doc,
    platform
  )
  for (const failure of [...missing, ...regressions, ...stale, ...newUntested]) fail(failure)
  out.notes.push(...notes)
  return out
}

/** @returns {number} the process exit code, so a test can call this without exiting. */
function main(argv) {
  const options = parseArgs(argv.slice(2))
  if (options.error !== undefined) {
    console.error(options.error)
    console.error(
      'usage: node scripts/check-coverage.cjs [--update | --seed] [--from <emitted.json>] [--emit <path>] [--summary <path>] [--floors <path>] [--platform <name>]'
    )
    return 2
  }
  const result = run(options)
  if (result.table !== '') console.log(`${result.table}\n`)
  for (const change of result.changes) console.log(`  ratchet: ${change}`)
  const annotate = process.env.GITHUB_ACTIONS === 'true'
  for (const note of result.notes) {
    console.log(`  note: ${note}`)
    if (annotate && note.includes('--update')) console.log(`::warning::${note}`)
  }
  if (result.failures.length > 0) {
    console.error('\nCoverage floor failures (the seam rule, ENGINEERING-STANDARDS §6.7):\n')
    for (const failure of result.failures) console.error(`  ${failure}`)
    console.error('')
    return result.exitCode
  }
  console.log(
    `coverage floors ok (${String(Object.keys(result.measurement.floors).length)} subsystems on ${options.platform ?? process.platform}; ${String(result.measurement.untested.length)} untested modules, all recorded${result.wrote ? '; record written' : ''})`
  )
  return 0
}

if (require.main === module) process.exit(main(process.argv))

module.exports = {
  SCHEMA_VERSION,
  METRICS,
  headCommit,
  treeHash,
  newestSource,
  productionFiles,
  unexpectedSources,
  measuredCondition,
  assignSubsystems,
  isUntested,
  measure,
  compare,
  ratchet,
  subsystemMapHash,
  foldCandidate,
  windowFloors,
  metricsOnly,
  validateCandidate,
  validateFloors,
  validateEmitted,
  renderTable,
  parseArgs,
  run,
  main
}
