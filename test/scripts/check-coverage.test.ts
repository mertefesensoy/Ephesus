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
 * of the production modules no test reaches.
 *
 * Every case runs the real `run()` over a fixture project in a temp directory —
 * real files on disk, a real `coverage-summary.json` in the shape istanbul's
 * `json-summary` reporter writes, a real floors file — because the script's
 * whole job is what it does with those three files, and the failure modes this
 * project keeps meeting are the ones where a check reads the wrong one. The
 * one thing not fixtured is the coverage run itself; the final block checks
 * the REAL floors file against the REAL tree, which needs no coverage run.
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
type Floors = Record<Metric, number> & { files?: number }
interface Block {
  measured: Record<string, string>
  floors: Record<string, Floors>
  untested: string[]
}
interface FloorsDoc {
  schemaVersion: number
  tolerance: number
  subsystems: Record<string, { members: string[] }>
  platforms: Record<string, Block>
}
interface RunResult {
  exitCode: number
  failures: string[]
  notes: string[]
  table: string
  changes: string[]
  measurement: {
    floors: Record<string, Floors>
    untested: string[]
    subsystemOf: Record<string, string>
    total: Record<Metric, number>
  } | null
}
interface RunOptions {
  root?: string
  platform?: string
  update?: boolean
  from?: string | null
  emit?: string | null
  summary?: string | null
  floors?: string | null
}

