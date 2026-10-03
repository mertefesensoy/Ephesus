import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../tmpdir'

/**
 * The mutation round (`scripts/mutate.cjs`, GYM-008), fed the ways a round has
 * lied before.
 *
 * Three of them are the proposal's named cases — a spec with no control, an
 * anchor that matches nothing, a suite that refuses to start — and each was a
 * real scratch-harness bug that reported a score nobody had earned. The rest
 * pin the other requirements: a red baseline, a killed control, an uncommitted
 * file, a file that changes while the suite runs, a byte-exact restore, and a
 * survivor that stops the round with the question it owes.
 *
 * The integration cases run the real command over a real git repository in a
 * temp directory with a real, nested vitest, because what the tool decides is
 * read off vitest's own report: a fake runner would test the fake. The report
 * shapes the unit cases feed `classify` were measured on vitest 4.1.11 on
 * 2026-10-03 (win32, node v20.16.0), each by running vitest on a fixture that
 * produced it.
 */

const require_ = createRequire(import.meta.url)
const SCRIPT = fileURLToPath(new URL('../../scripts/mutate.cjs', import.meta.url))

type Verdict =
  | { kind: 'pass'; passed: ReadonlySet<string>; skipped: number }
  | { kind: 'fail'; how: 'test' | 'file'; failedFiles: readonly unknown[] }
  | { kind: 'invalid'; retry: boolean; reason: string }

interface RunFile {
  readonly file: string
  readonly status: string
  readonly message: string
  readonly tests: readonly { readonly name: string; readonly status: string }[]
}

interface Run {
  readonly report: unknown
  readonly files: readonly RunFile[] | null
  readonly exit: number | string | null
  readonly timedOut: boolean
}

const tool = require_(SCRIPT) as {
  EXIT: { ok: number; survivors: number; invalid: number }
  SCHEMA_VERSION: number
  Invalid: new (message: string) => Error
  specProblems: (doc: unknown) => string[]
  occurrences: (haystack: Buffer, needle: Buffer) => number
  mutate: (bytes: Buffer, find: string, replace: string) => Buffer
  filesOf: (report: unknown, root: string) => RunFile[] | null
  classify: (run: Run, listed: readonly string[], expected: ReadonlySet<string> | null) => Verdict
  parseArgs: (argv: readonly string[]) => {
    spec: string | null
    check: boolean
    retries: number
    retryWaitSeconds: number
    timeoutSeconds: number
  }
  main: (argv: readonly string[], round?: (spec: string, options: unknown) => number) => number
}

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

/** The smallest spec the tool accepts: one control, one real mutant. */
function validSpec(): Record<string, unknown> {
  return {
    schemaVersion: tool.SCHEMA_VERSION,
    package: 'fixture',
    about: 'add adds',
    tests: ['add.test.mjs'],
    mutants: [
      {
        id: 'control',
        control: true,
        file: 'mod.mjs',
        find: 'a comment the control edits',
        replace: 'a comment the control rewrote',
        why: 'a no-op: nothing a test can see'
      },
      { id: 'M1', file: 'mod.mjs', find: 'a + b', replace: 'a - b', why: 'add must add' }
    ]
  }
}

/** A valid spec with other mutants — `unknown`, so a case can hand it one that is not an object. */
const withMutants = (mutants: readonly unknown[]): Record<string, unknown> => ({
  ...validSpec(),
  mutants
})

describe('a spec is refused before anything runs', () => {
  it('accepts the smallest spec that has a control', () => {
    expect(tool.specProblems(validSpec())).toEqual([])
  })

  it('refuses a spec with no control (the first scratch-harness bug)', () => {
    const spec = withMutants([
      { id: 'M1', file: 'mod.mjs', find: 'a + b', replace: 'a - b', why: 'x' }
    ])
    expect(tool.specProblems(spec).join('\n')).toMatch(/no mutant is a control/)
  })

  it('refuses a misspelt control by name rather than reading it as absent', () => {
    const spec = withMutants([
      { id: 'c', contorl: true, file: 'mod.mjs', find: 'x', replace: 'y', why: 'z' }
    ])
    const problems = tool.specProblems(spec).join('\n')
    expect(problems).toMatch(/mutants\[0\] has unknown key "contorl"/)
    expect(problems).toMatch(/no mutant is a control/)
  })

  const mutant = (patch: Record<string, unknown>): Record<string, unknown> => ({
    id: 'M1',
    file: 'mod.mjs',
    find: 'a + b',
    replace: 'a - b',
    why: 'add must add',
    ...patch
  })
  const control = validSpec()['mutants'] as Record<string, unknown>[]

  it.each([
    ['a non-object spec', [], /not a JSON object/],
    ['an unknown top-level key', { ...validSpec(), target: 'mod.mjs' }, /unknown key "target"/],
    ['another schemaVersion', { ...validSpec(), schemaVersion: 2 }, /schemaVersion is 2/],
    ['no package', { ...validSpec(), package: ' ' }, /"package" must be a non-empty string/],
    ['no about', { ...validSpec(), about: undefined }, /"about" must be a non-empty string/],
    ['no tests', { ...validSpec(), tests: [] }, /"tests" must list at least one/],
    ['a test listed twice', { ...validSpec(), tests: ['a.test.mjs', 'a.test.mjs'] }, /twice/],
    ['no mutants', { ...validSpec(), mutants: [] }, /"mutants" must list at least one/],
    ['a mutant that is not an object', withMutants([control[0]!, 'M1']), /mutants\[1\] is not/],
    ['an id used twice', withMutants([control[0]!, mutant({ id: 'control' })]), /used twice/],
    ['an id with a space', withMutants([control[0]!, mutant({ id: 'M 1' })]), /\.id must be/],
    ['an empty find', withMutants([control[0]!, mutant({ find: '' })]), /\.find must be/],
    ['a missing replace', withMutants([control[0]!, mutant({ replace: 1 })]), /\.replace must/],
    [
      'a replace equal to its find',
      withMutants([control[0]!, mutant({ replace: 'a + b' })]),
      /changes nothing/
    ],
    ['no why', withMutants([control[0]!, mutant({ why: '' })]), /\.why must say/],
    ['a control that is not a boolean', withMutants([mutant({ control: 'yes' })]), /true or false/],
    ['an absolute path', withMutants([control[0]!, mutant({ file: '/etc/x' })]), /relative/],
    ['a drive path', withMutants([control[0]!, mutant({ file: 'C:/x.mjs' })]), /relative/],
    ['a backslash', withMutants([control[0]!, mutant({ file: 'src\\x.ts' })]), /forward slashes/],
    ['a step out', withMutants([control[0]!, mutant({ file: '../x.mjs' })]), /"\.\."/],
    ['a "." step', { ...validSpec(), tests: ['./add.test.mjs'] }, /"\.\."/],
    ['an empty step', { ...validSpec(), tests: ['test//a.test.mjs'] }, /"\.\."/],
    [
      'a test path vitest would read as an option',
      { ...validSpec(), tests: ['--testNamePattern=nomatch.test.mjs'] },
      /tests\[0\] .* has a part beginning with "-", which vitest would read as an option/
    ],
    [
      'a dash-led part deeper in a path',
      withMutants([control[0]!, mutant({ file: 'src/-x.mjs' })]),
      /beginning with "-"/
    ],
    [
      'a find in malformed Unicode (a lone surrogate)',
      withMutants([control[0]!, mutant({ find: "'\ud800'" })]),
      /\.find is not well-formed Unicode, so it would match text nobody wrote/
    ],
    [
      'a replace in malformed Unicode',
      withMutants([control[0]!, mutant({ replace: "'\udfff'" })]),
      /\.replace is not well-formed Unicode/
    ]
  ])('refuses %s', (_label, spec, problem) => {
    expect(tool.specProblems(spec).join('\n')).toMatch(problem)
  })
})

