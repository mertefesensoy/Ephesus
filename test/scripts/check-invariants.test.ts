import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as prettier from 'prettier'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../tmpdir'

/**
 * The invariant tripwires (`scripts/check-invariants.cjs`), fed the cases they
 * must fail.
 *
 * Written for a blind spot measured on 2026-10-02. The single-committer rule
 * (ADR-0004) is a regex with `\s*` between the call's parenthesis and its
 * `'git'`, and it was tested one LINE at a time, so that `\s*` could never span
 * the line break Prettier puts there when a call is too long for one line.
 * `src/main/git.ts`'s own call has that shape: the rule had never once seen the
 * file its allowlist names, and the same call written anywhere else in `src/`
 * passed CI. The truncating-write and ledger-rewrite rules were blind the same
 * way; the other four hunt for spans the formatter never breaks.
 *
 * Two things keep these cases honest. Every wrapped fixture is checked to be
 * exactly what Prettier writes, so "nobody would write it like that" is no
 * answer: `npm run lint` would insist on it. And where a real file's git calls
 * are is decided by the TypeScript syntax tree, which shares no code with the
 * regex. It does ask the regex's own question — one of six function names,
 * called with the literal `'git'` — so agreement proves the regex reads every
 * call of that shape however the formatter lays it out, and nothing about the
 * shapes outside the question (a shell string, a path, an alias), which
 * GYM-009 catalogues.
 */

