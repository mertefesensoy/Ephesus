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
  | { kind: 'pass' }
  | { kind: 'fail'; how: 'test' | 'file'; failedFiles: readonly unknown[] }
  | { kind: 'invalid'; retry: boolean; reason: string }

const tool = require_(SCRIPT) as {
  EXIT: { ok: number; survivors: number; invalid: number }
  SCHEMA_VERSION: number
  Invalid: new (message: string) => Error
  specProblems: (doc: unknown) => string[]
  occurrences: (haystack: Buffer, needle: Buffer) => number
  mutate: (bytes: Buffer, find: string, replace: string) => Buffer
  classify: (report: unknown, listed: readonly string[], ran: readonly string[]) => Verdict
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
    ['an empty step', { ...validSpec(), tests: ['test//a.test.mjs'] }, /"\.\."/]
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

describe('a run is scored from its report, never from its exit code', () => {
  const file = (name: string, status: string, message = ''): Record<string, unknown> => ({
    name,
    status,
    message,
    assertionResults: []
  })
  const listed = ['add.test.mjs']

  it('reads a run that wrote no report as a refusal to retry (a global setup that exits)', () => {
    expect(tool.classify(null, listed, [])).toMatchObject({ kind: 'invalid', retry: true })
  })

  it('reads a report holding no file as a refusal to retry (a global setup that throws, as the free-memory gate does)', () => {
    const refused = { success: false, numTotalTests: 0, numFailedTests: 0, testResults: [] }
    expect(tool.classify(refused, listed, [])).toMatchObject({
      kind: 'invalid',
      retry: true,
      reason: expect.stringMatching(/no test file ran/)
    })
  })

  it('refuses a run that skipped a listed file, and does not retry it', () => {
    const report = {
      success: true,
      numTotalTests: 1,
      numFailedTests: 0,
      testResults: [file('other.test.mjs', 'passed')]
    }
    expect(tool.classify(report, listed, ['other.test.mjs'])).toEqual({
      kind: 'invalid',
      retry: false,
      reason: 'listed test files did not run: add.test.mjs'
    })
  })

  it('scores a failing assertion as a test kill', () => {
    const report = {
      success: false,
      numTotalTests: 1,
      numFailedTests: 1,
      testResults: [file('add.test.mjs', 'failed')]
    }
    expect(tool.classify(report, listed, listed)).toMatchObject({ kind: 'fail', how: 'test' })
  })

  it('scores a file that failed to load as a file kill, named so it is triaged', () => {
    const report = {
      success: false,
      numTotalTests: 0,
      numFailedTests: 0,
      testResults: [file('add.test.mjs', 'failed', 'Parse failure: Expression expected')]
    }
    expect(tool.classify(report, listed, listed)).toMatchObject({ kind: 'fail', how: 'file' })
  })

  it('refuses a run whose listed files hold no test', () => {
    const report = {
      success: true,
      numTotalTests: 0,
      numFailedTests: 0,
      testResults: [file('add.test.mjs', 'passed')]
    }
    expect(tool.classify(report, listed, listed)).toMatchObject({ kind: 'invalid', retry: false })
  })

  it('refuses a failure vitest reports without naming a failing test or file', () => {
    const report = {
      success: false,
      numTotalTests: 1,
      numFailedTests: 0,
      testResults: [file('add.test.mjs', 'passed')]
    }
    expect(tool.classify(report, listed, listed)).toMatchObject({ kind: 'invalid', retry: false })
  })

  it('passes a run where every listed file ran and every test passed', () => {
    const report = {
      success: true,
      numTotalTests: 1,
      numFailedTests: 0,
      testResults: [file('add.test.mjs', 'passed')]
    }
    expect(tool.classify(report, listed, listed)).toEqual({ kind: 'pass' })
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
  "  if (process.env['EPH_FIXTURE_TOUCH_SPEC']) fs.appendFileSync(new URL('./mutation/round.json', import.meta.url), ' ')",
  '  expect(mod.add(2, 3)).toBe(5)',
  '})',
  ''
].join('\n')

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

      expect(result.out).toMatch(/baseline: PASS — 1 file, 1 tests: add\.test\.mjs/)
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
      expect(result.out).toMatch(/ROUND INVALID — M1: no test file ran: the suite refused to start/)
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
        /baseline: no test file ran: the suite refused to start[^\n]*retrying \(1 of 1\)/
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

  it('refuses a round whose files are not committed, so git can restore them', () => {
    const repo = fixture(validSpec())
    repo.write('mod.mjs', `${MODULE}// an uncommitted edit\r\n`)

    const dirty = round(repo.dir)

    expect(dirty.out).toMatch(/ROUND INVALID — commit the round's files first[\s\S]*M mod\.mjs/)
    expect(dirty.status).toBe(tool.EXIT.invalid)

    repo.commit()
    repo.write('extra.test.mjs', "test('x', () => {})\n")
    const spec = { ...validSpec(), tests: ['add.test.mjs', 'extra.test.mjs'] }
    repo.write('mutation/round.json', `${JSON.stringify(spec, null, 2)}\n`)
    repo.git(['add', 'mutation/round.json'])
    repo.git(['commit', '-q', '-m', 'spec only'])

    const untracked = round(repo.dir)

    expect(untracked.out).toMatch(/untracked extra\.test\.mjs/)
    expect(untracked.status).toBe(tool.EXIT.invalid)
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
    'reports the test files that actually ran, not the ones it was given',
    () => {
      const repo = fixture(validSpec())
      // vitest reads a file argument as a filter, so `add.test.mjs` also
      // selects `more/add.test.mjs`: the score covers both, and must say so.
      repo.write('more/add.test.mjs', "test('more', () => { expect(1).toBe(1) })\n")
      repo.commit()

      const result = round(repo.dir)

      expect(result.out).toMatch(
        /baseline: PASS — 2 files, 2 tests: add\.test\.mjs, more\/add\.test\.mjs/
      )
      expect(result.out).toMatch(/Tests run: add\.test\.mjs, more\/add\.test\.mjs/)
      expect(result.status).toBe(tool.EXIT.ok)
    },
    ROUND_TIMEOUT
  )

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