describe('an anchor must match exactly once, and the edit is byte-exact', () => {
  it('counts overlapping occurrences, so "matches once" cannot hide a second', () => {
    expect(tool.occurrences(Buffer.from('aaa'), Buffer.from('aa'))).toBe(2)
    expect(tool.occurrences(Buffer.from('abc'), Buffer.from('x'))).toBe(0)
  })

  it('refuses an anchor matching zero times (the second scratch-harness bug)', () => {
    expect(() => tool.mutate(Buffer.from('a + b'), 'a * b', 'a / b')).toThrow(
      /matches 0 times; it must match exactly once/
    )
  })

  it('refuses an anchor matching twice rather than editing one it did not choose', () => {
    expect(() => tool.mutate(Buffer.from('a + b; a + b'), 'a + b', 'a - b')).toThrow(
      /matches 2 times/
    )
  })

  it('changes only the anchor, leaving CRLF and non-ASCII bytes exactly as they were', () => {
    const before = Buffer.from('// ü\r\nexport const add = (a, b) => a + b\r\n', 'utf8')
    const after = tool.mutate(before, 'a + b', 'a - b')
    expect(after.toString('utf8')).toBe('// ü\r\nexport const add = (a, b) => a - b\r\n')
    expect(after.length).toBe(before.length)
  })
})