const check = require_(SCRIPT) as {
  SCHEMA_VERSION: number
  productionFiles: (root: string) => string[]
  assignSubsystems: (
    files: readonly string[],
    subsystems: Record<string, { members: string[] }>
  ) => { assigned: Map<string, string>; failures: string[] }
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
  schemaVersion: 1,
  tolerance: 0.5,
  subsystems: {
    alpha: { members: ['src/main/'] },
    gamma: { members: ['src/shared/c.ts'] },
    shims: { members: ['shims/'] }
  },
  platforms: {
    testos: {
      measured: { at: '2026-09-02T00:00:00.000Z', commit: 'abcdef0', command: 'fixture' },
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
  summary: (entries: Record<string, FileData>) => void
  floors: (doc: FloorsDoc | Record<string, unknown>) => void
  readFloors: () => FloorsDoc
  run: (options?: RunOptions) => RunResult
}

function project(): Project {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-cov-'))
  temps.push(root)
  for (const rel of Object.keys(BASE_SUMMARY)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'export const x = 1\n')
  }
  fs.mkdirSync(path.join(root, 'coverage'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  const summaryPath = path.join(root, 'coverage', 'coverage-summary.json')
  const floorsPath = path.join(root, 'scripts', 'coverage-floors.json')
  const p: Project = {
    root,
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
    p.summary({
      ...BASE_SUMMARY,
      'src/main/a.ts': data([79, 100]),
      'src/shared/c.ts': data([50, 50])
    })
    const result = p.run()
    expect(result.failures).toEqual([])
    expect(result.notes.some((n) => n.startsWith('subsystem gamma: lines 100% is above'))).toBe(
      true
    )
  })

  it('fails on a production module no test reaches that the record does not know', () => {
    const p = project()
    p.summary({ ...BASE_SUMMARY, 'src/shared/c.ts': data([0, 50]) })
    const result = p.run()
    expect(result.exitCode).toBe(1)
    // gamma also regresses; the untested line is the one this case is about.
    const line = result.failures.find((f) => f.startsWith('src/shared/c.ts  no test reaches'))
    expect(line).toContain('(subsystem gamma)')
    expect(line).toContain('platforms.testos.untested')
  })

  it('a known untested module is not a failure; one that gained a test is a note', () => {
    const p = project()
    p.summary({ ...BASE_SUMMARY, 'src/main/b.ts': data([10, 50]) })
    const result = p.run()
    expect(result.failures).toEqual([])
    expect(result.notes).toContain(
      'now tested: src/main/b.ts — --update removes it from the record'
    )
  })

  it('a file with lines covered by no test but a function entered is not "untested"', () => {
    const p = project()
    p.summary({ ...BASE_SUMMARY, 'src/shared/c.ts': data([0, 50], [1, 2]) })
    expect(p.run().measurement?.untested).toEqual(['src/main/b.ts'])
  })
})

describe('the map is total', () => {
  it('fails on a file on disk that belongs to no subsystem, even one the report omits', () => {
    const p = project()
    fs.writeFileSync(path.join(p.root, 'src', 'stray.ts'), 'export type T = 1\n')
    const result = p.run()
    expect(result.exitCode).toBe(1)
    expect(result.failures[0]).toMatch(/^src\/stray\.ts {2}belongs to no subsystem/)
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

  it('fails on a floors file of the wrong schema or shape', () => {
    const p = project()
    p.floors({ ...BASE_FLOORS(), schemaVersion: 2 })
    expect(p.run().failures[0]).toContain('schemaVersion 2 (expected 1)')
    p.floors({ ...BASE_FLOORS(), tolerance: 50 })
    expect(p.run().failures[0]).toContain('tolerance must be a number')
    const noMembers = BASE_FLOORS()
    noMembers.subsystems.alpha = { members: [] }
    p.floors(noMembers)
    expect(p.run().failures[0]).toContain('subsystem alpha has no members')
    const backslash = BASE_FLOORS()
    backslash.subsystems.alpha = { members: ['src\\main\\'] }
    p.floors(backslash)
    expect(p.run().failures[0]).toContain('must be a /-separated path')
  })

  it('refuses an unknown argument', () => {
    expect(check.parseArgs(['--bogus'])).toEqual({ error: 'unknown argument: --bogus' })
    expect(check.parseArgs(['--update', '--platform', 'linux'])).toMatchObject({
      update: true,
      platform: 'linux'
    })
  })
})

describe('--update is a ratchet', () => {
  it('raises a floor that rose and removes an untested module a test now reaches', () => {
    const p = project()
    p.summary({
      ...BASE_SUMMARY,
      'src/main/a.ts': data([90, 100]),
      'src/main/b.ts': data([10, 50])
    })
    const result = p.run({ update: true })
    expect(result.exitCode).toBe(0)
    expect(result.changes).toContain('subsystem alpha: lines 53.33% → 66.67%')
    expect(result.changes).toContain('now tested: src/main/b.ts')
    const after = p.readFloors()
    expect(after.platforms.testos?.floors.alpha?.lines).toBe(66.67)
    expect(after.platforms.testos?.untested).toEqual([])
    expect(after.platforms.testos?.measured.command).toBe('npm run test:coverage')
    expect(after.platforms.testos?.measured.platform).toBe('testos')
  })

  it('never lowers a floor: a regression is refused, named, and the old floor kept', () => {
    const p = project()
    p.summary({ ...BASE_SUMMARY, 'src/main/a.ts': data([60, 100]) })
    const result = p.run({ update: true })
    expect(result.exitCode).toBe(1)
    expect(result.failures[0]).toContain(
      'subsystem alpha: lines 40% is below its floor of 53.33% — --update never lowers a floor'
    )
    expect(p.readFloors().platforms.testos?.floors.alpha?.lines).toBe(53.33)
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
    doc.tolerance = 5 // so gamma's own fall is inside tolerance and only the gap speaks
    doc.platforms.testos!.floors.gamma = { lines: 1, branches: 1, functions: 1, statements: 1 }
    p.floors(doc)
    const result = p.run({ update: true })
    expect(result.exitCode).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatch(/^src\/shared\/c\.ts {2}no test reaches/)
    const after = p.readFloors()
    expect(after.platforms.testos?.untested).toEqual(['src/main/b.ts'])
    expect(after.platforms.testos?.floors.alpha?.lines).toBe(66.67) // the ratchet still happened
  })

  it('seeds a platform that has no block, floors and untested list both', () => {
    const p = project()
    const result = p.run({ update: true, platform: 'newos' })
    expect(result.exitCode).toBe(0)
    expect(result.changes[0]).toBe(
      'seeded platform newos: 3 subsystems, 1 untested modules recorded'
    )
    const block = p.readFloors().platforms.newos
    expect(block?.floors.alpha?.lines).toBe(53.33)
    expect(block?.untested).toEqual(['src/main/b.ts'])
    // And the plain check now holds on that platform.
    expect(p.run({ platform: 'newos' }).exitCode).toBe(0)
  })

  it('does not ratchet over a broken map', () => {
    const p = project()
    fs.writeFileSync(path.join(p.root, 'src', 'stray.ts'), 'export const s = 1\n')
    p.summary({ ...BASE_SUMMARY, 'src/main/a.ts': data([100, 100]) })
    const before = fs.readFileSync(path.join(p.root, 'scripts', 'coverage-floors.json'), 'utf8')
    const result = p.run({ update: true })
    expect(result.exitCode).toBe(1)
    expect(fs.readFileSync(path.join(p.root, 'scripts', 'coverage-floors.json'), 'utf8')).toBe(
      before
    )
  })
})

describe('a measurement can travel', () => {
  it('--emit writes the measurement with its condition; --update --from records it on its platform', () => {
    const p = project()
    p.summary({ ...BASE_SUMMARY, 'src/main/a.ts': data([90, 100]) })
    const emitted = p.run({ emit: 'coverage/measured.json', platform: 'ci-linux' })
    expect(emitted.notes).toContain('measurement written to coverage/measured.json')
    const file = JSON.parse(
      fs.readFileSync(path.join(p.root, 'coverage', 'measured.json'), 'utf8')
    ) as {
      platform: string
      measured: Record<string, string>
      measurement: { floors: Record<string, Floors> }
    }
    expect(file.platform).toBe('ci-linux')
    expect(file.measured.command).toBe('npm run test:coverage')
    expect(file.measurement.floors.alpha?.lines).toBe(60)

    const wrongPlatform = p.run({
      update: true,
      from: 'coverage/measured.json',
      platform: 'testos'
    })
    expect(wrongPlatform.exitCode).toBe(1)
    expect(wrongPlatform.failures[0]).toContain(
      'emitted measurement is for platform ci-linux, not testos'
    )

    const recorded = p.run({ update: true, from: 'coverage/measured.json', platform: 'ci-linux' })
    expect(recorded.exitCode).toBe(0)
    const block = p.readFloors().platforms['ci-linux']
    expect(block?.floors.alpha?.lines).toBe(60)
    expect(block?.measured.platform).toBe('ci-linux')
  })
})

describe('over this repository', () => {
  const doc = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'coverage-floors.json'), 'utf8')
  ) as FloorsDoc

  it('the committed floors file is a valid record', () => {
    expect(check.validateFloors(doc)).toBeNull()
    expect(doc.schemaVersion).toBe(check.SCHEMA_VERSION)
  })

  it('every production file belongs to exactly one subsystem, and every member names one', () => {
    const files = check.productionFiles(REPO_ROOT)
    expect(files.length).toBeGreaterThan(150)
    expect(files).toContain('src/main/index.ts')
    expect(files).toContain('shims/eph-hook.mjs')
    expect(files.some((f) => f.endsWith('.d.ts'))).toBe(false)
    const { failures } = check.assignSubsystems(files, doc.subsystems)
    expect(failures).toEqual([])
  })

  it('the Herald is its own row, so its zero can never hide inside another subsystem', () => {
    const { assigned } = check.assignSubsystems(check.productionFiles(REPO_ROOT), doc.subsystems)
    expect(assigned.get('src/main/herald/seam.ts')).toBe('herald')
    expect(assigned.get('src/main/index.ts')).toBe('boot')
    expect(assigned.get('src/renderer/src/floor/walk.ts')).toBe('terraces')
    expect(assigned.get('src/renderer/src/WatchPanel.tsx')).toBe('panels')
  })

  it('reads the commit under HEAD without invoking git', () => {
    expect(check.headCommit(REPO_ROOT)).toMatch(/^[0-9a-f]{7}$/)
    expect(check.headCommit(temps[0] ?? os.tmpdir())).toBe('unknown')
  })
})
