import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../tmpdir'

/**
 * The coverage half of the seam rule (ENGINEERING-STANDARDS §6.7, TEST-STRATEGY
 * §2 — M8.0): a per-subsystem ratchet with its condition recorded, and a record
 * of the production modules no test enters.
 *
 * Every case runs the real `run()` over a fixture project in a temp directory —
 * real files on disk, a real `coverage-summary.json` in the shape istanbul's
 * `json-summary` reporter writes, a real floors file — because the script's
 * whole job is what it does with those three files, and the failure modes this
 * project keeps meeting are the ones where a check reads the wrong one. The
 * 2026-09-02 refutation pass found three bypasses in the first draft; each has
 * a case here that fails against it. The one thing not fixtured is the coverage
 * run itself; the final block checks the REAL floors file against the REAL
 * tree, which needs no coverage run.
 */

const require_ = createRequire(import.meta.url)
const SCRIPT = fileURLToPath(new URL('../../scripts/check-coverage.cjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

interface Counts {
  readonly total: number
  readonly covered: number
  readonly skipped: number
  readonly pct: number
}
interface FileData {
  readonly lines: Counts
  readonly branches: Counts
  readonly functions: Counts
  readonly statements: Counts
}
type Metric = 'lines' | 'branches' | 'functions' | 'statements'
type Floors = Record<Metric, number> & { files: number }
interface Condition {
  at: string
  commit: string
  ref: string
  tree: string
  platform: string
  node: string
  os: string
  command: string
}
interface Block {
  measured: Condition
  floors: Record<string, Partial<Floors>>
  untested: string[]
}
interface FloorsDoc {
  schemaVersion: number
  tolerance: number
  toleranceReason: string
  ratchetLag: number
  ratchetLagReason: string
  subsystems: Record<string, { members: string[] }>
  platforms: Record<string, Block>
}
interface Measurement {
  floors: Record<string, Floors>
  untested: string[]
  subsystemOf: Record<string, string>
  total: Record<Metric, number>
  reportFiles: string[]
}
interface RunResult {
  exitCode: number
  failures: string[]
  notes: string[]
  table: string
  changes: string[]
  wrote: boolean
  measurement: Measurement | null
}
interface RunOptions {
  root?: string
  platform?: string
  update?: boolean
  seed?: boolean
  from?: string | null
  emit?: string | null
  summary?: string | null
  floors?: string | null
}

const check = require_(SCRIPT) as {
  SCHEMA_VERSION: number
  productionFiles: (root: string) => string[]
  unexpectedSources: (root: string) => string[]
  treeHash: (root: string) => string
  assignSubsystems: (
    files: readonly string[],
    subsystems: Record<string, { members: string[] }>
  ) => { assigned: Map<string, string>; failures: string[] }
  isUntested: (data: FileData) => boolean
  compare: (
    measurement: Measurement,
    block: Block,
    doc: FloorsDoc,
    platform: string
  ) => {
    missing: string[]
    regressions: string[]
    stale: string[]
    newUntested: string[]
    notes: string[]
  }
  validateFloors: (doc: unknown) => string | null
  parseArgs: (argv: readonly string[]) => Record<string, unknown>
  headCommit: (root: string) => string
  run: (options: RunOptions) => RunResult
}

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

type Pair = readonly [covered: number, total: number]
const counts = ([covered, total]: Pair): Counts => ({
  total,
  covered,
  skipped: 0,
  pct: total === 0 ? 100 : Math.round((covered / total) * 10000) / 100
})
/** One report entry; functions default to "entered iff any line was". */
function data(lines: Pair, functions: Pair = [lines[0] > 0 ? 1 : 0, 1]): FileData {
  return {
    lines: counts(lines),
    branches: counts(lines),
    functions: counts(functions),
    statements: counts(lines)
  }
}

const CONDITION: Condition = {
  at: '2026-09-02T00:00:00.000Z',
  commit: 'abcdef0',
  ref: 'local',
  tree: '000000000000',
  platform: 'testos',
  node: 'v20.0.0',
  os: 'Fixture 1',
  command: 'npm run test:coverage'
}
const REASON = 'fixture reason, long enough to satisfy the record: measured on the fixture, n = 1'

/**
 * The fixture: four production files, three subsystems. `a` is well covered,
 * `b` is untested and known to be, `c` is nearly covered, the shim is fully.
 */
const BASE_SUMMARY: Record<string, FileData> = {
  'src/main/a.ts': data([80, 100]),
  'src/main/b.ts': data([0, 50]),
  'src/shared/c.ts': data([45, 50]),
  'shims/s.mjs': data([10, 10])
}
const BASE_FLOORS = (): FloorsDoc => ({
  schemaVersion: 2,
  tolerance: 0.5,
  toleranceReason: REASON,
  ratchetLag: 5,
  ratchetLagReason: REASON,
  subsystems: {
    alpha: { members: ['src/main/'] },
    gamma: { members: ['src/shared/c.ts'] },
    shims: { members: ['shims/'] }
  },
  platforms: {
    testos: {
      measured: { ...CONDITION },
      floors: {
        alpha: { lines: 53.33, branches: 53.33, functions: 50, statements: 53.33, files: 2 },
        gamma: { lines: 90, branches: 90, functions: 100, statements: 90, files: 1 },
        shims: { lines: 100, branches: 100, functions: 100, statements: 100, files: 1 }
      },
      untested: ['src/main/b.ts']
    }
  }
})

interface Project {
  readonly root: string
  readonly floorsPath: string
  summary: (entries: Record<string, FileData>) => void
  floors: (doc: FloorsDoc | Record<string, unknown>) => void
  readFloors: () => FloorsDoc
  rawFloors: () => string
  run: (options?: RunOptions) => RunResult
}

/**
 * A source file a test adds mid-case: written, then backdated, so the report the
 * fixture already wrote is not stale by the rule — that rule has its own case.
 */
function writeSource(root: string, rel: string, text: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  const past = new Date(Date.now() - 120_000)
  fs.utimesSync(abs, past, past)
}

function project(): Project {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-cov-'))
  temps.push(root)
  const past = new Date(Date.now() - 60_000)
  for (const rel of Object.keys(BASE_SUMMARY)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'export const x = 1\n')
    // Sources are older than the report a fixture writes next, as in real life.
    fs.utimesSync(abs, past, past)
  }
  fs.mkdirSync(path.join(root, 'coverage'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  const summaryPath = path.join(root, 'coverage', 'coverage-summary.json')
  const floorsPath = path.join(root, 'scripts', 'coverage-floors.json')
  const p: Project = {
    root,
    floorsPath,
    summary(entries) {
      // The real reporter keys by ABSOLUTE path with the platform's separators.
      const keyed: Record<string, FileData> = {}
      for (const [rel, value] of Object.entries(entries)) keyed[path.join(root, rel)] = value
      fs.writeFileSync(summaryPath, JSON.stringify({ total: data([0, 0]), ...keyed }))
    },
    floors(doc) {
      fs.writeFileSync(floorsPath, `${JSON.stringify(doc, null, 2)}\n`)
    },
    readFloors: () => JSON.parse(fs.readFileSync(floorsPath, 'utf8')) as FloorsDoc,
    rawFloors: () => fs.readFileSync(floorsPath, 'utf8'),
    run: (options = {}) => check.run({ root, platform: 'testos', ...options })
  }
  p.summary(BASE_SUMMARY)
  p.floors(BASE_FLOORS())
  return p
}

describe('the check', () => {
  it('holds when every subsystem sits at its floor and every untested module is recorded', () => {
    const p = project()
    const result = p.run()
    expect(result.failures).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(result.table).toContain('alpha')
    expect(result.measurement?.floors.alpha?.lines).toBe(53.33)
    expect(result.measurement?.untested).toEqual(['src/main/b.ts'])
  })

  it('fails by subsystem and metric on a regression past the tolerance, naming the lowest files', () => {
    const p = project()
    p.summary({ ...BASE_SUMMARY, 'src/main/a.ts': data([60, 100]) })
    const result = p.run()
    expect(result.exitCode).toBe(1)
    const line = result.failures.find((f) => f.startsWith('subsystem alpha: lines'))
    expect(line).toContain('lines 40% is below its testos floor of 53.33% (tolerance 0.5)')
    expect(line).toContain('lowest files: src/main/b.ts 0%, src/main/a.ts 60%')
    // Every metric that regressed is named, not only the first — and only those:
    // `a` still enters its one function, so functions held at 50% and is silent.
    const alpha = result.failures.filter((f) => f.startsWith('subsystem alpha:'))
    expect(alpha.map((f) => f.split(' ')[2])).toEqual(['lines', 'branches', 'statements'])
  })

  it('tolerates a dip inside the tolerance and notes a rise it could ratchet', () => {
    const p = project()
    const doc = BASE_FLOORS()
    doc.tolerance = 1
    p.floors(doc)
    // gamma 90 → 94: a rise inside the ratchet lag, so a note rather than "stale".
    p.summary({
      ...BASE_SUMMARY,
      'src/main/a.ts': data([79, 100]),
      'src/shared/c.ts': data([47, 50])
    })
    const result = p.run()
    expect(result.failures).toEqual([])
    expect(result.notes.some((n) => n.startsWith('subsystem gamma: lines 94% is above'))).toBe(true)
  })

  it('compares on rounded values: a figure exactly at the tolerance edge is not a regression', () => {
    const p = project()
    const doc = BASE_FLOORS()
    doc.tolerance = 0.25
    doc.platforms.testos!.floors.gamma = {
      lines: 0.28,
      branches: 0.28,
      functions: 0.28,
      statements: 0.28,
      files: 1
    }
    p.floors(doc)
    // 0.28 - 0.25 is 0.030000000000000027 in floating point; 0.03 measured must pass.
    p.summary({ ...BASE_SUMMARY, 'src/shared/c.ts': data([3, 10000], [3, 10000]) })
    expect(p.run().failures.filter((f) => f.startsWith('subsystem gamma'))).toEqual([])
  })

  it('fails when a floor lags reality by more than the recorded margin — a ratchet nobody turned', () => {
    const p = project()
    p.summary({
      ...BASE_SUMMARY,
      'src/main/a.ts': data([100, 100]),
      'src/main/b.ts': data([50, 50])
    })
    const result = p.run()
    expect(result.exitCode).toBe(1)
    const line = result.failures.find((f) => f.startsWith('subsystem alpha: lines'))
    expect(line).toContain(
      'is more than 5 points above its testos floor of 53.33% — the record is stale'
    )
  })

  it('fails on a production module no test enters that the record does not know', () => {
    const p = project()
    p.summary({ ...BASE_SUMMARY, 'src/shared/c.ts': data([0, 50]) })
    const result = p.run()
    expect(result.exitCode).toBe(1)
    const line = result.failures.find((f) => f.startsWith('src/shared/c.ts  no test enters'))
    expect(line).toContain('(subsystem gamma)')
    expect(line).toContain('platforms.testos.untested')
  })

  it('a module imported but never entered is untested — the config.ts shape', () => {
    const p = project()
    p.summary({ ...BASE_SUMMARY, 'src/shared/c.ts': data([1, 10], [0, 3]) })
    const result = p.run()
    expect(result.measurement?.untested).toEqual(['src/main/b.ts', 'src/shared/c.ts'])
    expect(result.failures.some((f) => f.startsWith('src/shared/c.ts  no test enters'))).toBe(true)
    expect(check.isUntested(data([1, 10], [0, 3]))).toBe(true)
    expect(check.isUntested(data([0, 10], [0, 0]))).toBe(true)
    expect(check.isUntested(data([0, 0], [0, 0]))).toBe(false) // a type-only module
    expect(check.isUntested(data([5, 10], [1, 3]))).toBe(false)
  })

  it('a known untested module is not a failure; one that gained a test, or is gone, is a note', () => {
    const p = project()
    // `b` gains a test: alpha's functions go 1/2 → 2/2, which the fixture floor
    // must already carry or the rise would (correctly) read as a stale record.
    const gained = BASE_FLOORS()
    gained.platforms.testos!.floors.alpha!.functions = 100
    p.floors(gained)
    p.summary({ ...BASE_SUMMARY, 'src/main/b.ts': data([5, 50]) })
    const result = p.run()
    expect(result.failures).toEqual([])
    expect(result.notes).toContain(
      'now tested: src/main/b.ts — --update removes it from the record'
    )
    const gone = BASE_FLOORS()
    gone.platforms.testos!.untested = ['src/main/b.ts', 'src/main/gone.ts']
    p.floors(gone)
    p.summary(BASE_SUMMARY)
    const result2 = p.run()
    expect(result2.failures).toEqual([])
    expect(result2.notes).toContain(
      'gone from the tree: src/main/gone.ts — --update removes it from the record'
    )
  })

  it('a hand-deleted metric key is a failure, not a disabled metric', () => {
    const p = project()
    const doc = BASE_FLOORS()
    delete doc.platforms.testos!.floors.alpha!.branches
    p.floors(doc)
    const result = p.run()
    expect(result.exitCode).toBe(1)
    expect(result.failures[0]).toContain('subsystem alpha lacks a numeric branches floor')
  })

  it('compare() itself treats a floor without a numeric metric as missing, never as "no floor"', () => {
    // validateFloors refuses such a record before compare() runs; this is the
    // second line, exercised directly so it cannot rot unnoticed behind the first.
    const p = project()
    const measurement = p.run().measurement
    expect(measurement).not.toBeNull()
    const block = BASE_FLOORS().platforms.testos!
    delete block.floors.alpha!.branches
    const verdict = check.compare(measurement!, block, BASE_FLOORS(), 'testos')
    expect(verdict.missing).toEqual([
      'subsystem alpha: no numeric branches floor recorded for platform testos — a missing key is not "no floor", it is a record that cannot be compared; restore it'
    ])
    expect(verdict.regressions).toEqual([])
  })
})

describe('the map is total and the report is the tree', () => {
  it('fails on a file on disk that belongs to no subsystem, even one the report omits', () => {
    const p = project()
    writeSource(p.root, 'src/stray.ts', 'export type T = 1\n')
    const result = p.run()
    expect(result.exitCode).toBe(1)
    expect(result.failures.some((f) => /^src\/stray\.ts {2}belongs to no subsystem/.test(f))).toBe(
      true
    )
  })

  it('fails on a member that names nothing, so the map cannot outlive the tree', () => {
    const p = project()
    const doc = BASE_FLOORS()
    doc.subsystems.gamma = { members: ['src/shared/c.ts', 'src/shared/gone.ts'] }
    p.floors(doc)
    const result = p.run()
    expect(result.exitCode).toBe(1)
    expect(result.failures[0]).toContain(
      "subsystem gamma: member 'src/shared/gone.ts' names nothing"
    )
  })

  it('fails on a report entry with no file behind it, and on a file the report never saw', () => {
    const p = project()
    fs.rmSync(path.join(p.root, 'src/main/b.ts'))
    const gone = p.run()
    expect(gone.exitCode).toBe(1)
    expect(
      gone.failures.some((f) =>
        f.startsWith('src/main/b.ts  is in the coverage report but not on disk')
      )
    ).toBe(true)
    // And the reverse: a production file dropped from the report while a prefix still claims it.
    const p2 = project()
    const { 'src/main/b.ts': _dropped, ...rest } = BASE_SUMMARY
    void _dropped
    p2.summary(rest)
    const missing = p2.run()
    expect(missing.exitCode).toBe(1)
    expect(
      missing.failures.some((f) =>
        f.startsWith('src/main/b.ts  is on disk but absent from the coverage report')
      )
    ).toBe(true)
  })

  it('refuses a report older than the newest production file', () => {
    const p = project()
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(path.join(p.root, 'src/main/a.ts'), future, future)
    const result = p.run()
    expect(result.exitCode).toBe(1)
    expect(result.failures[0]).toContain(
      'coverage report is stale: src/main/a.ts changed after the report was written'
    )
    // Nothing is recorded over a stale report either.
    const before = p.rawFloors()
    expect(p.run({ update: true }).exitCode).toBe(1)
    expect(p.rawFloors()).toBe(before)
  })

  it('fails on a source extension under src/ that neither list would ever measure', () => {
    const p = project()
    writeSource(p.root, 'src/main/legacy.mjs', 'export const l = 1\n')
    const result = p.run()
    expect(result.exitCode).toBe(1)
    expect(
      result.failures.some((f) => f.startsWith('src/main/legacy.mjs  has a source extension'))
    ).toBe(true)
    expect(check.unexpectedSources(p.root)).toEqual(['src/main/legacy.mjs'])
  })

  it('an exact file beats a directory prefix, and a longer prefix beats a shorter one', () => {
    const { assigned, failures } = check.assignSubsystems(
      ['src/main/a.ts', 'src/main/b.ts', 'src/main/deep/d.ts'],
      {
        alpha: { members: ['src/main/'] },
        beta: { members: ['src/main/b.ts'] },
        delta: { members: ['src/main/deep/'] }
      }
    )
    expect(failures).toEqual([])
    expect(assigned.get('src/main/a.ts')).toBe('alpha')
    expect(assigned.get('src/main/b.ts')).toBe('beta')
    expect(assigned.get('src/main/deep/d.ts')).toBe('delta')
  })

  it('two claims at the same rank are a map error, not a silent pick', () => {
    const { failures } = check.assignSubsystems(['src/main/a.ts'], {
      alpha: { members: ['src/main/a.ts'] },
      beta: { members: ['src/main/a.ts'] }
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain(
      'claimed by more than one subsystem at the same rank (alpha, beta)'
    )
  })
})

describe('could-not-establish fails', () => {
  it('fails, with the table still rendered, when this platform has no floors', () => {
    const p = project()
    const result = p.run({ platform: 'otheros' })
    expect(result.exitCode).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain('no coverage floors are recorded for platform otheros')
    expect(result.failures[0]).toContain('--seed')
    expect(result.table).toContain('alpha')
    expect(result.table).toContain('—')
  })

  it('fails when there is no report to read', () => {
    const p = project()
    fs.rmSync(path.join(p.root, 'coverage', 'coverage-summary.json'))
    const result = p.run()
    expect(result.exitCode).toBe(1)
    expect(result.failures[0]).toMatch(
      /^coverage could not be established: no report at coverage\/coverage-summary\.json/
    )
  })

  it('fails on a floors file of the wrong schema or shape, naming the first fault', () => {
    const p = project()
    const cases: [Record<string, unknown>, string][] = [
      [{ ...BASE_FLOORS(), schemaVersion: 1 }, 'schemaVersion 1 (expected 2)'],
      [{ ...BASE_FLOORS(), tolerance: 5 }, 'tolerance must be a number'],
      [{ ...BASE_FLOORS(), toleranceReason: 'short' }, 'toleranceReason must say how'],
      [{ ...BASE_FLOORS(), ratchetLag: 0 }, 'ratchetLag must be a number'],
      [{ ...BASE_FLOORS(), ratchetLagReason: '' }, 'ratchetLagReason must say why']
    ]
    for (const [doc, fault] of cases) {
      p.floors(doc)
      expect(p.run().failures[0]).toContain(fault)
    }
    const noMembers = BASE_FLOORS()
    noMembers.subsystems.alpha = { members: [] }
    p.floors(noMembers)
    expect(p.run().failures[0]).toContain('subsystem alpha has no members')
    const noCondition = BASE_FLOORS()
    delete (noCondition.platforms.testos!.measured as Partial<Condition>).tree
    p.floors(noCondition)
    expect(p.run().failures[0]).toContain("measured condition lacks 'tree'")
    const extra = BASE_FLOORS()
    extra.platforms.testos!.floors.omega = {
      lines: 1,
      branches: 1,
      functions: 1,
      statements: 1,
      files: 1
    }
    p.floors(extra)
    expect(p.run().failures[0]).toContain('floor for unknown subsystem omega')
  })

  it('refuses an unknown argument and two verbs at once', () => {
    expect(check.parseArgs(['--bogus'])).toEqual({ error: 'unknown argument: --bogus' })
    expect(check.parseArgs(['--update', '--seed'])).toEqual({
      error: '--update and --seed are different verbs; pass one'
    })
    expect(check.parseArgs(['--seed', '--platform', 'linux'])).toMatchObject({
      seed: true,
      platform: 'linux'
    })
  })
})

describe('--update is a ratchet', () => {
  it('raises a floor that rose, removes an untested module a test now enters, and re-stamps the condition', () => {
    const p = project()
    p.summary({
      ...BASE_SUMMARY,
      'src/main/a.ts': data([90, 100]),
      'src/main/b.ts': data([10, 50])
    })
    const result = p.run({ update: true })
    expect(result.exitCode).toBe(0)
    expect(result.wrote).toBe(true)
    expect(result.changes).toContain('subsystem alpha: lines 53.33% → 66.67%')
    expect(result.changes).toContain('now tested: src/main/b.ts')
    const after = p.readFloors()
    expect(after.platforms.testos?.floors.alpha?.lines).toBe(66.67)
    expect(after.platforms.testos?.untested).toEqual([])
    expect(after.platforms.testos?.measured.command).toBe('npm run test:coverage')
    expect(after.platforms.testos?.measured.platform).toBe('testos')
    expect(after.platforms.testos?.measured.at).not.toBe(CONDITION.at)
    expect(after.platforms.testos?.measured.tree).toMatch(/^[0-9a-f]{12}$/)
    expect(after.platforms.testos?.measured.ref).toBeTypeOf('string')
  })

  it('never lowers a floor: a regression is refused, named, and the file left byte-identical', () => {
    const p = project()
    p.summary({ ...BASE_SUMMARY, 'src/main/a.ts': data([60, 100]) })
    const before = p.rawFloors()
    const result = p.run({ update: true })
    expect(result.exitCode).toBe(1)
    expect(result.wrote).toBe(false)
    expect(result.failures[0]).toContain(
      'subsystem alpha: lines 40% is below its floor of 53.33% — --update never lowers a floor'
    )
    expect(result.notes).toContain(
      'nothing written: a refused update leaves the record exactly as it was'
    )
    expect(p.rawFloors()).toBe(before)
  })

  it('a no-op update writes nothing and does not move the condition', () => {
    const p = project()
    const before = p.rawFloors()
    const result = p.run({ update: true })
    expect(result.exitCode).toBe(0)
    expect(result.wrote).toBe(false)
    expect(result.notes).toContain(
      'nothing to ratchet: the record is unchanged, condition included'
    )
    expect(p.rawFloors()).toBe(before)
  })

  it('keeps a floor through a dip inside the tolerance, and does not call it a regression', () => {
    const p = project()
    const doc = BASE_FLOORS()
    doc.tolerance = 1
    p.floors(doc)
    // 79/150 = 52.67: a dip of 0.66 under the 53.33 floor, inside a tolerance of 1.
    p.summary({ ...BASE_SUMMARY, 'src/main/a.ts': data([79, 100]) })
    const result = p.run({ update: true })
    expect(result.exitCode).toBe(0)
    expect(result.changes.some((c) => c.startsWith('subsystem alpha: lines'))).toBe(false)
    expect(p.readFloors().platforms.testos?.floors.alpha?.lines).toBe(53.33)
  })

  it('never adds an untested module: the file is written and the gap still fails', () => {
    const p = project()
    p.summary({
      ...BASE_SUMMARY,
      'src/shared/c.ts': data([0, 50]),
      'src/main/a.ts': data([100, 100])
    })
    const doc = BASE_FLOORS()
    doc.tolerance = 1
    doc.ratchetLag = 10 // alpha rises 13 points; the lag is not what this case is about
    doc.platforms.testos!.floors.gamma = {
      lines: 0.5,
      branches: 0.5,
      functions: 0.5,
      statements: 0.5,
      files: 1
    }
    p.floors(doc)
    const result = p.run({ update: true })
    expect(result.exitCode).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatch(/^src\/shared\/c\.ts {2}no test enters/)
    const after = p.readFloors()
    expect(after.platforms.testos?.untested).toEqual(['src/main/b.ts'])
    expect(after.platforms.testos?.floors.alpha?.lines).toBe(66.67) // the ratchet still happened
  })

  it('cannot start over: --update on a platform with no block fails and points at --seed', () => {
    const p = project()
    const doc = BASE_FLOORS()
    doc.platforms = {}
    p.floors(doc)
    const before = p.rawFloors()
    const result = p.run({ update: true })
    expect(result.exitCode).toBe(1)
    expect(result.failures[0]).toContain('the first record on a platform is `--seed`')
    expect(p.rawFloors()).toBe(before)
  })

  it('does not ratchet over a broken map', () => {
    const p = project()
    writeSource(p.root, 'src/stray.ts', 'export const s = 1\n')
    p.summary({ ...BASE_SUMMARY, 'src/main/a.ts': data([100, 100]) })
    const before = p.rawFloors()
    const result = p.run({ update: true })
    expect(result.exitCode).toBe(1)
    expect(p.rawFloors()).toBe(before)
  })
})

describe('--seed is the explicit first record', () => {
  it('seeds a platform that has no block, floors and untested list both, and says so loudly', () => {
    const p = project()
    const result = p.run({ seed: true, platform: 'newos' })
    expect(result.exitCode).toBe(0)
    expect(result.wrote).toBe(true)
    expect(result.changes[0]).toContain(
      'seeded platform newos: 3 subsystems, 1 untested modules recorded — REVIEW THE LIST'
    )
    expect(result.changes).toContain('  untested: src/main/b.ts')
    const block = p.readFloors().platforms.newos
    expect(block?.floors.alpha?.lines).toBe(53.33)
    expect(block?.untested).toEqual(['src/main/b.ts'])
    expect(block?.measured.tree).toMatch(/^[0-9a-f]{12}$/)
    // And the plain check now holds on that platform.
    expect(p.run({ platform: 'newos' }).exitCode).toBe(0)
  })

  it('refuses to seed a platform that already has floors', () => {
    const p = project()
    p.summary({ ...BASE_SUMMARY, 'src/main/a.ts': data([10, 100]) })
    const before = p.rawFloors()
    const result = p.run({ seed: true })
    expect(result.exitCode).toBe(1)
    expect(result.failures[0]).toContain('platform testos already has floors recorded')
    expect(p.rawFloors()).toBe(before)
  })

  it('does not seed over a broken map or a stale report', () => {
    const p = project()
    writeSource(p.root, 'src/stray.ts', 'export const s = 1\n')
    const doc = BASE_FLOORS()
    doc.platforms = {}
    p.floors(doc)
    const before = p.rawFloors()
    expect(p.run({ seed: true }).exitCode).toBe(1)
    expect(p.rawFloors()).toBe(before)
  })
})

describe('a measurement can travel', () => {
  it('--emit writes the measurement with its condition; --seed --from and --update --from record it on its platform', () => {
    const p = project()
    p.summary({ ...BASE_SUMMARY, 'src/main/a.ts': data([90, 100]) })
    const emitted = p.run({ emit: 'coverage/measured.json', platform: 'ci-linux' })
    expect(emitted.notes).toContain('measurement written to coverage/measured.json')
    const file = JSON.parse(
      fs.readFileSync(path.join(p.root, 'coverage', 'measured.json'), 'utf8')
    ) as {
      schemaVersion: number
      platform: string
      measured: Condition
      measurement: { floors: Record<string, Floors>; files: Record<string, unknown> }
    }
    expect(file.schemaVersion).toBe(2)
    expect(file.platform).toBe('ci-linux')
    expect(file.measured.command).toBe('npm run test:coverage')
    expect(file.measured.tree).toMatch(/^[0-9a-f]{12}$/)
    expect(file.measurement.floors.alpha?.lines).toBe(60)
    expect(Object.keys(file.measurement.files)).toHaveLength(4)

    const wrongPlatform = p.run({ seed: true, from: 'coverage/measured.json', platform: 'testos' })
    expect(wrongPlatform.exitCode).toBe(1)
    expect(wrongPlatform.failures[0]).toContain(
      'emitted measurement is for platform ci-linux, not testos'
    )

    const seeded = p.run({ seed: true, from: 'coverage/measured.json', platform: 'ci-linux' })
    expect(seeded.exitCode).toBe(0)
    const block = p.readFloors().platforms['ci-linux']
    expect(block?.floors.alpha?.lines).toBe(60)
    expect(block?.measured.platform).toBe('ci-linux')

    p.summary({ ...BASE_SUMMARY, 'src/main/a.ts': data([95, 100]) })
    p.run({ emit: 'coverage/measured2.json', platform: 'ci-linux' })
    const updated = p.run({ update: true, from: 'coverage/measured2.json', platform: 'ci-linux' })
    expect(updated.exitCode).toBe(0)
    expect(p.readFloors().platforms['ci-linux']?.floors.alpha?.lines).toBe(63.33)
  })

  it('refuses an artifact from a different map, or of the wrong shape, by name', () => {
    const p = project()
    p.run({ emit: 'coverage/measured.json', platform: 'ci-linux' })
    const emittedPath = path.join(p.root, 'coverage', 'measured.json')
    const emitted = JSON.parse(fs.readFileSync(emittedPath, 'utf8')) as {
      measurement: { floors: Record<string, unknown>; total?: unknown }
    }
    delete emitted.measurement.floors.shims
    fs.writeFileSync(emittedPath, JSON.stringify(emitted))
    const mismatch = p.run({ seed: true, from: 'coverage/measured.json', platform: 'ci-linux' })
    expect(mismatch.exitCode).toBe(1)
    expect(mismatch.failures[0]).toContain(
      'measurement covers subsystems [alpha, gamma] but the map has [alpha, gamma, shims]'
    )
    fs.writeFileSync(emittedPath, JSON.stringify({ schemaVersion: 2, platform: 'ci-linux' }))
    const malformed = p.run({ seed: true, from: 'coverage/measured.json', platform: 'ci-linux' })
    expect(malformed.exitCode).toBe(1)
    expect(malformed.failures[0]).toContain('emitted measurement is not usable: measured missing')
    expect(p.readFloors().platforms['ci-linux']).toBeUndefined()
  })
})

describe('over this repository', () => {
  const doc = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'coverage-floors.json'), 'utf8')
  ) as FloorsDoc

  it('the committed floors file is a valid record, reasons included', () => {
    expect(check.validateFloors(doc)).toBeNull()
    expect(doc.schemaVersion).toBe(check.SCHEMA_VERSION)
    expect(doc.toleranceReason).toContain('n = ')
  })

  it('every production file belongs to exactly one subsystem, and every member names one', () => {
    const files = check.productionFiles(REPO_ROOT)
    expect(files.length).toBeGreaterThan(150)
    expect(files).toContain('src/main/index.ts')
    expect(files).toContain('shims/eph-hook.mjs')
    expect(files.some((f) => f.endsWith('.d.ts'))).toBe(false)
    const { failures } = check.assignSubsystems(files, doc.subsystems)
    expect(failures).toEqual([])
    expect(check.unexpectedSources(REPO_ROOT)).toEqual([])
  })

  it('the Herald is its own row, so its zero can never hide inside another subsystem', () => {
    const { assigned } = check.assignSubsystems(check.productionFiles(REPO_ROOT), doc.subsystems)
    expect(assigned.get('src/main/herald/seam.ts')).toBe('herald')
    expect(assigned.get('src/main/index.ts')).toBe('boot')
    expect(assigned.get('src/renderer/src/floor/walk.ts')).toBe('terraces')
    expect(assigned.get('src/renderer/src/WatchPanel.tsx')).toBe('panels')
  })

  it('reads the commit under HEAD and hashes the tree without invoking git', () => {
    expect(check.headCommit(REPO_ROOT)).toMatch(/^[0-9a-f]{7}$/)
    expect(check.headCommit(temps[0] ?? os.tmpdir())).toBe('unknown')
    const hash = check.treeHash(REPO_ROOT)
    expect(hash).toMatch(/^[0-9a-f]{12}$/)
    expect(check.treeHash(REPO_ROOT)).toBe(hash)
  })
})