describe('a run is scored from its report and its tests, never from its exit code alone', () => {
  /** Where the fixture reports below say the repository is. */
  const ROOT = path.resolve('/fixture-repo')
  const at = (file: string): string => path.join(ROOT, file).split(path.sep).join('/')
  const test = (name: string, status: string): Record<string, unknown> => ({
    fullName: name,
    status
  })
  const file = (
    name: string,
    status: string,
    tests: readonly Record<string, unknown>[],
    message = ''
  ): Record<string, unknown> => ({
    name: at(name),
    status,
    message,
    assertionResults: tests
  })
  const report = (
    files: readonly Record<string, unknown>[],
    counts: { failed?: number; success?: boolean } = {}
  ): Record<string, unknown> => ({
    success: counts.success ?? (counts.failed ?? 0) === 0,
    numFailedTests: counts.failed ?? 0,
    testResults: files
  })
  /** A run as `runSuite` hands it over: the raw report, read through `filesOf`. */
  const run = (raw: unknown, exit: number | string | null = 0, timedOut = false): Run => ({
    report: raw,
    files: tool.filesOf(raw, ROOT),
    exit,
    timedOut
  })
  const listed = ['add.test.mjs']
  const green = report([file('add.test.mjs', 'passed', [test('adds', 'passed')])])
  const baselinePassed = new Set(['add.test.mjs › adds #1'])

  it('reads each file by its repository path, sorted, with its tests', () => {
    const raw = report([
      file('z/b.test.mjs', 'passed', [test('b', 'passed')]),
      file('a.test.mjs', 'failed', [], 'Parse failure: x')
    ])
    expect(tool.filesOf(raw, ROOT)).toEqual([
      {
        file: 'a.test.mjs',
        status: 'failed',
        message: 'Parse failure: x',
        tests: []
      },
      {
        file: 'z/b.test.mjs',
        status: 'passed',
        message: '',
        tests: [{ name: 'b', status: 'passed' }]
      }
    ])
    expect(tool.filesOf(null, ROOT)).toBeNull()
  })

  it('reads a run that wrote no report as a refusal to retry (a global setup that exits)', () => {
    expect(tool.classify(run(null, 1), listed, null)).toMatchObject({
      kind: 'invalid',
      retry: true
    })
  })

  it('reads a report holding no file as a refusal to retry (a global setup that throws, as the free-memory gate does)', () => {
    expect(tool.classify(run(report([], { success: false }), 1), listed, null)).toMatchObject({
      kind: 'invalid',
      retry: true,
      reason: expect.stringMatching(
        /^no test file ran: vitest wrote no report, or one holding no file/
      )
    })
  })

  it('reads a run that hit --timeout as INVALID with its own reason, and never retries it', () => {
    expect(tool.classify(run(null, 'SIGTERM', true), listed, null)).toEqual({
      kind: 'invalid',
      retry: false,
      reason: 'the run did not finish within --timeout'
    })
  })

  it('refuses a run that skipped a listed file, and does not retry it', () => {
    const raw = report([file('other.test.mjs', 'passed', [test('o', 'passed')])])
    expect(tool.classify(run(raw), listed, null)).toMatchObject({
      kind: 'invalid',
      retry: false,
      reason: 'listed test files did not run: add.test.mjs'
    })
  })

  it('refuses a run in which vitest also ran a file the spec does not list', () => {
    const raw = report([
      file('add.test.mjs', 'passed', [test('adds', 'passed')]),
      file('more/add.test.mjs', 'passed', [test('more', 'passed')])
    ])
    expect(tool.classify(run(raw), listed, null)).toMatchObject({
      kind: 'invalid',
      retry: false,
      reason: expect.stringMatching(
        /^vitest also ran files the spec does not list: more\/add\.test\.mjs/
      )
    })
  })

  it('scores a failing assertion as a test kill', () => {
    const raw = report([file('add.test.mjs', 'failed', [test('adds', 'failed')])], { failed: 1 })
    expect(tool.classify(run(raw, 1), listed, baselinePassed)).toMatchObject({
      kind: 'fail',
      how: 'test'
    })
  })

  it('scores a file that failed to load as a file kill, named so it is triaged', () => {
    const raw = report([file('add.test.mjs', 'failed', [], 'Parse failure: Expression expected')], {
      success: false
    })
    expect(tool.classify(run(raw, 1), listed, baselinePassed)).toMatchObject({
      kind: 'fail',
      how: 'file'
    })
  })

  it('refuses a report with no failure from a vitest that exited non-zero — an unhandled error or a dead worker', () => {
    // Measured on vitest 4.1.11: a worker the code under test kills leaves its
    // test `pending` in a report that says `success: true`, and vitest exits 1.
    const raw = report([file('add.test.mjs', 'passed', [test('adds', 'pending')])])
    expect(tool.classify(run(raw, 1), listed, baselinePassed)).toEqual({
      kind: 'invalid',
      retry: false,
      reason:
        'vitest exited 1 though its report holds no failure: an error outside any test, or a worker that died'
    })
  })

  it('refuses a failure vitest reports without naming a failing test or file', () => {
    const raw = report([file('add.test.mjs', 'passed', [test('adds', 'passed')])], {
      success: false
    })
    expect(tool.classify(run(raw), listed, null)).toMatchObject({
      kind: 'invalid',
      retry: false
    })
  })

  it('refuses a baseline in which a listed file holds no test that passed', () => {
    const raw = report([file('add.test.mjs', 'skipped', [test('adds', 'skipped')])])
    expect(tool.classify(run(raw), listed, null)).toEqual({
      kind: 'invalid',
      retry: false,
      reason:
        'add.test.mjs holds no test that passed: a file whose tests are all skipped, todo or filtered defends nothing'
    })
  })

  it('refuses a mutant run in which a test that passed at the baseline did not finish', () => {
    const raw = report([file('add.test.mjs', 'passed', [test('adds', 'skipped')])])
    expect(tool.classify(run(raw), listed, baselinePassed)).toMatchObject({
      kind: 'invalid',
      retry: false,
      reason: expect.stringMatching(
        /^1 test\(s\) that passed at the baseline did not pass or fail here, first add\.test\.mjs › adds #1/
      )
    })
  })

  it('passes a run in which every test that passed at the baseline passed again, and counts what did not run', () => {
    const raw = report([
      file('add.test.mjs', 'passed', [test('adds', 'passed'), test('later', 'todo')])
    ])
    const verdict = tool.classify(run(raw), listed, baselinePassed)
    expect(verdict).toMatchObject({ kind: 'pass', skipped: 1 })
    expect(verdict.kind === 'pass' && [...verdict.passed]).toEqual(['add.test.mjs › adds #1'])
  })

  it('tells same-named tests apart by their place, so one cannot stand in for another', () => {
    const raw = report([
      file('add.test.mjs', 'passed', [test('adds', 'passed'), test('adds', 'skipped')])
    ])
    const both = new Set(['add.test.mjs › adds #1', 'add.test.mjs › adds #2'])
    expect(tool.classify(run(raw), listed, both)).toMatchObject({
      kind: 'invalid',
      reason: expect.stringMatching(/first add\.test\.mjs › adds #2/)
    })
    expect(tool.classify(run(green), listed, null)).toMatchObject({
      kind: 'pass',
      skipped: 0
    })
  })
})

describe('the command line', () => {
  it('takes one spec and the documented defaults', () => {
    expect(tool.parseArgs(['s.json'])).toEqual({
      spec: 's.json',
      check: false,
      retries: 2,
      retryWaitSeconds: 30,
      timeoutSeconds: 900
    })
    expect(
      tool.parseArgs(['--check', 's.json', '--retries', '0', '--retry-wait', '5', '--timeout', '9'])
    ).toEqual({ spec: 's.json', check: true, retries: 0, retryWaitSeconds: 5, timeoutSeconds: 9 })
  })

  it.each([
    [[], /usage/],
    [['a.json', 'b.json'], /one spec per round/],
    [['a.json', '--force'], /unknown option --force/],
    [['a.json', '--retries', '-1'], /whole number/],
    [['a.json', '--timeout'], /whole number/]
  ])('refuses %j', (argv, message) => {
    expect(() => tool.parseArgs(argv)).toThrow(message)
  })

  it('reads a harness crash as INVALID with its stack, never as exit 1, which means survivors', () => {
    const printed: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      printed.push(line)
    })
    try {
      const status = tool.main(['s.json'], () => {
        throw new TypeError('a bug in the harness')
      })
      expect(status).toBe(tool.EXIT.invalid)
      expect(status).not.toBe(tool.EXIT.survivors)
      expect(printed.join('\n')).toMatch(
        /^ROUND INVALID — the harness failed: TypeError: a bug in the harness\n\s+at /
      )
    } finally {
      log.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// The real command over a real repository.
// ---------------------------------------------------------------------------

/** The fixture's own vitest config, written without importing vitest, which a temp directory cannot resolve. */
const CONFIG = (setup: boolean): string =>
  `export default { test: { globals: true, include: ['**/*.test.mjs']${setup ? ", globalSetup: ['./refuse.mjs']" : ''} } }\n`

/** CRLF endings and a non-ASCII byte, so a restore that is not byte-exact is caught. */
const MODULE = [
  'export const add = (a, b) => a + b',
  "export const unused = 'nobody reads this'",
  '// a comment the control edits — ü',
  ''
].join('\r\n')

const TEST = [
  "import fs from 'node:fs'",
  "import * as mod from './mod.mjs'",
  "test('adds', () => {",
  "  if (mod.marker === 'TOUCH') fs.appendFileSync(new URL('./mutation/round.json', import.meta.url), ' ')",
  "  if (mod.marker === 'REWRITE') fs.appendFileSync(new URL('./mod.mjs', import.meta.url), '// rewritten\\n')",
  "  if (mod.marker === 'LITTER') {",
  "    fs.mkdirSync(new URL('./more/', import.meta.url), { recursive: true })",
  "    fs.writeFileSync(new URL('./more/left.test.mjs', import.meta.url), \"test('left', () => { throw new Error('residue') })\\n\")",
  '  }',
  "  if (mod.marker === 'SPILL') fs.appendFileSync(new URL('./other.txt', import.meta.url), 'spilt\\n')",
  "  if (process.env['EPH_FIXTURE_TOUCH_SPEC']) fs.appendFileSync(new URL('./mutation/round.json', import.meta.url), ' ')",
  "  if (process.env['EPH_FIXTURE_WRITE_NEW']) fs.writeFileSync(new URL('./new.txt', import.meta.url), 'x')",
  '  expect(mod.add(2, 3)).toBe(5)',
  '})',
  ''
].join('\n')

/** M1 rewritten to export a `marker` the fixture's test acts on. */
const marking = (marker: string, why: string): Record<string, unknown> => ({
  id: 'M1',
  file: 'mod.mjs',
  find: "export const unused = 'nobody reads this'",
  replace: `export const unused = 'nobody reads this'; export const marker = '${marker}'`,
  why
})

/** The fixture's spec with M1 replaced. */
const specWith = (m1: Record<string, unknown>): Record<string, unknown> => {
  const spec = validSpec()
  ;(spec['mutants'] as Record<string, unknown>[])[1] = m1
  return spec
}

/**
 * A global setup that refuses the way `test/global-setup.ts` does — by
 * throwing — when the module carries `REFUSE`, or once when a flag directory
 * is named and holds no flag yet.
 */
const REFUSE = [
  "import fs from 'node:fs'",
  "import path from 'node:path'",
  'export default function () {',
  "  const flagDir = process.env['EPH_FIXTURE_REFUSE_ONCE']",
  '  if (flagDir) {',
  "    const flag = path.join(flagDir, 'refused')",
  '    if (!fs.existsSync(flag)) {',
  "      fs.writeFileSync(flag, '')",
  "      throw new Error('Not enough free memory to run this suite: 0.10 GB free')",
  '    }',
  '    return',
  '  }',
  "  if (fs.readFileSync(new URL('./mod.mjs', import.meta.url), 'utf8').includes('REFUSE')) {",
  "    throw new Error('Not enough free memory to run this suite: 0.10 GB free')",
  '  }',
  '}',
  ''
].join('\n')

/** Settings every fixture git call carries, so no machine-wide config reaches the fixture. */
const GIT_SETTINGS = [
  '-c',
  'user.name=fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false'
]

interface Fixture {
  readonly dir: string
  readonly git: (args: readonly string[]) => string
  readonly write: (file: string, text: string) => void
  readonly commit: () => void
}

/** A committed repository holding a module, its test and a round spec. */
function fixture(
  spec: Record<string, unknown>,
  options: { setup?: boolean; test?: string } = {}
): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-mutate-'))
  temps.push(dir)
  const git = (args: readonly string[]): string =>
    execFileSync('git', [...GIT_SETTINGS, ...args], { cwd: dir, encoding: 'utf8' })
  const write = (file: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
  const commit = (): void => {
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'fixture'])
  }
  git(['init', '-q', '-b', 'main'])
  // `-text`: the round's restore is `git checkout --`, and a machine-wide
  // `core.autocrlf=true` (this machine's system config) would rewrite the
  // fixture's bytes on checkout. The tool would rightly call that INVALID.
  write('.gitattributes', '* -text\n')
  write('.gitignore', 'node_modules/\n')
  write('vitest.config.mjs', CONFIG(options.setup === true))
  write('refuse.mjs', REFUSE)
  write('mod.mjs', MODULE)
  write('other.txt', 'a tracked file outside the round\n')
  write('add.test.mjs', options.test ?? TEST)
  write('mutation/round.json', `${JSON.stringify(spec, null, 2)}\n`)
  commit()
  return { dir, git, write, commit }
}

interface Round {
  readonly status: number | null
  readonly out: string
}

/**
 * The command as an author runs it, from outside this vitest: the worker's
 * own `VITEST*` variables and `NODE_OPTIONS` are not handed to the nested run.
 */
function round(dir: string, args: readonly string[] = [], env: Record<string, string> = {}): Round {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('VITEST') && key !== 'NODE_OPTIONS'
    )
  )
  const child = spawnSync(
    process.execPath,
    [SCRIPT, 'mutation/round.json', '--retries', '0', '--retry-wait', '0', ...args],
    { cwd: dir, encoding: 'utf8', env: { ...inherited, ...env }, timeout: 150_000 }
  )
  return { status: child.status, out: `${child.stdout}${child.stderr}` }
}