const require_ = createRequire(import.meta.url)
const SCRIPT = fileURLToPath(new URL('../../scripts/check-invariants.cjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const checker = require_(SCRIPT) as {
  GIT_ALLOWLIST: ReadonlySet<string>
  GIT_INVOCATION: RegExp
  fileFailures: (
    searchDir: string,
    rel: string,
    text: string,
    gitAllowlist?: ReadonlySet<string>
  ) => string[]
  invariantFailures: (gitAllowlist?: ReadonlySet<string>) => string[]
}

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

/** A source file, one string per line, ending in the newline Prettier ends it with. */
const lines = (...parts: readonly string[]): string => `${parts.join('\n')}\n`

const AGORA = path.join('src', 'main', 'agora.ts')
const GIT_TS = path.join('src', 'main', 'git.ts')

const GIT_WHY = 'git is invoked outside src/main/git.ts — ADR-0004 allows exactly one committer'
const LOG_WHY = 'truncating write to an append-only record — invariant §5 forbids rewriting it'
const LEDGER_WHY =
  'UPDATE/DELETE against cost_ledger — the ledger is append-only (invariant §5, ADR-0011)'

const failure = (rel: string, line: number, why: string): string => `${rel}:${String(line)}  ${why}`
const gitFailure = (rel: string, line: number): string => failure(rel, line, GIT_WHY)
/** The failures that are the single-committer rule's, and no other rule's. */
const gitFailures = (failures: readonly string[]): string[] =>
  failures.filter((entry) => entry.endsWith(`  ${GIT_WHY}`))
/** `<file>:<line>` of each failure — the part a reader acts on. */
const where = (failures: readonly string[]): string[] =>
  failures.map((entry) => entry.split('  ')[0] ?? '')

/*
 * The fixtures. Each wrapped one is Prettier's own output for a call too long
 * for one line (`the fixtures` below checks that), and each comment names the
 * line its rule must report.
 */

/** The call starts on line 4; its `'git'` is on line 5 — `src/main/git.ts`'s shape. */
const WRAPPED_GIT = lines(
  "import { execFile } from 'node:child_process'",
  '',
  'export function status(cwd: string, done: (out: string) => void): void {',
  '  execFile(',
  "    'git',",
  "    ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=dirty'],",
  '    { cwd, windowsHide: true },',
  '    (_err, stdout) => done(stdout)',
  '  )',
  '}'
)

/** The shape the rule always could see: line 4. */
const ONE_LINE_GIT = lines(
  "import { execFile } from 'node:child_process'",
  '',
  'export function status(cwd: string): void {',
  "  execFile('git', ['status'], { cwd }, () => undefined)",
  '}'
)

/** Two calls on line 4, one line to look at; a wrapped template-literal call starting on line 8. */
const MANY_GIT = lines(
  "import { execFileSync, spawnSync } from 'node:child_process'",
  '',
  'export function both(): string[] {',
  "  return [execFileSync('git', ['log']), execFileSync('git', ['status'])].map(String)",
  '}',
  '',
  'export function fetch(cwd: string): void {',
  '  spawnSync(',
  '    `git`,',
  "    ['fetch', '--prune', '--tags', '--recurse-submodules=on-demand', 'origin', 'main'],",
  "    { cwd, stdio: 'ignore' }",
  '  )',
  '}'
)

/** The write starts on line 5; the path it truncates is on line 6. */
const WRAPPED_LOG_WRITE = lines(
  "import fs from 'node:fs'",
  "import path from 'node:path'",
  '',
  'export function rewrite(home: string, entries: readonly object[]): void {',
  '  fs.writeFileSync(',
  "    path.join(home, 'agora', 'log.jsonl'),",
  "    entries.map((entry) => JSON.stringify(entry)).join('\\n'),",
  "    'utf8'",
  '  )',
  '}'
)

/**
 * SQL wrapped by hand, as `src/main/db.ts` wraps its own — Prettier never
 * touches a template literal's contents. `DELETE` is on line 5 with its table
 * on line 6; `UPDATE` is on line 11 with its table on line 12.
 */
const WRAPPED_LEDGER_SQL = lines(
  "import type Database from 'better-sqlite3'",
  '',
  'export function forget(db: Database.Database, agent: string): void {',
  '  db.prepare(',
  '    `DELETE',
  '       FROM cost_ledger WHERE agent = ?`',
  '  ).run(agent)',
  '}',
  '',
  'export function zero(db: Database.Database): void {',
  '  db.exec(`UPDATE',
  '    cost_ledger SET cost_usd = 0`)',
  '}'
)

/** The functions the rule names. */
const STARTERS = new Set(['execFile', 'execFileSync', 'exec', 'execSync', 'spawn', 'spawnSync'])

interface GitCall {
  /** The line the callee's name is on — where the rule's match starts. */
  readonly call: number
  /** The line its `'git'` argument is on. */
  readonly git: number
}

/**
 * Every call to one of `STARTERS` whose first argument is the literal `git`,
 * found by the syntax tree rather than by text. It is the rule's own question
 * asked of a different reader, so it settles whether the regex reads that shape
 * wherever the line breaks fall, and nothing wider (see the header).
 */
function gitCalls(file: string, text: string): GitCall[] {
  const kind = file.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : file.endsWith('.ts')
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const calls: GitCall[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee
        : ts.isPropertyAccessExpression(callee)
          ? callee.name
          : undefined
      const first = node.arguments[0]
      const literal =
        first !== undefined &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      if (name !== undefined && STARTERS.has(name.text) && literal && first.text === 'git') {
        calls.push({ call: lineOf(name), git: lineOf(first) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return calls
}

/** Each distinct line a set of calls starts on, as the rule should report them for `rel`. */
const gitFailuresFor = (rel: string, calls: readonly GitCall[]): string[] =>
  [...new Set(calls.map(({ call }) => call))].map((line) => gitFailure(rel, line))

const readRepo = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')

/** Every source file under `dir`, named as the checker names it: repo-relative, platform separators. */
function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((entry) => /\.(ts|tsx|mjs|cjs|js)$/.test(entry))
    .map((entry) => path.join(dir, entry))
}

describe('the single-committer rule reads the whole file (ADR-0004)', () => {
  it('fails a git call Prettier has wrapped, on the line the call starts', () => {
    expect(checker.fileFailures('src', AGORA, WRAPPED_GIT)).toEqual([gitFailure(AGORA, 4)])
  })

  it('still fails a git call that fits on one line', () => {
    expect(checker.fileFailures('src', AGORA, ONE_LINE_GIT)).toEqual([gitFailure(AGORA, 4)])
  })

  it('names every call in a file, each line once', () => {
    expect(checker.fileFailures('src', AGORA, MANY_GIT)).toEqual([
      gitFailure(AGORA, 4),
      gitFailure(AGORA, 8)
    ])
  })

  it('leaves test/ alone, where TEST-STRATEGY §6 wants real git in temp dirs', () => {
    const testFile = path.join('test', 'main', 'agora.test.ts')
    expect(checker.fileFailures('test', testFile, WRAPPED_GIT)).toEqual([])
    expect(checker.fileFailures('test', testFile, ONE_LINE_GIT)).toEqual([])
    // The directory the walk found the file in decides, never a parse of its
    // path: a parse would depend on the separator, and CI runs one platform.
    expect(checker.fileFailures('src', testFile, WRAPPED_GIT)).toEqual([gitFailure(testFile, 4)])
  })
})

describe('the real src/main/git.ts', () => {
  const real = readRepo(GIT_TS)
  const calls = gitCalls(GIT_TS, real)
  const wrapped = calls.filter(({ call, git }) => git > call)

  it('wraps its git call — the shape a rule read line by line cannot see', () => {
    // The premise of the two cases below, checked rather than assumed: they are
    // only a test of the wrapped shape while git.ts has one.
    expect(
      wrapped,
      'no git call in src/main/git.ts is wrapped any more, so "is seen" below now tests a one-line call. ' +
        'WRAPPED_GIT still covers the wrapped shape; update this premise rather than deleting it.'
    ).not.toEqual([])
    const sourceLines = real.split('\n')
    for (const { call } of wrapped) {
      expect(checker.GIT_INVOCATION.test(sourceLines[call - 1] ?? '')).toBe(false)
    }
  })

  it('is seen: the same text in any other file fails, on the lines its calls start', () => {
    expect(checker.fileFailures('src', AGORA, real)).toEqual(gitFailuresFor(AGORA, calls))
  })

  it('is allowed: at its own path it passes', () => {
    expect(checker.fileFailures('src', GIT_TS, real)).toEqual([])
  })
})

describe('this repository', () => {
  it('with the git allowlist emptied, names every git call the syntax tree finds, and nothing else', () => {
    const expected = ['src', 'shims', 'scripts']
      .flatMap(sourceFiles)
      .flatMap((rel) => gitFailuresFor(rel, gitCalls(rel, readRepo(rel))))
    // Not vacuous: the one committer is always among them.
    expect(expected.filter((entry) => entry.startsWith(`${GIT_TS}:`))).not.toEqual([])
    expect(
      gitFailures(checker.invariantFailures(new Set())).sort(),
      'the rule and the syntax tree disagree about where git is called. A line only the rule ' +
        'names is a comment or string quoting a git call: the gate refuses that outside an ' +
        'allowlisted file, so reword it. A line only the syntax tree names is a call the regex ' +
        'cannot see, which is a blind spot in the gate (GYM-009).'
    ).toEqual(expected.sort())
  })

  it('with the allowlist as written, passes the single-committer rule', () => {
    expect(gitFailures(checker.invariantFailures())).toEqual([])
  })
})

describe('the append-only rules read the whole file too (invariant §5)', () => {
  const file = path.join('src', 'main', 'ledger.ts')

  it('fails a writeFileSync whose log path Prettier moved to the next line', () => {
    expect(checker.fileFailures('src', file, WRAPPED_LOG_WRITE)).toEqual([
      failure(file, 5, LOG_WHY)
    ])
  })

  it('fails ledger SQL whose verb and table are on different lines', () => {
    expect(checker.fileFailures('src', file, WRAPPED_LEDGER_SQL)).toEqual([
      failure(file, 5, LEDGER_WHY),
      failure(file, 11, LEDGER_WHY)
    ])
  })

  it('still fails both on one line, and passes the writes that are legal', () => {
    const oneLine = lines(
      "fs.writeFileSync(path.join(home, 'log.jsonl'), '')",
      "db.exec('DELETE FROM cost_ledger')",
      "db.exec('update cost_ledger set cost_usd = 0')"
    )
    expect(checker.fileFailures('src', file, oneLine)).toEqual([
      failure(file, 1, LOG_WHY),
      failure(file, 2, LEDGER_WHY),
      failure(file, 3, LEDGER_WHY)
    ])
    // Appending is the one write the book of record allows, the fold cursor is
    // metadata meant to move, and another file may be rewritten however it likes.
    const legal = lines(
      'db.prepare(',
      '  `INSERT INTO cost_ledger (agent, session, model, day, in_tokens, out_tokens, cost_usd, source)',
      '   VALUES (@agent, @session, @model, @day, @inTokens, @outTokens, @costUsd, @source)`',
      ')',
      "db.prepare('UPDATE cost_fold_cursor SET offset = ? WHERE file = ?')",
      "fs.appendFileSync(path.join(home, 'log.jsonl'), line)",
      'fs.writeFileSync(',
      "  path.join(home, 'registry.json'),",
      '  JSON.stringify(registry)',
      ')'
    )
    expect(checker.fileFailures('src', file, legal)).toEqual([])
  })
})

describe('the per-line rules are where they were', () => {
  it('a floor model may not read the clock — except in a comment, and except in FloorCanvas.tsx', () => {
    const model = path.join('src', 'renderer', 'src', 'floor', 'pose.ts')
    const canvas = path.join('src', 'renderer', 'src', 'floor', 'FloorCanvas.tsx')
    const source = lines(
      '// the caller passes Date.now() in',
      'export const now = (): number => Date.now()'
    )
    expect(where(checker.fileFailures('src', model, source))).toEqual([`${model}:2`])
    expect(checker.fileFailures('src', canvas, source)).toEqual([])
  })

  it('only the bridge sends to the renderer, and the checker may name what it hunts', () => {
    const send = lines("win.webContents.send('agents:state', state)")
    const index = path.join('src', 'main', 'index.ts')
    expect(where(checker.fileFailures('src', index, send))).toEqual([`${index}:1`])
    expect(checker.fileFailures('src', path.join('src', 'main', 'ui-bridge.ts'), send)).toEqual([])
    expect(
      checker.fileFailures('scripts', path.join('scripts', 'check-invariants.cjs'), send)
    ).toEqual([])
  })

  it('only the Watch and the Herald read a credential from the environment', () => {
    // Assembled at run time: written out, this file would trip the rule it tests.
    const env = 'process' + '.env'
    // Line 2 is credential-NAMED, and still allowed: `EPH_*` is the harness's own.
    const reads = lines(`const token = ${env}.GH_TOKEN`, `const hook = ${env}.EPH_HOOK_TOKEN`)
    expect(where(checker.fileFailures('src', AGORA, reads))).toEqual([`${AGORA}:1`])
    const broker = path.join('src', 'main', 'watch', 'broker.ts')
    expect(checker.fileFailures('src', broker, reads)).toEqual([])
  })

  it('no file anywhere, test/ included, carries a secret-shaped string', () => {
    // Assembled from halves for the same reason (see test/shared/secret-shapes.test.ts).
    const leak = lines(`const key = '${'ghp' + '_'}abcdefghijklmnopqrstuvwxyz0123'`)
    const testFile = path.join('test', 'main', 'agora.test.ts')
    expect(where(checker.fileFailures('test', testFile, leak))).toEqual([`${testFile}:1`])
  })
})

/**
 * The environment a spawned checker gets: this one, minus `NODE_OPTIONS`. A
 * loader or flag there (a debugging terminal's `--require`, for one) makes Node
 * itself write to stderr, which these cases would read as the checker's own.
 */
function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env['NODE_OPTIONS']
  return env
}

/**
 * Under vitest's 30 s `testTimeout`, so a hung child fails here and says so,
 * rather than as an anonymous test timeout. The full checker takes about 2.5 s
 * on an idle machine; the margin is for a suite running every worker at once.
 */
const CHILD_TIMEOUT_MS = 20_000

describe('the CLI, run as CI runs it', () => {
  it('exits 0 over this repository', () => {
    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: childEnv(),
      timeout: CHILD_TIMEOUT_MS
    })
    expect(run.error).toBeUndefined()
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/^invariants ok \(src, shims, scripts, test; /)
  })

  it('exits 1 and names a wrapped call in the tree it is run in', () => {
    // The checker reads the tree it sits in, so a copy of scripts/ is run inside
    // a fixture tree, resolving `typescript` from this repository. Its own git
    // allowlist then holds for the copies of arm-hooks.cjs and
    // check-attribution.cjs, and test/ is left alone, exactly as in CI.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-invariants-'))
    temps.push(root)
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(root, 'scripts'), { recursive: true })
    for (const [rel, text] of [
      [AGORA, WRAPPED_GIT],
      [path.join('test', 'main', 'agora.test.ts'), WRAPPED_GIT]
    ] as const) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), text)
    }
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-invariants.cjs')], {
      cwd: root,
      encoding: 'utf8',
      env: childEnv({ NODE_PATH: path.join(REPO_ROOT, 'node_modules') }),
      timeout: CHILD_TIMEOUT_MS
    })
    expect(run.error).toBeUndefined()
    expect(run.status).toBe(1)
    const printed = run.stderr
      .split('\n')
      .filter((line) => line.startsWith('  '))
      .map((line) => line.slice(2))
    expect(gitFailures(printed)).toEqual([gitFailure(AGORA, 4)])
  })

  it('runs nothing when it is required rather than run', () => {
    const run = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(SCRIPT)})`], {
      encoding: 'utf8',
      env: childEnv(),
      timeout: CHILD_TIMEOUT_MS
    })
    expect(run.error).toBeUndefined()
    expect(run).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })
})

describe('the fixtures', () => {
  it('are what Prettier writes, so lint cannot keep these shapes out of the tree', async () => {
    const config = (await prettier.resolveConfig(path.join(REPO_ROOT, AGORA))) ?? {}
    const fixtures = { WRAPPED_GIT, ONE_LINE_GIT, MANY_GIT, WRAPPED_LOG_WRITE, WRAPPED_LEDGER_SQL }
    for (const [name, source] of Object.entries(fixtures)) {
      expect(await prettier.check(source, { ...config, parser: 'typescript' }), name).toBe(true)
    }
  })
})