const ROUND_TIMEOUT = 180_000

describe('a round over a real repository', () => {
  it(
    'kills a mutant the tests can see, certifies the round with its control, and restores every byte',
    () => {
      const spec = validSpec()
      ;(spec['mutants'] as Record<string, unknown>[]).push({
        id: 'M3',
        file: 'mod.mjs',
        find: 'a + b',
        replace: 'a +* b',
        why: 'a module that cannot parse is still a kill, named as one'
      })
      const repo = fixture(spec)
      const before = fs.readFileSync(path.join(repo.dir, 'mod.mjs'))

      const result = round(repo.dir)

      expect(result.out).toMatch(/baseline: PASS — 1 file, 1 passed: add\.test\.mjs/)
      expect(result.out).toMatch(/control {2}control {2}SURVIVED — certifies the round/)
      expect(result.out).toMatch(/M1 {2}killed — 1 tests failed/)
      expect(result.out).toMatch(/M3 {2}killed — a test file failed without a failing test: \S/)
      expect(result.out).toMatch(
        /ROUND OK — 2 of 2 real mutants killed; the control survived\. Tests run: add\.test\.mjs/
      )
      expect(result.status).toBe(tool.EXIT.ok)
      expect(fs.readFileSync(path.join(repo.dir, 'mod.mjs')).equals(before)).toBe(true)
      expect(repo.git(['status', '--porcelain'])).toBe('')
    },
    ROUND_TIMEOUT
  )

  it(
    'stops on a survivor with exit 1 and the triage question it owes',
    () => {
      const spec = validSpec()
      const mutants = spec['mutants'] as Record<string, unknown>[]
      mutants.push({
        id: 'M2',
        file: 'mod.mjs',
        find: "'nobody reads this'",
        replace: "'still nobody'",
        why: 'no test reads `unused`'
      })
      const repo = fixture(spec)

      const result = round(repo.dir)

      expect(result.out).toMatch(/M2 {2}SURVIVED/)
      expect(result.out).toMatch(/SURVIVOR M2 \(mod\.mjs\): no test reads `unused`/)
      expect(result.out).toMatch(/Is this state reachable from outside the module/)
      expect(result.out).toMatch(/ROUND HAS SURVIVORS — 1 of 2 real mutants survived/)
      expect(result.status).toBe(tool.EXIT.survivors)
      expect(repo.git(['status', '--porcelain'])).toBe('')
    },
    ROUND_TIMEOUT
  )

  it('refuses a spec with no control, before the suite runs', () => {
    const repo = fixture(
      withMutants([{ id: 'M1', file: 'mod.mjs', find: 'a + b', replace: 'a - b', why: 'x' }])
    )

    const result = round(repo.dir)

    expect(result.out).toMatch(/ROUND INVALID — the spec is refused:[\s\S]*no mutant is a control/)
    expect(result.out).not.toMatch(/baseline/)
    expect(result.status).toBe(tool.EXIT.invalid)
  })

  it('refuses an anchor matching zero times, before the suite runs', () => {
    const spec = validSpec()
    ;(spec['mutants'] as Record<string, unknown>[])[1]!['find'] = 'a * b'
    const repo = fixture(spec)

    const result = round(repo.dir)

    expect(result.out).toMatch(
      /ROUND INVALID — every anchor must match exactly once:\s+M1: its anchor matches mod\.mjs 0 times/
    )
    expect(result.out).not.toMatch(/baseline/)
    expect(result.status).toBe(tool.EXIT.invalid)
  })

  it(
    'calls a suite that refuses to start INVALID, never a kill (the third scratch-harness bug)',
    () => {
      const spec = validSpec()
      ;(spec['mutants'] as Record<string, unknown>[])[1]!['replace'] = 'a + b /* REFUSE */'
      const repo = fixture(spec, { setup: true })

      const result = round(repo.dir)

      expect(result.out).toMatch(/baseline: PASS/)
      expect(result.out).toMatch(
        /ROUND INVALID — M1: no test file ran: vitest wrote no report, or one holding no file — the suite refused to start/
      )
      expect(result.out).not.toMatch(/M1 {2}killed/)
      expect(result.status).toBe(tool.EXIT.invalid)
      expect(repo.git(['status', '--porcelain'])).toBe('')
    },
    ROUND_TIMEOUT
  )

  it(
    'waits out a refusal and scores the run that answers',
    () => {
      const repo = fixture(validSpec(), { setup: true })
      const flags = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-mutate-flag-'))
      temps.push(flags)

      const result = round(repo.dir, ['--retries', '1'], { EPH_FIXTURE_REFUSE_ONCE: flags })

      expect(result.out).toMatch(
        /baseline: no test file ran: vitest wrote no report, or one holding no file — the suite refused to start[^\n]*retrying \(1 of 1\)/
      )
      expect(result.out).toMatch(/ROUND OK — 1 of 1 real mutants killed/)
      expect(result.status).toBe(tool.EXIT.ok)
    },
    ROUND_TIMEOUT
  )

  it(
    'stops before any mutant when the baseline is red',
    () => {
      const repo = fixture(validSpec(), {
        test: "import { add } from './mod.mjs'\ntest('adds', () => { expect(add(2, 3)).toBe(6) })\n"
      })

      const result = round(repo.dir)

      expect(result.out).toMatch(
        /ROUND INVALID — baseline: the suite is red before any mutant is applied/
      )
      expect(result.out).not.toMatch(/control {2}control/)
      expect(result.status).toBe(tool.EXIT.invalid)
    },
    ROUND_TIMEOUT
  )

  it(
    'makes a killed control void the whole round',
    () => {
      const spec = validSpec()
      const mutants = spec['mutants'] as Record<string, unknown>[]
      mutants[0] = { ...mutants[0], find: 'a + b', replace: 'a * b' }
      mutants[1] = { ...mutants[1], find: "'nobody reads this'", replace: "'x'" }
      const repo = fixture(spec)

      const result = round(repo.dir)

      expect(result.out).toMatch(/ROUND INVALID — control: the control was KILLED/)
      expect(result.status).toBe(tool.EXIT.invalid)
      expect(repo.git(['status', '--porcelain'])).toBe('')
    },
    ROUND_TIMEOUT
  )

  it('refuses a round in a tree that is not exactly what was committed, untracked files included', () => {
    const clean =
      /ROUND INVALID — the working tree must be clean before a round, untracked files included/
    const repo = fixture(validSpec())
    repo.write('mod.mjs', `${MODULE}// an uncommitted edit\r\n`)

    const dirty = round(repo.dir)

    expect(dirty.out).toMatch(new RegExp(`${clean.source}[\\s\\S]* M mod\\.mjs`))
    expect(dirty.out).not.toMatch(/baseline/)
    expect(dirty.status).toBe(tool.EXIT.invalid)

    repo.commit()
    repo.write('extra.test.mjs', "test('x', () => {})\n")
    const spec = { ...validSpec(), tests: ['add.test.mjs', 'extra.test.mjs'] }
    repo.write('mutation/round.json', `${JSON.stringify(spec, null, 2)}\n`)
    repo.git(['add', 'mutation/round.json'])
    repo.git(['commit', '-q', '-m', 'spec only'])

    const untracked = round(repo.dir)

    expect(untracked.out).toMatch(new RegExp(`${clean.source}[\\s\\S]*\\?\\? extra\\.test\\.mjs`))
    expect(untracked.status).toBe(tool.EXIT.invalid)

    // A file the round never names still blocks it: whatever the round later
    // finds changed in the tree, it must be able to say the round changed it.
    repo.write('mutation/round.json', `${JSON.stringify(validSpec(), null, 2)}\n`)
    repo.git(['add', 'mutation/round.json'])
    repo.git(['commit', '-q', '-m', 'spec back'])
    repo.write('scratch.txt', 'notes\n')

    const unrelated = round(repo.dir)

    expect(unrelated.out).toMatch(new RegExp(`${clean.source}[\\s\\S]*\\?\\? scratch\\.txt`))
    expect(unrelated.status).toBe(tool.EXIT.invalid)
  })

  it('refuses a round file git ignores, which git status never shows', () => {
    // Found by this tool's own first round (2026-10-03): with the tracked-file
    // question deleted, every case stayed green, because `git status` prints an
    // ordinary untracked file as `??` too. An ignored one it does not print at
    // all, so `ls-files` is the only check that sees it, and `git checkout --`
    // could not restore it.
    const repo = fixture({ ...validSpec(), tests: ['add.test.mjs', 'ignored.test.mjs'] })
    repo.write('.gitignore', 'node_modules/\nignored.test.mjs\n')
    repo.write('ignored.test.mjs', "test('ignored', () => {})\n")
    repo.commit()
    expect(repo.git(['status', '--porcelain'])).toBe('')

    const result = round(repo.dir)

    expect(result.out).toMatch(
      /ROUND INVALID — every round file must be committed, plainly tracked and inside the repository[\s\S]*not tracked by git: ignored\.test\.mjs/
    )
    expect(result.out).not.toMatch(/baseline/)
    expect(result.status).toBe(tool.EXIT.invalid)
  })

  it(
    'calls a round file that changes while the suite runs INVALID, the shape of a sync client replaying a file',
    () => {
      const spec = validSpec()
      ;(spec['mutants'] as Record<string, unknown>[])[1] = {
        id: 'M1',
        file: 'mod.mjs',
        find: "export const unused = 'nobody reads this'",
        replace: "export const unused = 'nobody reads this'; export const marker = 'TOUCH'",
        why: 'the test writes a round file when it sees this'
      }
      const repo = fixture(spec)

      const result = round(repo.dir)

      // The run's fault and the restore's both reach the reader: the restore
      // cannot put back a file it did not write, so the tree is not as committed.
      expect(result.out).toMatch(
        /ROUND INVALID — M1: mutation\/round\.json changed while the suite ran[^\n]*\n {2}and then M1: the restore did not hold \(mutation\/round\.json/
      )
      expect(result.out).not.toMatch(/M1 {2}(killed|SURVIVED)/)
      expect(result.status).toBe(tool.EXIT.invalid)
      expect(fs.readFileSync(path.join(repo.dir, 'mod.mjs'), 'utf8')).toBe(MODULE)
    },
    ROUND_TIMEOUT
  )

  it(
    'calls the mutated file itself changing while the suite runs INVALID, and still restores it',
    () => {
      const spec = validSpec()
      ;(spec['mutants'] as Record<string, unknown>[])[1] = {
        id: 'M1',
        file: 'mod.mjs',
        find: "export const unused = 'nobody reads this'",
        replace: "export const unused = 'nobody reads this'; export const marker = 'REWRITE'",
        why: 'the test rewrites the mutated file when it sees this'
      }
      const repo = fixture(spec)

      const result = round(repo.dir)

      expect(result.out).toMatch(/ROUND INVALID — M1: mod\.mjs changed while the suite ran/)
      expect(result.out).not.toMatch(/and then/)
      expect(result.status).toBe(tool.EXIT.invalid)
      expect(fs.readFileSync(path.join(repo.dir, 'mod.mjs'), 'utf8')).toBe(MODULE)
      expect(repo.git(['status', '--porcelain'])).toBe('')
    },
    ROUND_TIMEOUT
  )

  it(
    'calls a baseline that changes a round file INVALID before any mutant is written',
    () => {
      const repo = fixture(validSpec())

      const result = round(repo.dir, [], { EPH_FIXTURE_TOUCH_SPEC: '1' })

      expect(result.out).toMatch(/ROUND INVALID — the baseline run changed mutation\/round\.json/)
      expect(result.out).not.toMatch(/control {2}control/)
      expect(result.status).toBe(tool.EXIT.invalid)
    },
    ROUND_TIMEOUT
  )

  it(
    'calls a baseline that writes anywhere in the tree INVALID — a snapshot it creates would become its own oracle',
    () => {
      const repo = fixture(validSpec())

      const result = round(repo.dir, [], { EPH_FIXTURE_WRITE_NEW: '1' })

      expect(result.out).toMatch(/ROUND INVALID — the baseline run changed \?\? new\.txt/)
      expect(result.status).toBe(tool.EXIT.invalid)
    },
    ROUND_TIMEOUT
  )

  it(
    'refuses a run in which vitest also ran a file the spec does not list',
    () => {
      const repo = fixture(validSpec())
      // vitest reads a file argument as a filter, so `add.test.mjs` also
      // selects `more/add.test.mjs`; a score covers exactly what was listed.
      repo.write('more/add.test.mjs', "test('more', () => { expect(1).toBe(1) })\n")
      repo.commit()

      const result = round(repo.dir)

      expect(result.out).toMatch(
        /ROUND INVALID — baseline: vitest also ran files the spec does not list: more\/add\.test\.mjs/
      )
      expect(result.status).toBe(tool.EXIT.invalid)
    },
    ROUND_TIMEOUT
  )

  it(
    'calls a mutant that leaves a file behind INVALID, so the residue cannot kill the next mutant',
    () => {
      const spec = specWith(
        marking('LITTER', 'the test leaves a failing test file when it sees this')
      )
      ;(spec['mutants'] as Record<string, unknown>[]).push({
        id: 'M2',
        file: 'mod.mjs',
        find: "'nobody reads this'",
        replace: "'still nobody'",
        why: 'no test reads `unused`, so only a residue could kill this'
      })
      const repo = fixture(spec)

      const result = round(repo.dir)

      expect(result.out).toMatch(
        /ROUND INVALID — M1: \?\? more\/left\.test\.mjs changed while the suite ran/
      )
      expect(result.out).not.toMatch(/M[12] {2}killed/)
      expect(result.status).toBe(tool.EXIT.invalid)
    },
    ROUND_TIMEOUT
  )

  it(
    'calls a mutant that writes a tracked file outside the round INVALID',
    () => {
      const repo = fixture(
        specWith(marking('SPILL', 'the test writes other.txt when it sees this'))
      )

      const result = round(repo.dir)

      expect(result.out).toMatch(
        /ROUND INVALID — M1: {1,2}M other\.txt changed while the suite ran/
      )
      expect(result.status).toBe(tool.EXIT.invalid)
    },
    ROUND_TIMEOUT
  )

  it(
    'refuses a baseline that passes because every test in a listed file was skipped',
    () => {
      const skipped = [
        "import { add } from './mod.mjs'",
        "describe.skip('add', () => { test('adds', () => { expect(add(2, 3)).toBe(5) }) })",
        ''
      ].join('\n')
      const repo = fixture(validSpec(), { test: skipped })

      const result = round(repo.dir)

      expect(result.out).toMatch(
        /ROUND INVALID — baseline: add\.test\.mjs holds no test that passed: a file whose tests are all skipped/
      )
      expect(result.status).toBe(tool.EXIT.invalid)
    },
    ROUND_TIMEOUT
  )

  it(
    'calls a mutant that makes a defending test skip INVALID, not a survivor',
    () => {
      const skipping = [
        "import * as mod from './mod.mjs'",
        "test.skipIf(mod.marker === 'SKIP')('adds', () => { expect(mod.add(2, 3)).toBe(5) })",
        ''
      ].join('\n')
      const repo = fixture(specWith(marking('SKIP', 'the defending test skips itself')), {
        test: skipping
      })

      const result = round(repo.dir)

      expect(result.out).toMatch(
        /ROUND INVALID — M1: 1 test\(s\) that passed at the baseline did not pass or fail here, first add\.test\.mjs › adds #1/
      )
      expect(result.out).not.toMatch(/M1 {2}SURVIVED/)
      expect(result.status).toBe(tool.EXIT.invalid)
    },
    ROUND_TIMEOUT
  )

  it(
    'calls a mutant that kills the vitest worker INVALID, not a survivor',
    () => {
      const repo = fixture(
        specWith({
          id: 'M1',
          file: 'mod.mjs',
          find: 'a + b',
          replace: '(process.kill(process.pid), a + b)',
          why: 'the worker dies mid-test, leaving it pending in a report that says success'
        })
      )

      const result = round(repo.dir)

      expect(result.out).toMatch(
        /ROUND INVALID — M1: vitest exited \S+ though its report holds no failure/
      )
      expect(result.out).not.toMatch(/M1 {2}SURVIVED/)
      expect(result.status).toBe(tool.EXIT.invalid)
    },
    ROUND_TIMEOUT
  )

  it(
    'calls a baseline with an unhandled error red, though vitest reports every test passed',
    () => {
      const rejecting = [
        "import { add } from './mod.mjs'",
        "test('adds', () => {",
        "  void Promise.reject(new Error('a rejection nobody awaits'))",
        '  expect(add(2, 3)).toBe(5)',
        '})',
        ''
      ].join('\n')
      const repo = fixture(validSpec(), { test: rejecting })

      const result = round(repo.dir)

      expect(result.out).toMatch(
        /ROUND INVALID — baseline: vitest exited 1 though its report holds no failure/
      )
      expect(result.status).toBe(tool.EXIT.invalid)
    },
    ROUND_TIMEOUT
  )

  it(
    'calls a run that hits --timeout INVALID with its own reason, and does not retry it',
    () => {
      const hanging = [
        "import * as mod from './mod.mjs'",
        "test('adds', async () => {",
        "  if (mod.marker === 'HANG') await new Promise((resolve) => setTimeout(resolve, 60_000))",
        '  expect(mod.add(2, 3)).toBe(5)',
        '}, 120_000)',
        ''
      ].join('\n')
      const repo = fixture(specWith(marking('HANG', 'the test hangs when it sees this')), {
        test: hanging
      })

      const result = round(repo.dir, ['--timeout', '15', '--retries', '1'])

      expect(result.out).toMatch(/ROUND INVALID — M1: the run did not finish within --timeout/)
      expect(result.out).not.toMatch(/retrying/)
      expect(result.status).toBe(tool.EXIT.invalid)
      expect(fs.readFileSync(path.join(repo.dir, 'mod.mjs'), 'utf8')).toBe(MODULE)
    },
    ROUND_TIMEOUT
  )

  it('refuses a round file with a second hard link, which would carry the mutant out of the repository', () => {
    const repo = fixture(validSpec())
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-mutate-outside-'))
    temps.push(outside)
    const shared = path.join(outside, 'shared.mjs')
    fs.writeFileSync(shared, MODULE)
    fs.unlinkSync(path.join(repo.dir, 'mod.mjs'))
    fs.linkSync(shared, path.join(repo.dir, 'mod.mjs'))
    expect(repo.git(['status', '--porcelain'])).toBe('')

    const result = round(repo.dir)

    expect(result.out).toMatch(
      /ROUND INVALID — every round file must be committed[\s\S]*mod\.mjs has 2 hard links/
    )
    expect(result.out).not.toMatch(/baseline/)
    expect(fs.readFileSync(shared, 'utf8')).toBe(MODULE)
  })

  it('refuses a round file reached through a link on its path, and writes nothing outside', () => {
    const spec = validSpec()
    ;(spec['mutants'] as Record<string, unknown>[])[0]!['file'] = 'lib/mod.mjs'
    const repo = fixture(spec)
    repo.write('lib/mod.mjs', MODULE)
    repo.commit()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-mutate-outside-'))
    temps.push(outside)
    fs.writeFileSync(path.join(outside, 'mod.mjs'), MODULE)
    removeTempDir(path.join(repo.dir, 'lib'))
    fs.symlinkSync(outside, path.join(repo.dir, 'lib'), 'junction')

    const result = round(repo.dir)

    // Git for Windows reads a junction as the directory it stands for, so the
    // tree looks clean and the real-path check is what refuses; git elsewhere
    // sees a link where a directory was, so the clean-tree check refuses first.
    // Either way the round never starts and nothing outside is written.
    expect(result.out).toMatch(/ROUND INVALID — /)
    expect(result.out).not.toMatch(/baseline/)
    if (repo.git(['status', '--porcelain']) === '') {
      expect(result.out).toMatch(
        /lib\/mod\.mjs resolves to .*, outside the repository: a link on its path/
      )
    }
    expect(result.status).toBe(tool.EXIT.invalid)
    expect(fs.readFileSync(path.join(outside, 'mod.mjs'), 'utf8')).toBe(MODULE)
  })

  it('refuses a file whose edit git status cannot see, and leaves the edit alone', () => {
    const repo = fixture(validSpec())
    repo.git(['update-index', '--assume-unchanged', 'mod.mjs'])
    const edited = `${MODULE}export const uncommitted = 'work in progress'\r\n`
    repo.write('mod.mjs', edited)
    expect(repo.git(['status', '--porcelain'])).toBe('')

    const result = round(repo.dir)

    expect(result.out).toMatch(/mod\.mjs does not hold the bytes git has indexed/)
    expect(result.out).not.toMatch(/baseline/)
    expect(result.status).toBe(tool.EXIT.invalid)
    expect(fs.readFileSync(path.join(repo.dir, 'mod.mjs'), 'utf8')).toBe(edited)
  })

  it('refuses a file git is told not to look at, even when its bytes are what git indexed', () => {
    const repo = fixture(validSpec())
    repo.git(['update-index', '--skip-worktree', 'mod.mjs'])

    const result = round(repo.dir)

    expect(result.out).toMatch(/git is told not to look at mod\.mjs \(ls-files -v "S"/)
    expect(result.out).not.toMatch(/does not hold the bytes/)
    expect(result.status).toBe(tool.EXIT.invalid)
  })

  it('checks a spec and its anchors without running anything when asked', () => {
    const repo = fixture(validSpec())

    const result = round(repo.dir, ['--check'])

    expect(result.out).toMatch(/anchors: 2 of 2 match exactly once/)
    expect(result.out).toMatch(/CHECKED — the spec and its anchors are sound; nothing was run/)
    expect(result.out).not.toMatch(/baseline/)
    expect(result.status).toBe(tool.EXIT.ok)
  })

  it('refuses a spec path that does not exist, as INVALID rather than a crash', () => {
    const repo = fixture(validSpec())
    const child = spawnSync(process.execPath, [SCRIPT, 'mutation/missing.json'], {
      cwd: repo.dir,
      encoding: 'utf8'
    })
    expect(child.stdout).toMatch(/ROUND INVALID — no spec at mutation\/missing\.json/)
    expect(child.status).toBe(tool.EXIT.invalid)
  })
})
