import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MIN_FREE_BYTES,
  SWEEP_OLDER_THAN_MS,
  headroomRefusal,
  requireHeadroom,
  sweepStaleTempDirs
} from './global-setup'
import { removeTempDir } from './tmpdir'

/**
 * The suite's own housekeeping, and the guard that keeps it honest.
 *
 * Written after an audit on 2026-09-07 found **3 279 `eph-*` directories —
 * 42 910 files across 24 405 directories — in `%TEMP%`**, accumulated since
 * 2026-08-26 on a disk that was 92% full. Nothing had failed; the suite had
 * simply been leaving six to eleven directories behind on every run for two
 * weeks, and nothing anywhere would ever have said so.
 *
 * One file was responsible for 1 391 of them by calling `mkdtempSync` and
 * removing nothing. That is a one-line mistake that no review caught and no
 * test could catch, which is the definition of a check worth making
 * structural — so the guard below fails the suite the next time somebody makes
 * it, instead of an audit finding it in a month.
 */

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) removeTempDir(home)
})

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-hygiene-'))
  homes.push(dir)
  return dir
}

/** Every file under `dir` whose name matches `names`, as repo-relative slash paths. */
function filesUnder(dir: string, names: RegExp, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) filesUnder(full, names, out)
    else if (names.test(entry.name)) out.push(full.split(path.sep).join('/'))
  }
  return out
}

/** Each file's text, keyed by its path. */
function sourcesOf(files: readonly string[]): ReadonlyMap<string, string> {
  return new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')] as const))
}

/*
 * # Which remover, and why it depends on git (2026-10-02)
 *
 * The guard first asked only that a file which makes a temp directory call a
 * remover, `removeTempDir(` or `rmSync(`. That let
 * `test/main/pacing-wakes.test.ts` tear down with
 * `fs.rmSync(dir, { recursive, force, maxRetries: 10, retryDelay: 50 })`, and on
 * linux CI (run 36924116592) the teardown threw ENOTEMPTY on `agora/.git`.
 * Node 20's synchronous `rmSync` lists a directory's children ONCE and then
 * retries only its `rmdir`, so one entry written after the listing spends the
 * whole ~2.75 s budget. The writer was git's own housekeeping: `git commit`
 * starts auto-maintenance, which on POSIX detaches and outlives the commit,
 * and a `git repack` was still writing `.git/objects/pack`. `removeTempDir`
 * lists the tree afresh on every attempt (`test/tmpdir.ts`).
 *
 * So a file that runs real git, by whatever route, may not remove a tree with
 * a raw recursive remove except as part of a test, and if it makes a temp
 * directory it must call `removeTempDir`. A removal is part of a test only when
 * every way it runs is from inside a test's registration: deleting a worktree
 * to see what the code does next is the test (`test/main/worktrees.test.ts`).
 * In a hook, a `finally`, a fixture, or a function one of those calls, it is
 * teardown; anywhere else — module or `describe` level — it is no test either.
 *
 * A file that never touches git keeps `rmSync`, on evidence rather than by
 * default. What defeats `rmSync` is something that outlives the test inside
 * its directory: a writer, or on Windows a process whose working directory it
 * is. Git is the one this suite cannot stop, because its housekeeping detaches
 * from the commit that started it, beyond anything a test can await. Checked on
 * 2026-10-02 against the four files that still tore down with `rmSync`: they
 * write synchronously, await every asynchronous read, never start a watcher's
 * timer, and run their one child through `execFileSync`, which has exited
 * before teardown begins. A file that leaves an asynchronous child running in
 * its temp directory WOULD need `removeTempDir`, and this guard does not look
 * for one: `tmpdir.test.ts` and `pin.ts` do exactly that on purpose, to measure
 * the pin, and a rule broad enough to catch it would punish the measurement.
 * That residual is recorded in
 * docs/implementations/2026-10-02-temp-hygiene-requires-remover.md.
 *
 * Every question is asked of the TypeScript syntax tree, as
 * `scripts/reachability.cjs` asks its own, and never of the text: a comment
 * that names `removeTempDir(` removes nothing, `import type` runs nothing, and
 * `'git push origin'` in a grant is data, not a command. A text match is
 * fooled by all three.
 */

/*
 * # One directory at a time, and the ones mkdtemp never made (2026-10-02)
 *
 * The rule above was a property of a FILE: one that made a temp directory had
 * to call a remover somewhere. That let four kinds of leak through, one of
 * them live:
 *
 * - `test/main/gates.test.ts` gave a `PromptStore` the home
 *   `path.join(os.tmpdir(), 'eph-prompts-<pid>')`. `read()` creates the home
 *   and seeds it, nothing removed it, and nine of them were in %TEMP% on
 *   2026-10-02 — invisible here, because no mkdtemp made them.
 * - `test/scenarios/company.ts` made every company's home and left removing it
 *   to `cleanupHomes()`, which each scenario file had to call. The call sat in
 *   an exported function, so the helper "called a remover" whether or not any
 *   scenario ever ran it.
 * - A `makeTempDir()` beside `removeTempDir` would have handed every directory
 *   it made to callers no file is judged for.
 * - A file that removed its first directory was excused every other.
 *
 * So each directory is now followed from the call that makes it — through
 * variables, the lists it is pushed into, and functions here that return it —
 * to a remover, and a remover counts only if this file RUNS it whenever the
 * directory is made: in the same function body, or from a test, a hook or
 * the file's top level. A removal in a function the file only exports, or
 * only keeps — a rig object's `close()`, a closure it returns — counts for
 * nothing: that is what moved `cleanupHomes()` into a module-level hook of
 * `company.ts`'s own, and the rigs' homes into lists their hooks empty. A
 * function that hands a directory back is judged at each of its calls, and
 * refused when no call here can be judged. Variables are told apart by scope,
 * through a type checker over the one file, because test after test declares
 * its own `const home`. And a path named on the temp root outside an mkdtemp
 * call is treated as a directory nothing removes, unless `UNMADE_TEMP_PATHS`
 * lists it, with how many times the file names it and why nothing is left
 * there. What this still cannot see is recorded in
 * docs/implementations/2026-10-02-temp-hygiene-blind-spots.md.
 */

/**
 * Every module outside `test/` that git can start through: the modules that
 * run git themselves, and — to a fixed point — every module that imports one
 * of those for its values. ADR-0004 keeps the list short, since
 * `src/main/git.ts` is the one place the application runs git, and the premise
 * test below re-derives it from the tree, so a new door is a failing test
 * rather than a blind spot.
 *
 * A test reaches a door the way it reaches any module: by importing it for its
 * values, itself or through a helper under `test/`, or, for a script, by
 * running it. That is what makes "constructs an Agora, calls `ensureRepo`,
 * uses `ExecGitRunner`" checkable without trusting spelling: none of them can
 * happen without an import of `src/main/agora.ts` or `src/main/git.ts`
 * somewhere in the test's own import graph, under whatever local name.
 */
const GIT_DOORS: readonly string[] = [
  'scripts/arm-hooks.cjs',
  'scripts/check-attribution.cjs',
  'src/main/agora.ts',
  'src/main/git.ts',
  'src/main/index.ts'
]
const DOORS = new Set(GIT_DOORS)

/** Paths on the temp root a file may name without mkdtemp: by file, then by name, how often and why. */
export type UnmadeTempPaths = Readonly<
  Record<string, Readonly<Record<string, { readonly sites: number; readonly why: string }>>>
>

/**
 * The paths a file under `test/` names on the temp root OUTSIDE an mkdtemp
 * call, each allowed because nothing is left there: the code under test only
 * reads it, compares against it, fails to reach it, or removes what it puts
 * there itself. Keyed by file, then by the name the guard reads off the path —
 * the pieces added to the root, `*` for anything computed, empty for the root
 * itself — with how many times the file names it, and why.
 *
 * Anything else is treated as a directory nothing removes. That is how
 * `test/main/gates.test.ts` came to give its `PromptStore` the home
 * `eph-prompts-<pid>`: `read()` creates the home and seeds it, and nine of them
 * were in %TEMP% on 2026-10-02, one per vitest worker that had run the file. A
 * premise test holds every entry to exactly as many paths as its file names,
 * so an entry neither outlives its paths nor covers a new one.
 */
export const UNMADE_TEMP_PATHS: UnmadeTempPaths = {
  'test/fakes/hook-stub-server.ts': {
    '*.sock': {
      sites: 1,
      why: 'the stub server listens on it on POSIX, and libuv unlinks a socket it bound when the server closes; on win32 the endpoint is a named pipe and this branch never runs'
    }
  },
  'test/global-setup.ts': {
    '': { sites: 1, why: 'the root the stale-directory sweep reads, which it never creates' }
  },
  'test/main/eventlog.test.ts': {
    'eph-nonexistent/log.jsonl': {
      sites: 1,
      why: 'a log that must not exist: read() of a missing file returns nothing and creates nothing'
    }
  },
  'test/main/repo-remotes.test.ts': {
    'eph-nope-does-not-exist': {
      sites: 1,
      why: 'a directory that must not exist: git cannot even start in it'
    }
  },
  'test/main/tmpdir.test.ts': {
    '': {
      sites: 1,
      why: 'the working directory of the writing child: the root itself, so the handle a process holds on its cwd cannot pin the directory the case measures; it writes only into directories the test made'
    }
  },
  'test/main/worktrees.test.ts': {
    'no-agora-here': {
      sites: 3,
      why: 'the Agora root Worktrees is told to refuse, which it only ever compares against'
    }
  },
  'test/scripts/check-coverage.test.ts': {
    '': {
      sites: 1,
      why: 'read for a .git/HEAD it does not have, and only when the test has no directory of its own'
    }
  },
  'test/shims/eph-recall.test.ts': {
    'eph-no-such.sock': {
      sites: 1,
      why: 'an endpoint nothing listens on, which the shim must fail to reach'
    }
  },
  'test/temp-hygiene.test.ts': {
    'eph-does-not-exist-at-all': { sites: 1, why: 'a root the sweep must survive not finding' }
  }
}

/** The doors a test reaches by running them: the git-starting scripts, by file name. */
const GIT_SCRIPTS = GIT_DOORS.filter((door) => !door.startsWith('src/')).map((door) =>
  path.posix.basename(door)
)

const TEMP_MAKERS = new Set(['mkdtempSync', 'mkdtemp'])
const RAW_REMOVERS = new Set(['rmSync', 'rm', 'rmdirSync', 'rmdir'])
const CHILD_PROCESS = new Set(['child_process', 'node:child_process'])
/** The modules a directory is made and removed through, and the one that names the temp root. */
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises'])
const OS_MODULES = new Set(['os', 'node:os'])
/** Where `removeTempDir` lives, so an import of it under another name still counts. */
const TMPDIR_HELPER = 'test/tmpdir.ts'
/** The environment variables a temp root is read from, as `s-secrets.test.ts` reads `TMPDIR`. */
const TEMP_ENV = new Set(['TMPDIR', 'TMP', 'TEMP'])
/** The calls that put a directory into a list: `homes.push(home)`, `homes.set(id, home)`. */
const COLLECTORS = new Set(['push', 'unshift', 'add', 'set'])
/** The calls that return the directory they are handed, by its real path. */
const REALPATH = new Set(['realpathSync', 'realpath'])
/** The operators a value passes through unchanged when it is the one chosen. */
const CHOOSERS = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken
])
/** The `child_process` functions that start a process. `fork` runs a module, by path. */
const RUNNERS = new Set([
  'execFile',
  'execFileSync',
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'fork'
])
/** The git program by name or path, or a command line that starts it (`exec`, or `shell: true`). */
const GIT_PROGRAM = /^(?:.*[\\/])?git(?:\.exe)?$/i
const GIT_COMMAND = /^\s*git(?:\s|$)/
/** The files a test can import here, and how a bundler spells them: `./x.js` names `x.ts`. */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs']

/**
 * Vitest 4.1's test API, read from `@vitest/runner` 4.1.11's source: the
 * modifiers a test's registration may carry, the fixture builders whose result
 * registers tests too, and the hooks. Only `test()` and `suite()` check that
 * they are not called inside a test; a hook is registered on the current suite
 * from wherever it is called, test bodies included, so whatever a hook runs is
 * teardown wherever it is registered. `describe` and `suite` hang off `test`
 * as well, and register no test.
 */
const TEST_MODIFIERS = new Set([
  'concurrent',
  'sequential',
  'skip',
  'only',
  'todo',
  'fails',
  'each',
  'for',
  'skipIf',
  'runIf'
])
const FIXTURE_BUILDERS = new Set(['extend', 'override', 'scoped'])
const HOOKS = new Set([
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'aroundEach',
  'aroundAll',
  'onTestFinished',
  'onTestFailed'
])

/** One way a file runs git, and where. */
export interface GitSighting {
  readonly how: string
  readonly line: number
  /** It starts git itself, running the program or a script that does, rather than importing a door. */
  readonly starts: boolean
}

/** What removes a temp directory: the helper, or a raw recursive remove. */
export type Remover = 'removeTempDir' | 'raw'

/** One temp directory a file makes, and what this file runs that removes it. */
export interface MadeDir {
  /** Where it is made: the mkdtemp call, or the call of a function here that returns one. */
  readonly line: number
  /** The function here that made it, when `line` is a call of one rather than mkdtemp's own. */
  readonly through: string | null
  /** The removers that run whenever it is made. Empty when nothing does. */
  readonly removedBy: readonly Remover[]
  /** Why nothing here answers for it, when the file says: a clause, or null. */
  readonly why: string | null
}

/** What becomes of one directory, gathered while following it through its file. */
interface Fate {
  readonly removedBy: Set<Remover>
  /** Named functions that would remove it, which nothing in the file runs. */
  readonly stranded: Set<string>
  /** Lists it went into that the file only takes one directory out of at a time, outside a loop. */
  readonly sampled: Set<string>
  /** Functions in the file that return it, whose calls are judged in its place. */
  readonly returnedBy: Set<ts.Node>
  /** Where it went that the file cannot answer for, as clauses, first found first. */
  readonly strays: string[]
  /** What a use of a variable holding it did that removes nothing, for the message alone. */
  readonly notes: string[]
}

/** A path a file builds on the temp root without mkdtemp, and what it names there. */
export interface TempPath {
  readonly line: number
  /** The pieces joined after the root, `*` for anything computed; empty for the root itself. */
  readonly name: string
}

/** What the rule needs to know about one file, read from its syntax tree. */
export interface HygieneReading {
  /** Every temp directory the file makes, in source order. */
  readonly made: readonly MadeDir[]
  /** Every path it builds on the temp root outside an mkdtemp call, in source order. */
  readonly tempPaths: readonly TempPath[]
  /** Every way the file runs git itself, in source order; empty when it does not. */
  readonly git: readonly GitSighting[]
  /** Raw recursive removals that are no part of a test, as `rmSync at line 39`. */
  readonly rawTeardowns: readonly string[]
  /** The modules it imports for their values, as written. */
  readonly imports: readonly string[]
}

/** Strips what changes an expression's type and never its value: `(x)`, `x!`, `x as T`, `x satisfies T`. */
function unwrap(node: ts.Expression): ts.Expression {
  let inner = node
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  ) {
    inner = inner.expression
  }
  return inner
}

/** The name a call is made by: `f(`, `a.b.f(` and `a['f'](` are all `f`. */
function nameOf(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return callee.argumentExpression.text
  }
  return null
}

/**
 * A callee's chain, root first: `it.skipIf(x).each(rows)` is `it` then
 * `skipIf, each`, and `` it.each`…` `` is `it` then `each`. The root is null
 * when the chain does not start at a name.
 */
function chainOf(callee: ts.Expression): {
  root: string | null
  members: string[]
} {
  const members: string[] = []
  let node = callee
  for (;;) {
    if (ts.isIdentifier(node)) return { root: node.text, members: members.reverse() }
    if (ts.isPropertyAccessExpression(node)) {
      members.push(node.name.text)
      node = node.expression
    } else if (ts.isCallExpression(node)) node = node.expression
    else if (ts.isTaggedTemplateExpression(node)) node = node.tag
    else return { root: null, members: members.reverse() }
  }
}

/** A string's text, or a template's text before its first substitution; null for anything else. */
function literalText(node: ts.Expression | undefined): string | null {
  if (node === undefined) return null
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text
  return null
}

/** The text of a literal piece of source — a string, or a part of a template — or null. */
function literalPiece(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) return node.text
  return null
}

/** The git-starting script a piece of a command line names as a path segment, or null. */
function gitScriptIn(piece: string): string | null {
  return piece.split(/[\s"'`\\/]+/).find((segment) => GIT_SCRIPTS.includes(segment)) ?? null
}

/**
 * Whether a removal can take a tree away. `recursive` is read the way the
 * object is built — a later key or spread overrides an earlier one — and
 * options it cannot read count as options that can, because a check that
 * passes whatever it could not read is a check that cannot fail. The one
 * exception is the callback in `fs.rm(path, () => {})`, plainly not options.
 */
function recursionOf(call: ts.CallExpression): 'yes' | 'no' | 'unread' {
  const given = call.arguments[1]
  if (given === undefined) return 'no'
  const options = unwrap(given)
  if (ts.isArrowFunction(options) || ts.isFunctionExpression(options)) return 'no'
  if (!ts.isObjectLiteralExpression(options)) return 'unread'
  let recursion: 'yes' | 'no' | 'unread' = 'no'
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      recursion = 'unread'
      continue
    }
    const name = property.name
    if (ts.isComputedPropertyName(name)) {
      recursion = 'unread'
      continue
    }
    if (name.text !== 'recursive') continue
    const value = ts.isPropertyAssignment(property) ? unwrap(property.initializer).kind : null
    recursion =
      value === ts.SyntaxKind.FalseKeyword
        ? 'no'
        : value === ts.SyntaxKind.TrueKeyword
          ? 'yes'
          : 'unread'
  }
  return recursion
}

/**
 * Whether an import or re-export carries types only, so running it runs
 * nothing: `import type`, or named bindings that are every one `type`.
 * The same reading `scripts/reachability.cjs` gives its edges.
 */
function carriesTypesOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    const clause = node.exportClause
    if (node.isTypeOnly) return true
    if (clause === undefined || !ts.isNamedExports(clause)) return false
    return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly)
  }
  const clause = node.importClause
  if (clause === undefined) return false
  if (clause.isTypeOnly) return true
  if (clause.name !== undefined) return false
  const bindings = clause.namedBindings
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return false
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)
}

/** The repo-relative files a relative specifier may name, as a bundler resolves it. */
function candidatesFor(from: string, specifier: string): readonly string[] {
  if (!specifier.startsWith('.')) return []
  const base = path.posix.join(path.posix.dirname(from), specifier)
  const stem = base.replace(/\.[cm]?js$/, '')
  return [
    ...EXTENSIONS.map((extension) => `${stem}${extension}`),
    ...EXTENSIONS.map((extension) => path.posix.join(base, `index${extension}`))
  ]
}

/** Whether `node` lies inside `ancestor`. */
function within(node: ts.Node, ancestor: ts.Node): boolean {
  for (let parent = node.parent as ts.Node | undefined; parent !== undefined;) {
    if (parent === ancestor) return true
    parent = parent.parent
  }
  return false
}

/**
 * The expression that receives `value`, climbing what hands a value on
 * unchanged: `await`, parentheses, a type assertion, either branch of `?:`,
 * either side of `??`, `||` or `&&` — so the directory in
 * `options.reuseHome ?? fs.mkdtempSync(…)` is the one the declaration holds —
 * and `realpathSync`, which names the same directory by its real path.
 */
function receiving(value: ts.Expression): ts.Expression {
  let held = value
  for (;;) {
    const parent = held.parent
    const handsOn =
      ts.isAwaitExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      (ts.isConditionalExpression(parent) && parent.condition !== held) ||
      (ts.isBinaryExpression(parent) && CHOOSERS.has(parent.operatorToken.kind)) ||
      (ts.isCallExpression(parent) &&
        parent.arguments[0] === held &&
        REALPATH.has(nameOf(parent.expression) ?? ''))
    if (!handsOn) return held
    held = parent
  }
}

/** The variable an expression is read from: `homes` in `homes.splice(0)`, `homes.pop()!` or `homes[0]`. */
function rootOf(expression: ts.Expression): ts.Identifier | null {
  let inner = unwrap(expression)
  while (
    ts.isPropertyAccessExpression(inner) ||
    ts.isElementAccessExpression(inner) ||
    ts.isCallExpression(inner)
  ) {
    inner = unwrap(inner.expression)
  }
  return ts.isIdentifier(inner) ? inner : null
}

/**
 * A type checker over `tree` alone, which is all it takes to tell one `home`
 * from another: a test file declares `const home = fs.mkdtempSync(…)` in test
 * after test, and only scope says which of them went into the list the
 * teardown empties. No library and no imports are loaded, so it binds names
 * and checks nothing.
 */
function checkerFor(tree: ts.SourceFile): ts.TypeChecker {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === tree.fileName ? tree : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === tree.fileName,
    readFile: () => undefined
  }
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true, types: [] }
  return ts.createProgram([tree.fileName], options, host).getTypeChecker()
}

/** One piece of a path joined onto the temp root: its text, with `*` for whatever is computed. */
function pieceOf(piece: ts.Expression): string {
  if (ts.isStringLiteralLike(piece)) return piece.text
  if (ts.isTemplateExpression(piece)) {
    return piece.head.text + piece.templateSpans.map((span) => `*${span.literal.text}`).join('')
  }
  return '*'
}

/**
 * Contract: pure. What `source` does with temp directories and with git, read
 * from its syntax tree. `fileName` is where it lives, repo-relative, which is
 * how its imports resolve, and chooses the dialect (`.tsx`, `.cjs`).
 *
 * It looks for CALLS, never for names. Written first as
 * `includes('removeTempDir')`, the guard survived the one mutation that
 * mattered: deleting a teardown's body leaves the `import { removeTempDir }`
 * line behind, so the file still "mentioned" the helper while removing
 * nothing. A shape check standing in for a semantic one is this repository's
 * oldest recurring defect, and it had reproduced inside the very test written
 * to prevent it.
 */
export function readHygiene(
  source: string,
  fileName = 'test/main/fixture.test.ts'
): HygieneReading {
  // JavaScript parses as TypeScript; only JSX needs telling apart.
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const lineOf = (node: ts.Node): number =>
    tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1

  // What the file's names are bound to: vitest's test API, child_process's
  // runners, and every use of every identifier, for the positions below.
  const vitest = new Map<string, string>()
  const vitestSpaces = new Set<string>()
  const runners = new Map<string, string>()
  const runnerSpaces = new Set<string>()
  const registrars = new Set(['it', 'test'])
  const uses = new Map<string, ts.Identifier[]>()
  const constants: ts.VariableDeclaration[] = []
  // The names the temp-directory functions go by here when imported under
  // another: `import { mkdtempSync as mk } from 'node:fs'` makes `mk(` a maker.
  const makerNames = new Set<string>()
  const rawNames = new Set<string>()
  const helperNames = new Set<string>()
  const rootNames = new Set<string>()

  /** Records a name a function this guard knows is imported under, from `from`. */
  const alias = (from: string, imported: string, local: string): void => {
    if (FS_MODULES.has(from) && TEMP_MAKERS.has(imported)) makerNames.add(local)
    if (FS_MODULES.has(from) && RAW_REMOVERS.has(imported)) rawNames.add(local)
    if (OS_MODULES.has(from) && imported === 'tmpdir') rootNames.add(local)
    if (imported === 'removeTempDir' && candidatesFor(fileName, from).includes(TMPDIR_HELPER)) {
      helperNames.add(local)
    }
  }

  const bind = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) uses.set(node.text, [...(uses.get(node.text) ?? []), node])
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const from = node.moduleSpecifier.text
      if (clause !== undefined && from === 'vitest') {
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          vitestSpaces.add(bindings.name.text)
        } else if (bindings !== undefined) {
          for (const element of bindings.elements) {
            vitest.set(element.name.text, (element.propertyName ?? element.name).text)
          }
        }
      } else if (clause !== undefined && !clause.isTypeOnly && CHILD_PROCESS.has(from)) {
        if (clause.name !== undefined) runnerSpaces.add(clause.name.text)
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          runnerSpaces.add(bindings.name.text)
        } else if (bindings !== undefined) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text
            if (RUNNERS.has(imported)) runners.set(element.name.text, imported)
          }
        }
      } else if (
        clause?.isTypeOnly === false &&
        bindings !== undefined &&
        ts.isNamedImports(bindings)
      ) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) {
            alias(from, (element.propertyName ?? element.name).text, element.name.text)
          }
        }
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const value = unwrap(node.initializer)
      const requiredFrom =
        ts.isCallExpression(value) && nameOf(value.expression) === 'require'
          ? literalText(value.arguments[0])
          : null
      if (requiredFrom !== null && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name
          if (ts.isIdentifier(key) && ts.isIdentifier(element.name)) {
            alias(requiredFrom, key.text, element.name.text)
          }
        }
      }
      const required = CHILD_PROCESS.has(requiredFrom ?? '')
      if (required && ts.isIdentifier(node.name)) runnerSpaces.add(node.name.text)
      if (required && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name
          if (ts.isIdentifier(key) && ts.isIdentifier(element.name) && RUNNERS.has(key.text)) {
            runners.set(element.name.text, key.text)
          }
        }
      }
      constants.push(node)
    }
    ts.forEachChild(node, bind)
  }
  bind(tree)

  /** The `child_process` function an expression stands for, or null. */
  const runnerOf = (expression: ts.Expression): string | null => {
    const node = unwrap(expression)
    if (ts.isIdentifier(node)) return runners.get(node.text) ?? null
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      runnerSpaces.has(node.expression.text) &&
      RUNNERS.has(node.name.text)
    ) {
      return node.name.text
    }
    return null
  }

  /** A callee's chain with vitest's renames and namespace read through: `spec` (for `it as spec`) and `vt.it` are `it`. */
  const resolve = (callee: ts.Expression): { root: string | null; members: string[] } => {
    const { root, members } = chainOf(callee)
    if (root !== null && vitestSpaces.has(root)) {
      return { root: members[0] ?? null, members: members.slice(1) }
    }
    return { root: root === null ? null : (vitest.get(root) ?? root), members }
  }

  /** Whether an expression is, or makes, a function that registers tests. */
  const registers = (expression: ts.Expression): boolean => {
    const node = unwrap(expression)
    if (ts.isConditionalExpression(node)) {
      return registers(node.whenTrue) && registers(node.whenFalse)
    }
    // A block body starts no chain, so `registers` says no to it on its own.
    if (ts.isArrowFunction(node)) return registers(node.body as ts.Expression)
    const { root, members } = resolve(node)
    return (
      registrars.has(root ?? '') &&
      members.every((member) => TEST_MODIFIERS.has(member) || FIXTURE_BUILDERS.has(member))
    )
  }

  // Names that stand for a runner or a registrar through a `const`, in source
  // order, since a `const` is declared before it is used: `promisify(execFile)`,
  // `it.runIf(ok)`, `ok ? it : it.skip`, `test.extend({…})`, aliases of those.
  for (const declaration of constants) {
    if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
    const value = unwrap(declaration.initializer)
    const wrapped = ts.isCallExpression(value) ? value.arguments[0] : undefined
    const runner = wrapped === undefined ? null : runnerOf(wrapped)
    if (ts.isCallExpression(value) && nameOf(value.expression) === 'promisify' && runner !== null) {
      runners.set(declaration.name.text, runner)
    }
    if (registers(value)) registrars.add(declaration.name.text)
  }

  /**
   * What a call does with what it is handed: registers a test, or registers
   * something to run around one — any vitest hook, or a `process` handler —
   * which is teardown even when it is registered inside the test.
   */
  const callKind = (call: ts.CallExpression): 'test' | 'teardown' | 'other' => {
    const { root, members } = resolve(call.expression)
    const head = root ?? ''
    if (HOOKS.has(head) || members.some((member) => HOOKS.has(member))) return 'teardown'
    if (head === 'process' && (members[0] === 'on' || members[0] === 'once')) return 'teardown'
    if (registrars.has(head) && members.every((member) => TEST_MODIFIERS.has(member))) {
      return 'test'
    }
    return 'other'
  }

  /**
   * The name a function is called by in this file: a declaration, a class
   * method, or an arrow or function expression held by a `const`. Functions
   * in object literals stay anonymous on purpose, so a fixture's callbacks are
   * judged by the call that receives the object.
   */
  const nameOfFunction = (node: ts.Node): string | null => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) return node.name.text
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      return ts.isClassLike(node.parent) ? node.name.text : null
    }
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return null
    return ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
      ? node.parent.name.text
      : null
  }

  const deciding = new Set<ts.Node>()

  /** Whether an identifier is a use of its name, rather than the declaration of one. */
  const isUse = (identifier: ts.Identifier): boolean => {
    const parent = identifier.parent
    if (ts.isPropertyAccessExpression(parent) || ts.isShorthandPropertyAssignment(parent)) {
      return true
    }
    return (parent as { name?: ts.Node }).name !== identifier
  }

  /**
   * A named function runs in a test when every use of it does, and is no part
   * of one when any use is not — or when nothing uses it but itself. A use met
   * again while deciding (two functions calling each other) decides nothing.
   */
  const functionInTest = (fn: ts.Node, name: string): boolean => {
    if (deciding.has(fn)) return true
    deciding.add(fn)
    const where = (uses.get(name) ?? []).filter((use) => isUse(use) && !within(use, fn))
    const found = where.length > 0 && where.every((use) => inTest(use))
    deciding.delete(fn)
    return found
  }

  /**
   * Whether `node` runs as part of a test. The first test registration, hook,
   * `finally` or named function it sits in decides; at the top of the file it
   * is no test.
   */
  function inTest(node: ts.Node): boolean {
    let child = node
    for (let parent = node.parent as ts.Node | undefined; parent !== undefined;) {
      if (ts.isTryStatement(parent) && parent.finallyBlock === child) return false
      if (ts.isCallExpression(parent)) {
        const kind = callKind(parent)
        if (kind === 'teardown') return false
        if (kind === 'test') return true
      }
      const name = nameOfFunction(child)
      if (name !== null) return functionInTest(child, name)
      child = parent
      parent = parent.parent
    }
    return false
  }

  /** Whether `node` is inside a call to a runner: what that runner is handed. */
  const inRunnerCall = (node: ts.Node): boolean => {
    for (let parent = node.parent as ts.Node | undefined; parent !== undefined;) {
      if (ts.isCallExpression(parent) && runnerOf(parent.expression) !== null) return true
      parent = parent.parent
    }
    return false
  }

  // What the walk collects for following each temp directory: every call that
  // makes one, every removal and its kind, every remover handed a whole list
  // (`homes.forEach(removeTempDir)`), and every path built on the temp root.
  const makes: ts.CallExpression[] = []
  const removals = new Map<ts.CallExpression, Remover>()
  const nonRemovals = new Map<ts.CallExpression, string>()
  const handedRemovers = new Set<ts.CallExpression>()
  const tempPaths: TempPath[] = []
  const git: GitSighting[] = []
  const rawTeardowns: string[] = []
  const imports: string[] = []

  const imported = (specifier: string, at: ts.Node): void => {
    imports.push(specifier)
    const door = candidatesFor(fileName, specifier).find((candidate) => DOORS.has(candidate))
    if (door !== undefined) git.push({ how: `imports ${door}`, line: lineOf(at), starts: false })
  }

  /** Whether a call makes a temp directory: mkdtemp by its name, or by a name it was imported under. */
  const isMaker = (call: ts.CallExpression): boolean =>
    TEMP_MAKERS.has(nameOf(call.expression) ?? '') ||
    (ts.isIdentifier(call.expression) && makerNames.has(call.expression.text))

  /** Whether an expression names the temp root: `os.tmpdir()` however it is reached, or `process.env.TMPDIR`. */
  const isTempRoot = (node: ts.Node): node is ts.Expression => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      return nameOf(callee) === 'tmpdir' || (ts.isIdentifier(callee) && rootNames.has(callee.text))
    }
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false
    const owner = unwrap(node.expression)
    return (
      TEMP_ENV.has(nameOf(node) ?? '') &&
      ts.isPropertyAccessExpression(owner) &&
      owner.name.text === 'env' &&
      ts.isIdentifier(owner.expression) &&
      owner.expression.text === 'process'
    )
  }

  /** Whether `node` is, or is part of, the prefix an mkdtemp call is handed. */
  const isPrefix = (node: ts.Node): boolean => {
    let child = node
    for (let parent = node.parent as ts.Node | undefined; parent !== undefined;) {
      if (ts.isCallExpression(parent) && isMaker(parent) && parent.arguments[0] === child)
        return true
      child = parent
      parent = parent.parent
    }
    return false
  }

  /**
   * The pieces a path adds to the temp root, `*` for anything computed, read
   * from `path.join`/`path.resolve`, a template (`${os.tmpdir()}/eph-x`) or a
   * `+` chain alike; empty when nothing is added — the root itself.
   */
  const nameUnderRoot = (root: ts.Expression): string => {
    const value = receiving(root)
    const parent = value.parent
    if (
      ts.isCallExpression(parent) &&
      parent.arguments[0] === value &&
      ['join', 'resolve'].includes(nameOf(parent.expression) ?? '')
    ) {
      return parent.arguments.slice(1).map(pieceOf).join('/')
    }
    let added = ''
    if (ts.isTemplateSpan(parent)) {
      const spans = parent.parent.templateSpans
      for (const span of spans.slice(spans.indexOf(parent))) {
        added += (span === parent ? '' : '*') + span.literal.text
      }
    }
    for (
      let left: ts.Expression = value;
      ts.isBinaryExpression(left.parent) &&
      left.parent.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      left.parent.left === left;
      left = left.parent
    ) {
      added += pieceOf(left.parent.right)
    }
    return added.replace(/^[/\\]+/, '')
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = nameOf(node.expression) ?? ''
      const local = ts.isIdentifier(node.expression) ? node.expression.text : ''
      const first = literalText(node.arguments[0])
      if (isMaker(node)) makes.push(node)
      if (name === 'removeTempDir' || helperNames.has(local)) {
        removals.set(node, 'removeTempDir')
      } else if (RAW_REMOVERS.has(name) || rawNames.has(local)) {
        const recursion = recursionOf(node)
        // Credited as a removal only when its options plainly say recursive,
        // and held against a git-running file whenever they might: a check
        // that gives the benefit of the doubt in either direction can pass
        // what it could not read.
        if (recursion === 'yes') removals.set(node, 'raw')
        else {
          nonRemovals.set(
            node,
            recursion === 'no'
              ? `it calls ${name} on it without recursive, which cannot remove a directory`
              : `it calls ${name} on it with options this guard cannot read as recursive: write recursive: true in the call`
          )
        }
        if (recursion !== 'no' && !inTest(node)) {
          const unread = recursion === 'unread' ? ' (options it cannot read)' : ''
          rawTeardowns.push(`${name} at line ${String(lineOf(node))}${unread}`)
        }
      }
      const handed = node.arguments.some(
        (argument) =>
          ts.isIdentifier(argument) &&
          (argument.text === 'removeTempDir' || helperNames.has(argument.text))
      )
      if (handed) handedRemovers.add(node)
      const runner = runnerOf(node.expression)
      if (
        runner !== null &&
        first !== null &&
        (GIT_PROGRAM.test(first) || GIT_COMMAND.test(first))
      ) {
        git.push({ how: `${runner}('git')`, line: lineOf(node), starts: true })
      }
      const importer =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        name === 'require' ||
        name === 'importActual' ||
        name === 'importMock'
      if (importer && first !== null) imported(first, node)
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const from = node.moduleSpecifier
      if (from !== undefined && ts.isStringLiteral(from) && !carriesTypesOnly(node)) {
        imported(from.text, node)
      }
    } else {
      const piece = literalPiece(node)
      const script = piece === null ? null : gitScriptIn(piece)
      if (script !== null && inRunnerCall(node)) {
        git.push({ how: `runs ${script}`, line: lineOf(node), starts: true })
      }
    }
    if (isTempRoot(node) && !isPrefix(node)) {
      tempPaths.push({ line: lineOf(node), name: nameUnderRoot(node) })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)

  let checker: ts.TypeChecker | undefined
  /**
   * The variable an identifier names, told apart by scope — the value's, for
   * the `home` in `{ home }`, which otherwise names the property. Built only
   * for a file that makes a directory.
   */
  const symbolOf = (identifier: ts.Identifier): ts.Symbol | undefined => {
    checker ??= checkerFor(tree)
    const parent = identifier.parent
    return ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(identifier)
  }

  /** The named function `node` runs in, or the file when it sits in none. */
  const homeOf = (node: ts.Node): ts.Node => {
    let home: ts.Node = node.parent
    while (!ts.isSourceFile(home) && nameOfFunction(home) === null) home = home.parent
    return home
  }

  /** The function whose own body `node` is in, named or not, or the file. */
  const bodyOf = (node: ts.Node): ts.Node => {
    let body: ts.Node = node.parent
    while (!ts.isSourceFile(body) && !ts.isFunctionLike(body)) body = body.parent
    return body
  }

  /** Whether an identifier only names its function for other files: `export { f }`, `export default f`. */
  const isExport = (identifier: ts.Identifier): boolean =>
    ts.isExportSpecifier(identifier.parent) || ts.isExportAssignment(identifier.parent)

  /**
   * The call a use of the named function `fn` takes part in: as its callee
   * (`cleanup()`), or handed to it whole (`afterAll(cleanupHomes)`). A method
   * is reached through a property (`rig.cleanup()`); any other function only
   * through its own name, as the checker binds it, so `server.close()` is no
   * call of a function `close`. Stored in an object, exported, or named in a
   * type, a function takes part in no call.
   */
  const callTaking = (
    use: ts.Identifier,
    fn: ts.Node
  ): { readonly call: ts.CallExpression; readonly called: boolean } | null => {
    const property = ts.isPropertyAccessExpression(use.parent) && use.parent.name === use
    if (property !== ts.isMethodDeclaration(fn)) return null
    const declared = ts.isFunctionDeclaration(fn) ? fn.name : fn.parent
    const named =
      declared !== undefined && ts.isVariableDeclaration(declared) ? declared.name : declared
    if (!property && (named === undefined || symbolOf(use) !== symbolOf(named as ts.Identifier))) {
      return null
    }
    const reference: ts.Node = property ? use.parent : use
    const call = reference.parent
    if (!ts.isCallExpression(call)) return null
    if (call.expression === reference) return { call, called: true }
    return call.arguments.some((argument) => argument === reference)
      ? { call, called: false }
      : null
  }

  const tracing = new Set<ts.Node>()

  /**
   * Whether the code in `home` runs when this file is loaded and its tests
   * run. The file's own top level does, and so does everything a hook, a
   * test or a `describe` is handed there. A named function does when a call
   * of it, or a call it is handed to, does — `afterAll(cleanupHomes)`. A
   * function this file only exports runs for other files, which is exactly
   * what this cannot see. A use met again while tracing — the function
   * calling itself, or two calling each other — decides nothing.
   */
  const runs = (home: ts.Node): boolean => {
    if (ts.isSourceFile(home)) return true
    const name = nameOfFunction(home)
    if (name === null || tracing.has(home)) return false
    tracing.add(home)
    const ran = (uses.get(name) ?? []).some(
      (use) => callTaking(use, home) !== null && runs(homeOf(use))
    )
    tracing.delete(home)
    return ran
  }

  /** Whether another file can call `fn`, the function named `name`. */
  const exported = (fn: ts.Node, name: string): boolean => {
    const declaration = ts.isFunctionDeclaration(fn) ? fn : fn.parent
    const flags =
      ts.isFunctionDeclaration(declaration) ||
      ts.isVariableDeclaration(declaration) ||
      ts.isClassDeclaration(declaration)
        ? ts.getCombinedModifierFlags(declaration)
        : ts.ModifierFlags.None
    return (flags & ts.ModifierFlags.Export) !== 0 || (uses.get(name) ?? []).some(isExport)
  }

  /** Every call of the named function `fn` in this file, as `callTaking` reads a call. */
  const callsOf = (fn: ts.Node): readonly ts.CallExpression[] =>
    (uses.get(nameOfFunction(fn) ?? '') ?? []).flatMap((use) => {
      const taking = callTaking(use, fn)
      return taking?.called === true ? [taking.call] : []
    })

  /**
   * Whether the file runs `node`: every function it sits in has to be run. An
   * anonymous function handed to a call or a `new` is taken to be run by it —
   * a hook, a test, `forEach`, a `Promise` executor, an IIFE — unless the call
   * only stores it (`push`, `add`, `set`); a named one runs when `runs` says
   * so; any other — a method of an object literal, a function returned or
   * assigned — is only kept, and nothing here shows it run. That is the shape
   * a rig's `close()` has, which removed its home only if the rig had also
   * been pushed onto the list a hook closes.
   */
  const executes = (node: ts.Node): boolean => {
    for (let fn = bodyOf(node); !ts.isSourceFile(fn); fn = bodyOf(fn)) {
      if (nameOfFunction(fn) !== null) return runs(fn)
      let reference: ts.Node = fn
      while (ts.isParenthesizedExpression(reference.parent)) reference = reference.parent
      const holder = reference.parent
      const handed =
        (ts.isCallExpression(holder) || ts.isNewExpression(holder)) &&
        (holder.expression === reference ||
          (holder.arguments?.some((argument) => argument === reference) === true &&
            !(
              ts.isPropertyAccessExpression(holder.expression) &&
              COLLECTORS.has(holder.expression.name.text)
            )))
      if (!handed) return false
    }
    return true
  }

  /**
   * A removal counts for a directory when it runs whenever the directory is
   * made: in the same function body, or from code this file runs. One that
   * only an exported function would run is stranded — the helper shape
   * `test/scenarios/company.ts` had, where every scenario had to remember to
   * call `cleanupHomes()` and deleting the call leaked every company home —
   * and so is one in a function the file only keeps.
   */
  const removes = (removal: ts.CallExpression, by: Remover, made: ts.Node, fate: Fate): void => {
    if (bodyOf(removal) === bodyOf(made) || executes(removal)) {
      fate.removedBy.add(by)
      return
    }
    const home = homeOf(removal)
    const name = nameOfFunction(home)
    fate.stranded.add(
      bodyOf(removal) === home && name !== null
        ? `only ${name} would remove it, and nothing in this file runs ${name}`
        : `only a function ${name ?? 'the file'} keeps — an object's method, or one stored or returned — would remove it, and nothing in this file is seen to run that`
    )
  }

  /** Whether `expression` reads from the list `list`: `homes.splice(0)`, `homes.pop()`, `homes[0]`. */
  const readsFrom = (expression: ts.Expression, list: ts.Symbol): boolean => {
    const root = rootOf(expression)
    return root !== null && symbolOf(root) === list
  }

  /** Whether `node` repeats within its own function: inside a `while`, a `do` or any `for`. */
  const inLoop = (node: ts.Node): boolean => {
    for (let parent = node.parent; !ts.isSourceFile(parent); parent = parent.parent) {
      if (ts.isFunctionLike(parent)) return false
      if (ts.isIterationStatement(parent, false)) return true
    }
    return false
  }

  /**
   * How much of `list` a remover's `target` takes: `whole` when it walks the
   * list (`for (const dir of homes.splice(0))`, `homes.forEach((dir) => …)`)
   * or reads from it in a loop (`while (homes.length) removeTempDir(homes.pop()!)`,
   * `const home = homes.pop()` inside one), `one` when it reads a single item
   * outside any loop, which leaves the rest behind; null when it is not from
   * the list at all.
   */
  const takenFrom = (target: ts.Expression, list: ts.Symbol): 'whole' | 'one' | null => {
    if (readsFrom(target, list)) return inLoop(target) ? 'whole' : 'one'
    const held = unwrap(target)
    const declaration = ts.isIdentifier(held) ? symbolOf(held)?.valueDeclaration : undefined
    if (declaration === undefined) return null
    if (ts.isVariableDeclaration(declaration)) {
      const loop = declaration.parent.parent
      if (ts.isForOfStatement(loop)) return readsFrom(loop.expression, list) ? 'whole' : null
      if (declaration.initializer === undefined || !readsFrom(declaration.initializer, list)) {
        return null
      }
      return inLoop(declaration) ? 'whole' : 'one'
    }
    const walker = declaration.parent
    const call = walker.parent
    const walks =
      ts.isParameter(declaration) &&
      ts.isCallExpression(call) &&
      call.arguments.some((argument) => argument === walker) &&
      ts.isPropertyAccessExpression(call.expression) &&
      readsFrom(call.expression.expression, list)
    return walks ? 'whole' : null
  }

  /** Follows a list a directory was put into, to every removal that empties it. */
  const followList = (
    receiver: ts.Expression,
    made: ts.Node,
    fate: Fate,
    seen: Set<ts.Symbol>
  ): void => {
    const root = rootOf(receiver)
    const list = root === null ? undefined : symbolOf(root)
    if (root === null || list === undefined) {
      fate.strays.push('it puts it in a list this guard cannot name')
      return
    }
    if (seen.has(list)) return
    seen.add(list)
    for (const [removal, by] of removals) {
      const target = removal.arguments[0]
      const taken = target === undefined ? null : takenFrom(target, list)
      if (taken === 'whole') removes(removal, by, made, fate)
      else if (taken === 'one') fate.sampled.add(root.text)
    }
    for (const call of handedRemovers) {
      const callee = call.expression
      if (ts.isPropertyAccessExpression(callee) && readsFrom(callee.expression, list)) {
        removes(call, 'removeTempDir', made, fate)
      }
    }
  }

  /** A function here that returns the directory: its calls are judged in its place, unless other files make them. */
  const followReturn = (held: ts.Node, fate: Fate): void => {
    let fn: ts.Node = held.parent
    while (!ts.isSourceFile(fn) && !ts.isFunctionLike(fn)) fn = fn.parent
    const name = nameOfFunction(fn)
    if (name === null) {
      fate.strays.push('it returns it from a function this guard cannot name')
      return
    }
    if (exported(fn, name)) {
      fate.strays.push(
        `${name} hands it to callers in other files, where this guard does not follow it: remove it here, from a module-level hook`
      )
    }
    fate.returnedBy.add(fn)
  }

  /** Follows a variable holding the directory to every use that removes it, lists it, returns it or copies it. */
  const followVariable = (
    name: ts.Identifier,
    made: ts.Node,
    fate: Fate,
    seen: Set<ts.Symbol>
  ): void => {
    const symbol = symbolOf(name)
    if (symbol === undefined || seen.has(symbol)) return
    seen.add(symbol)
    // Every identifier for the variable, its declaration and the left of each
    // `home = …` included: from those, `follow` finds nowhere to go.
    for (const use of uses.get(name.text) ?? []) {
      if (symbolOf(use) === symbol) follow(use, made, fate, seen, false)
    }
  }

  /**
   * Where the directory `value` holds goes next: into a variable, a list, a
   * remover or a `return`. `fresh` is true for the call that made it, the one
   * place where any other destination means it has gone where this cannot
   * follow; a variable's other uses (`path.join(home, 'x')`) just read it.
   */
  function follow(
    value: ts.Expression,
    made: ts.Node,
    fate: Fate,
    seen: Set<ts.Symbol>,
    fresh: boolean
  ): void {
    const held = receiving(value)
    const parent = held.parent
    if (ts.isVariableDeclaration(parent) && parent.initializer === held) {
      if (ts.isIdentifier(parent.name)) followVariable(parent.name, made, fate, seen)
      else if (fresh) fate.strays.push('it destructures it, which this guard does not follow')
    } else if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === held &&
      ts.isIdentifier(parent.left)
    ) {
      followVariable(parent.left, made, fate, seen)
    } else if (ts.isCallExpression(parent) && parent.arguments.some((arg) => arg === held)) {
      const by = removals.get(parent)
      const callee = parent.expression
      const notRemoving = nonRemovals.get(parent)
      if (by !== undefined) removes(parent, by, made, fate)
      else if (ts.isPropertyAccessExpression(callee) && COLLECTORS.has(callee.name.text)) {
        followList(callee.expression, made, fate, seen)
      } else if (notRemoving !== undefined) {
        fate.notes.push(notRemoving)
      } else if (fresh) {
        fate.strays.push(
          `it passes it to ${nameOf(callee) ?? 'a call'}(), where this guard cannot follow it`
        )
      }
    } else if (
      (ts.isReturnStatement(parent) && parent.expression === held) ||
      (ts.isArrowFunction(parent) && parent.body === held)
    ) {
      followReturn(held, fate)
    } else if (fresh && ts.isExpressionStatement(parent)) {
      fate.strays.push('it drops the path, so nothing can remove it')
    } else if (fresh) {
      fate.strays.push('it keeps it where this guard cannot follow it')
    } else if (keptInside(parent)) {
      fate.notes.push(
        'it keeps it in an object or an array, and this guard does not follow it out of one: put it in a list a hook empties'
      )
    }
  }

  /**
   * Whether `parent` puts a value into an object or array the file keeps —
   * declares, assigns, returns or pushes — as `rig = { home, close() … }`
   * does, rather than one handed to a call and dropped, as `{ cwd: home }` is.
   */
  function keptInside(parent: ts.Node): boolean {
    const literal =
      ts.isShorthandPropertyAssignment(parent) || ts.isPropertyAssignment(parent)
        ? parent.parent
        : parent
    if (!ts.isObjectLiteralExpression(literal) && !ts.isArrayLiteralExpression(literal)) {
      return false
    }
    const kept = receiving(literal)
    const holder = kept.parent
    return (
      ts.isVariableDeclaration(holder) ||
      ts.isReturnStatement(holder) ||
      (ts.isArrowFunction(holder) && holder.body === kept) ||
      (ts.isBinaryExpression(holder) && holder.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
      (ts.isCallExpression(holder) &&
        ts.isPropertyAccessExpression(holder.expression) &&
        COLLECTORS.has(holder.expression.name.text))
    )
  }

  const made: MadeDir[] = []
  const judged = new Set<ts.Node>()
  const through = new Map<ts.Node, string>()
  const pending = [...makes]
  // `pending` grows while it is read: a function here that returns a
  // directory nothing removes hands its judgement to each call of it.
  for (const make of pending) {
    if (judged.has(make)) continue
    judged.add(make)
    const fate: Fate = {
      removedBy: new Set(),
      stranded: new Set(),
      sampled: new Set(),
      returnedBy: new Set(),
      strays: [],
      notes: []
    }
    follow(make, make, fate, new Set(), true)
    // Judged at its calls only when the function does nothing with it but
    // hand it back: one that also lists it, or strands its removal, is
    // answered for here, where the reason is.
    const handedBackOnly =
      fate.returnedBy.size > 0 &&
      fate.removedBy.size === 0 &&
      fate.strays.length === 0 &&
      fate.stranded.size === 0 &&
      fate.sampled.size === 0
    if (handedBackOnly) {
      const calls = [...fate.returnedBy].map((fn) => [fn, callsOf(fn)] as const)
      const uncalled = calls.find(([, found]) => found.length === 0)?.[0]
      if (uncalled === undefined) {
        for (const [fn, found] of calls) {
          for (const call of found) through.set(call, nameOfFunction(fn) ?? 'a function')
          pending.push(...found)
        }
        continue
      }
      fate.strays.push(
        `${nameOfFunction(uncalled) ?? 'a function'} hands it back, and nothing in this file calls that: remove it where it is made, or from a module-level hook`
      )
    }
    const stranded = [...fate.stranded][0]
    const sampled = [...fate.sampled].join(' and ')
    made.push({
      line: lineOf(make),
      through: through.get(make) ?? null,
      removedBy: [...fate.removedBy].sort(),
      why:
        fate.strays[0] ??
        (stranded === undefined
          ? undefined
          : `${stranded}: remove it from a hook, or put it in a list a hook empties`) ??
        (sampled === ''
          ? undefined
          : `it takes one directory at a time out of ${sampled} outside a loop, so the rest are never removed`) ??
        fate.notes[0] ??
        null
    })
  }

  return {
    made: made.sort((a, b) => a.line - b.line),
    tempPaths,
    git,
    rawTeardowns,
    imports
  }
}

/** How a file reaches git, as a fault names it, or null when it does not. */
function gitVia(reading: HygieneReading, helpers: readonly string[]): string | null {
  const sighting = reading.git[0]
  if (sighting !== undefined) return `${sighting.how} at line ${String(sighting.line)}`
  return helpers.length === 0 ? null : `through ${helpers.join(' → ')}`
}

/**
 * Contract: pure. How `reading` breaks the rule, one sentence per fault; empty
 * when it keeps it. `helpers` is the chain of modules under `test/` the file
 * reaches git through, for a file that does not reach it itself, and `unmade`
 * how many times this file may build each name on the temp root without
 * mkdtemp (its entry in `UNMADE_TEMP_PATHS`).
 *
 * Judged one directory at a time, not one file: a file that removes its first
 * directory is not thereby excused a second it forgot.
 */
export function hygieneFaults(
  reading: HygieneReading,
  helpers: readonly string[] = [],
  unmade: ReadonlyMap<string, number> = new Map()
): readonly string[] {
  const via = gitVia(reading, helpers)
  const faults: string[] = []
  for (const dir of reading.made) {
    const at = `${String(dir.line)}${dir.through === null ? '' : ` (through ${dir.through}())`}`
    const why = dir.why === null ? '' : `: ${dir.why}`
    if (via === null && dir.removedBy.length === 0) {
      faults.push(
        `makes a temp directory at line ${at} and never removes it with removeTempDir or rmSync${why}`
      )
    } else if (via !== null && !dir.removedBy.includes('removeTempDir')) {
      faults.push(
        `runs real git (${via}) and never removes the temp directory it makes at line ${at} with removeTempDir${why}`
      )
    }
  }
  const allowed = new Map(unmade)
  for (const { line, name } of reading.tempPaths) {
    const left = allowed.get(name) ?? 0
    if (left > 0) {
      allowed.set(name, left - 1)
      continue
    }
    const what = name === '' ? 'the temp root itself' : `'${name}' on the temp root`
    faults.push(
      `names ${what} at line ${String(line)} outside an mkdtemp call: make the directory with mkdtemp, the root inside its prefix argument, or, if nothing is ever left there, list it in UNMADE_TEMP_PATHS with the reason`
    )
  }
  if (via === null) return faults
  for (const removal of reading.rawTeardowns) {
    faults.push(`runs real git (${via}) and removes a tree with ${removal}, outside a test body`)
  }
  return faults
}

/** What the rule decided about one file. */
export interface Judgement {
  /** How it reaches git (`imports src/main/agora.ts at line 6`, `through test/scenarios/company.ts`), or null. */
  readonly git: string | null
  /** Empty when the file keeps the rule. */
  readonly faults: readonly string[]
}

/**
 * Contract: pure. The rule's judgement of every file in `sources`
 * (repo-relative path → text) that makes a temp directory or reaches git.
 *
 * A file that runs no git itself can still reach it through a helper under
 * `test/` it imports: that is how the scenario files reach a real Agora through
 * `startCompany` without ever naming one. Helpers are followed through value
 * imports and re-exports, as deep as they go — and a file that reaches git is
 * judged whether or not it makes a temp directory, because the teardown that
 * failed on CI would fail the same way on a helper's directory. `unmade` is the
 * allowlist of paths built on the temp root without mkdtemp, by file.
 */
export function judgeTree(
  sources: ReadonlyMap<string, string>,
  unmade: UnmadeTempPaths = UNMADE_TEMP_PATHS
): ReadonlyMap<string, Judgement> {
  const readings = new Map<string, HygieneReading>()
  const readingOf = (file: string): HygieneReading | null => {
    const text = sources.get(file)
    if (text === undefined) return null
    const reading = readings.get(file) ?? readHygiene(text, file)
    readings.set(file, reading)
    return reading
  }
  const helpersOf = (file: string, seen: Set<string>): readonly string[] => {
    for (const specifier of readingOf(file)?.imports ?? []) {
      const helper = candidatesFor(file, specifier).find((candidate) => sources.has(candidate))
      if (helper === undefined || seen.has(helper)) continue
      seen.add(helper)
      if ((readingOf(helper)?.git.length ?? 0) > 0) return [helper]
      const deeper = helpersOf(helper, seen)
      if (deeper.length > 0) return [helper, ...deeper]
    }
    return []
  }
  const judged = new Map<string, Judgement>()
  for (const file of sources.keys()) {
    const reading = readingOf(file)
    if (reading === null) continue
    const helpers = helpersOf(file, new Set([file]))
    const via = gitVia(reading, helpers)
    if (reading.made.length === 0 && reading.tempPaths.length === 0 && via === null) continue
    const allowed = new Map(
      Object.entries(unmade[file] ?? {}).map(([name, { sites }]) => [name, sites] as const)
    )
    judged.set(file, { git: via, faults: hygieneFaults(reading, helpers, allowed) })
  }
  return judged
}

/** Contract: pure. The files `judgeTree` found breaking the rule, with their faults. */
export function treeFaults(
  sources: ReadonlyMap<string, string>
): ReadonlyMap<string, readonly string[]> {
  const faulty = [...judgeTree(sources)].filter(([, judged]) => judged.faults.length > 0)
  return new Map(faulty.map(([file, judged]) => [file, judged.faults]))
}

/**
 * Contract: pure. The modules in `modules` that git can start through: those
 * that run git themselves, and, to a fixed point, those that import one of
 * them for its values.
 */
export function doorsOf(modules: ReadonlyMap<string, string>): readonly string[] {
  const readings = [...modules].map(([file, text]) => [file, readHygiene(text, file)] as const)
  const doors = new Set(
    readings
      .filter(([, reading]) => reading.git.some((sighting) => sighting.starts))
      .map(([file]) => file)
  )
  for (let grew = true; grew;) {
    grew = false
    for (const [file, reading] of readings) {
      if (doors.has(file)) continue
      const opens = reading.imports.some((specifier) =>
        candidatesFor(file, specifier).some((candidate) => doors.has(candidate))
      )
      if (opens) {
        doors.add(file)
        grew = true
      }
    }
  }
  return [...doors].sort()
}

/** The rule applied to one source on its own, as a fixture is. */
function faultsIn(source: string): readonly string[] {
  return hygieneFaults(readHygiene(source))
}

/** Lines, joined: a fixture that reads like the file it stands for. */
const lines = (...source: string[]): string => source.join('\n')

/** The import a fixture that runs a child process needs, as a real file would have it. */
const CHILD =
  "import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process'"

/**
 * The teardown `test/main/pacing-wakes.test.ts` shipped with until 2026-10-02,
 * cut to the lines the rule reads and otherwise verbatim. It lost to a detached
 * `git repack` on linux CI (run 36924116592), and the guard as first written
 * accepted it because it called `rmSync(`. Kept as the case the guard must fail.
 */
const OLD_PACING_WAKES = lines(
  "import { Agora } from '../../src/main/agora'",
  'const temps: string[] = []',
  'const routers: Hermes[] = []',
  'const agoras: Agora[] = []',
  '',
  'afterEach(async () => {',
  '  for (const hermes of routers.splice(0)) hermes.stop()',
  '  for (const agora of agoras.splice(0)) await agora.drained().catch(() => {})',
  '  for (const dir of temps.splice(0)) {',
  '    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })',
  '  }',
  '})',
  '',
  'async function rig(): Promise<Rig> {',
  "  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-pace-'))",
  '  temps.push(home)',
  '  const agora = new Agora({',
  "    root: path.join(home, 'agora'),",
  "    prompts: new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS),",
  '    backoffMs: 1',
  '  })',
  '  await agora.ensureRepo()',
  '  agoras.push(agora)',
  '}'
)

const RULE = [
  'these files may leave a temp directory behind, or remove a tree git may still be writing into',
  'with a raw recursive remove. EVERY directory a file makes with mkdtemp must reach a remover the',
  'file itself runs, along a path this guard follows: a variable, a list a hook empties in a loop,',
  'or a function here that returns it — not an object, and not a closure the file keeps (a rig',
  "object's close()) rather than runs. A helper that makes one removes it from a module-level hook",
  '(test/conformance/adapter-conformance.ts, test/scenarios/company.ts), never leaving it to',
  'callers. A path named on the temp root outside an mkdtemp call is treated as a directory nothing',
  'removes: build it inside the mkdtemp prefix argument, or, if nothing is ever left there, list',
  'it in UNMADE_TEMP_PATHS with the reason. A file that runs real git must remove every temp',
  "directory it makes with removeTempDir (test/tmpdir.ts): rmSync's maxRetries retries the rmdir",
  'of a directory whose children it listed ONCE, so one entry a still-running git writes after',
  'that listing (a detached `git repack`, CI run 36924116592) spends the whole budget and throws',
  'ENOTEMPTY. Inside a test body a raw removal of something IN a temp directory is the test and',
  'stays allowed; the temp directory itself still goes through removeTempDir.'
].join(' ')

const PREMISE = [
  'the modules outside test/ that git can start through have changed. The hygiene guard decides',
  'which test files run real git by whether they reach one of these doors, so a door it does not',
  'know would let a test run git while the guard read it as never touching git. Update GIT_DOORS',
  '— and if a script is new, check that the tests running it name its file.'
].join(' ')

describe('a test that makes a temp directory takes it away again', () => {
  it('holds for every file in the tree', () => {
    // The guard. A temp directory with no removal is the defect this was
    // written for, and it is invisible in review because the missing thing is
    // a line nobody wrote. The git half is the defect it let through.
    const judged = judgeTree(sourcesOf(filesUnder('test', /\.(?:[cm]?[jt]s|tsx)$/)))
    const offenders = [...judged].filter(([, judgement]) => judgement.faults.length > 0)

    expect(Object.fromEntries(offenders.map(([file, { faults }]) => [file, faults])), RULE).toEqual(
      {}
    )

    // And not vacuously. A walk that found nothing, or resolution that broke on
    // real paths, would pass the line above having checked nothing, so the
    // rule must have SEEN git each way a test reaches it, and the measurement
    // must have been seen NOT to.
    expect(
      judged.get('test/main/pacing-wakes.test.ts')?.git,
      'the file this was written for'
    ).toMatch(/^imports src\/main\/agora\.ts/)
    expect(
      judged.get('test/scenarios/s-livelock.test.ts')?.git,
      'a file that reaches git only through a helper, and makes no temp directory itself'
    ).toBe('through test/scenarios/company.ts')
    expect(
      judged.get('test/scripts/check-attribution.test.ts')?.git,
      'a file that runs the git program itself'
    ).toMatch(/^execFileSync\('git'\)/)
    expect(judged.get('test/main/tmpdir.test.ts')?.git, 'the rmSync measurement').toBeNull()

    // And per directory, not per file: the walk found the directories the
    // files make, followed them to their removers, and found the paths on the
    // temp root nothing makes. `gates.test.ts` holds one of each kind of fix:
    // its policy files through a list, and its prompt home since 2026-10-02.
    const gates = readHygiene(
      fs.readFileSync('test/main/gates.test.ts', 'utf8'),
      'test/main/gates.test.ts'
    )
    expect(
      gates.made.map((dir) => dir.removedBy),
      'gates.test.ts'
    ).toEqual([['removeTempDir'], ['removeTempDir']])
    expect(gates.tempPaths, 'gates.test.ts').toEqual([])
    expect(judged.get('test/main/repo-remotes.test.ts')?.faults, 'an allowed path').toEqual([])
  })

  it('catches a file that makes a directory and removes nothing', () => {
    expect(faultsIn("const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-x-'))")).toEqual([
      'makes a temp directory at line 1 and never removes it with removeTempDir or rmSync'
    ])
  })

  it('is not satisfied by an IMPORT of the helper, only by a call', () => {
    // The mutation that defeated the first version of this guard, kept as its
    // regression: the teardown's body was deleted and the import stayed.
    const importedButUnused = lines(
      "import { removeTempDir } from '../tmpdir'",
      "const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-x-'))"
    )
    expect(faultsIn(importedButUnused)).toHaveLength(1)
  })

  it('is not satisfied by a COMMENT that names the helper either', () => {
    // The text-matching guard accepted this: `removeTempDir(` was in the file.
    const saidButNotDone = lines(
      '// removeTempDir(home) would wait out a writer; this does not',
      "const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-x-'))"
    )
    expect(faultsIn(saidButNotDone)).toHaveLength(1)
  })

  it('accepts a file that actually calls one of the two removers', () => {
    // Both directions, or the guard could pass by refusing everything.
    expect(faultsIn('const home = fs.mkdtempSync(x)\nremoveTempDir(home)')).toEqual([])
    expect(
      faultsIn('const home = fs.mkdtempSync(x)\nfs.rmSync(home, { recursive: true })')
    ).toEqual([])
  })

  it('says nothing about a file that makes no temp directory and runs no git', () => {
    expect(faultsIn('const x = 1')).toEqual([])
    const mentionOnly = lines(
      '// fs.mkdtempSync is named here, never called',
      'fs.rmSync(x, { recursive: true })'
    )
    expect(judgeTree(new Map([['test/main/a.test.ts', mentionOnly]])).size).toBe(0)
  })

  it('counts an asynchronous mkdtemp as a temp directory too, in a file and across the tree', () => {
    const asyncOnly = "const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'eph-x-'))"
    expect(faultsIn(asyncOnly)).toHaveLength(1)
    expect([...treeFaults(new Map([['test/main/a.test.ts', asyncOnly]])).keys()]).toEqual([
      'test/main/a.test.ts'
    ])
  })
})

describe('a file that runs real git removes its temp directories with removeTempDir', () => {
  it('fails the teardown pacing-wakes shipped with, which lost to a git repack on CI', () => {
    expect(faultsIn(OLD_PACING_WAKES)).toEqual([
      'runs real git (imports src/main/agora.ts at line 1) and never removes the temp directory it makes at line 15 with removeTempDir',
      'runs real git (imports src/main/agora.ts at line 1) and removes a tree with rmSync at line 10, outside a test body'
    ])
  })

  it('accepts the same file once its teardown calls removeTempDir', () => {
    const fixed = OLD_PACING_WAKES.replace(
      /\{\n\s*fs\.rmSync\(dir, [^\n]*\n\s*\}/,
      'removeTempDir(dir)'
    )
    // The replacement has to have happened, or this case passes on nothing.
    expect(fixed).toContain('for (const dir of temps.splice(0)) removeTempDir(dir)')
    expect(faultsIn(fixed)).toEqual([])
  })

  it('fails a file that removes one list with removeTempDir and another with rmSync', () => {
    // Calling the helper once is not removing every temp directory with it,
    // and since the rule went per directory it says so of the directory too.
    const mixed = lines(
      CHILD,
      'const repos: string[] = []',
      "const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-repo-'))",
      'repos.push(repo)',
      "execFileSync('git', ['init'], { cwd: repo })",
      'afterEach(() => {',
      '  for (const dir of homes.splice(0)) removeTempDir(dir)',
      '  for (const dir of repos.splice(0)) fs.rmSync(dir, { recursive: true, force: true })',
      '})'
    )
    expect(faultsIn(mixed)).toEqual([
      "runs real git (execFileSync('git') at line 5) and never removes the temp directory it makes at line 3 with removeTempDir",
      "runs real git (execFileSync('git') at line 5) and removes a tree with rmSync at line 8, outside a test body"
    ])
  })

  it('judges a file that reaches git through a helper even when the helper made the directory', () => {
    // The scenario files make no temp directory: `startCompany` does. The
    // teardown that failed on CI fails the same way on the company's home.
    const company = lines(
      "import { Agora } from '../../src/main/agora'",
      'const openHomes: string[] = []',
      "export async function startCompany() { const home = fs.mkdtempSync('x'); openHomes.push(home); return { home } }",
      'export function cleanupHomes(): void { for (const home of openHomes.splice(0)) removeTempDir(home) }',
      'afterAll(cleanupHomes)'
    )
    const scenario = (teardown: string): string =>
      lines(
        "import { cleanupHomes, startCompany } from './company'",
        'let company: { home: string }',
        `afterAll(async () => { ${teardown} })`
      )
    const faults = treeFaults(
      new Map([
        ['test/scenarios/company.ts', company],
        ['test/scenarios/s-kept.test.ts', scenario('cleanupHomes()')],
        [
          'test/scenarios/s-raw.test.ts',
          scenario(
            'fs.rmSync(company.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })'
          )
        ]
      ])
    )
    expect(Object.fromEntries(faults)).toEqual({
      'test/scenarios/s-raw.test.ts': [
        'runs real git (through test/scenarios/company.ts) and removes a tree with rmSync at line 3, outside a test body'
      ]
    })
  })

  it.each([
    ['an afterEach', 'afterEach(() => { fs.rmSync(dir, { recursive: true }) })'],
    ['a hook hung off test', 'test.afterEach(() => { fs.rmSync(dir, { recursive: true }) })'],
    ['a hook hung off it', 'it.afterAll(() => { fs.rmSync(dir, { recursive: true }) })'],
    [
      'a renamed hook',
      "import { afterEach as after } from 'vitest'\nafter(() => { fs.rmSync(dir, { recursive: true }) })"
    ],
    [
      "vitest's namespace",
      "import * as vt from 'vitest'\nvt.afterEach(() => { fs.rmSync(dir, { recursive: true }) })"
    ],
    [
      'a beforeEach clearing leftovers',
      'beforeEach(() => { fs.rmSync(dir, { recursive: true }) })'
    ],
    [
      'an aroundEach',
      'aroundEach(async (run) => { await run(); fs.rmSync(dir, { recursive: true }) })'
    ],
    [
      'onTestFinished inside a test',
      "it('x', ({ onTestFinished }) => { onTestFinished(() => fs.rmSync(dir, { recursive: true })) })"
    ],
    [
      'a finally inside a test',
      "it('x', () => { try { work() } finally { fs.rmSync(dir, { recursive: true }) } })"
    ],
    [
      'a fixture',
      'const repoTest = test.extend({ repo: async ({}, use) => { await use(dir); fs.rmSync(dir, { recursive: true }) } })'
    ],
    [
      "a builder fixture's cleanup",
      "test.extend('repo', async ({}, { onCleanup }) => { onCleanup(() => fs.rmSync(dir, { recursive: true })) })"
    ],
    [
      'a helper a hook calls',
      'function cleanup(): void { fs.rmSync(dir, { recursive: true }) }\nafterEach(cleanup)'
    ],
    [
      'a method a hook calls',
      'class Rig { cleanup(): void { fs.rmSync(this.dir, { recursive: true }) } }\nafterEach(() => rig.cleanup())'
    ],
    [
      'a helper called from a test AND a hook',
      "const drop = (d: string) => fs.rmSync(d, { recursive: true })\nit('x', () => drop(a))\nafterEach(() => drop(b))"
    ],
    [
      'a hook inside a describe hung off test',
      "test.describe('g', () => { afterAll(() => fs.rmSync(dir, { recursive: true })) })"
    ],
    ['the module itself', 'fs.rmSync(STALE, { recursive: true, force: true })'],
    [
      'a loop variable that happens to be called it',
      'afterEach(() => [repos].forEach((it) => it.forEach((d) => fs.rmSync(d, { recursive: true }))))'
    ],
    // The ones below sit inside a test, where the walk would otherwise stop at
    // the test and call them part of it.
    [
      "a test context's onTestFinished",
      "it('x', (ctx) => { ctx.onTestFinished(() => fs.rmSync(dir, { recursive: true })) })"
    ],
    [
      'a process exit handler',
      "it('x', () => { process.once('exit', () => fs.rmSync(dir, { recursive: true })) })"
    ],
    [
      'a process signal handler',
      "it('x', () => { process.on('SIGINT', () => fs.rmSync(dir, { recursive: true })) })"
    ],
    [
      'onTestFailed inside a test',
      "it('x', ({ onTestFailed }) => { onTestFailed(() => fs.rmSync(dir, { recursive: true })) })"
    ],
    [
      'a describe body hung off test',
      "test.describe('g', () => { fs.rmSync(dir, { recursive: true }) })"
    ],
    [
      'a remover reached by its name as a key',
      "afterEach(() => fs['rmSync'](dir, { recursive: true }))"
    ],
    [
      'a helper nothing calls but itself',
      'function spin(d: string): void { if (deep) spin(d); fs.rmSync(d, { recursive: true }) }'
    ],
    [
      'a fixture written as a method',
      "const repoTest = test.extend({ async repo({}, use) { await use(d); fs.rmSync(d, { recursive: true }) } })\nrepoTest('x', ({ repo }) => { use(repo) })"
    ],
    ['a helper nothing calls', 'function orphan(): void { fs.rmSync(d, { recursive: true }) }'],
    [
      'a helper a test calls and the module also hands out',
      "function vanish(): void { fs.rmSync(d, { recursive: true }) }\nit('x', () => vanish())\nconst helpers = { vanish }"
    ]
  ])('counts a raw removal in %s as teardown', (_where, source) => {
    expect(readHygiene(source).rawTeardowns).toHaveLength(1)
  })

  it.each(['beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'aroundEach', 'aroundAll'])(
    'counts a raw removal in a %s registered inside a test as teardown',
    (hook) => {
      // Vitest checks only `test()` and `suite()` for being called inside a
      // test, so a hook can be registered from one. Whatever vitest then does
      // with it, what the hook runs is no part of the test it sits in.
      const inside = `it('x', () => { ${hook}(() => fs.rmSync(dir, { recursive: true })) })`
      const hungOffTest = `it('x', () => { test.${hook}(() => fs.rmSync(dir, { recursive: true })) })`
      expect(readHygiene(inside).rawTeardowns).toHaveLength(1)
      expect(readHygiene(hungOffTest).rawTeardowns).toHaveLength(1)
    }
  )

  it.each([
    ['an it body', "it('x', () => { fs.rmSync(p, { recursive: true }) })"],
    ['a test body', "test('x', () => { fs.rmSync(p, { recursive: true }) })"],
    ['a skipIf body', "it.skipIf(!PIN)('x', () => { fs.rmSync(p, { recursive: true }) })"],
    [
      'a runIf each body',
      "it.runIf(ok).each([1, 2])('x %i', () => { fs.rmSync(p, { recursive: true }) })"
    ],
    [
      'a tagged-template table',
      "it.each`a\n${1}`('x', () => { fs.rmSync(p, { recursive: true }) })"
    ],
    [
      'a concurrent body',
      "test.concurrent('x', async () => { fs.rmSync(p, { recursive: true }) })"
    ],
    ['a wrapped body', "it('x', withRig(async (r) => { fs.rmSync(r.dir, { recursive: true }) }))"],
    [
      'an alias for a conditional registration',
      "const itWithGit = it.runIf(hasGit)\nitWithGit('x', () => { fs.rmSync(p, { recursive: true }) })"
    ],
    [
      'a conditional alias',
      "const itIf = ok ? it : it.skip\nitIf('x', () => { fs.rmSync(p, { recursive: true }) })"
    ],
    [
      'an alias factory',
      "const itIf = (ok: boolean) => (ok ? it : it.skip)\nitIf(true)('x', () => { fs.rmSync(p, { recursive: true }) })"
    ],
    [
      'a renamed it',
      "import { it as spec } from 'vitest'\nspec('x', () => { fs.rmSync(p, { recursive: true }) })"
    ],
    [
      "it through vitest's namespace",
      "import * as vt from 'vitest'\nvt.it('x', () => { fs.rmSync(p, { recursive: true }) })"
    ],
    [
      "an extended test's body",
      "const repoTest = test.extend({ repo: 'd' })\nrepoTest('x', () => { fs.rmSync(p, { recursive: true }) })"
    ],
    [
      'a body passed by name',
      "function vanish(): void { fs.rmSync(p, { recursive: true }) }\nit('x', vanish)"
    ],
    [
      'a helper only tests call',
      "function vanish(d: string): void { fs.rmSync(d, { recursive: true, force: true }) }\nit('a', () => vanish(a))\nit('b', () => { vanish(b) })"
    ],
    [
      'an arrow helper only tests call',
      "const vanish = (d: string) => fs.rmSync(d, { recursive: true })\nit('a', () => vanish(a))"
    ],
    [
      'a method only tests call',
      "class Rig { vanish(): void { fs.rmSync(this.dir, { recursive: true }) } }\nit('x', () => rig.vanish())"
    ],
    [
      'helpers the tests reach through each other',
      "function outer(): void { inner() }\nfunction inner(): void { outer(); fs.rmSync(d, { recursive: true }) }\nit('x', () => outer())"
    ],
    ['an it.skip body', "it.skip('x', () => { fs.rmSync(p, { recursive: true }) })"],
    ['an it.only body', "it.only('x', () => { fs.rmSync(p, { recursive: true }) })"],
    ['an it.todo body', "it.todo('x', () => { fs.rmSync(p, { recursive: true }) })"],
    ['an it.fails body', "it.fails('x', () => { fs.rmSync(p, { recursive: true }) })"],
    ['a sequential body', "test.sequential('x', () => { fs.rmSync(p, { recursive: true }) })"],
    ['an it.for body', "it.for([1])('x %i', () => { fs.rmSync(p, { recursive: true }) })"],
    [
      "an overridden test's body",
      "const t2 = test.override({ repo: 'd' })\nt2('x', () => { fs.rmSync(p, { recursive: true }) })"
    ],
    [
      "a scoped test's body",
      "const t3 = test.scoped({ repo: 'd' })\nt3('x', () => { fs.rmSync(p, { recursive: true }) })"
    ]
  ])('leaves %s its deliberate removals', (_where, source) => {
    // `worktrees.test.ts` deletes a worktree inside a test to see what the
    // code does next. That removal IS the test, however the test is written.
    expect(readHygiene(source).rawTeardowns).toEqual([])
  })

  it('reads a .tsx file as TSX, or a removal inside JSX would not parse as a call', () => {
    const source = lines(
      'afterEach(() => { render(<Panel onClose={() => fs.rmSync(dir, { recursive: true })} />) })',
      'const el = <div>{fs.rmSync(other, { recursive: true })}</div>'
    )
    expect(readHygiene(source, 'test/renderer/panel.test.tsx').rawTeardowns).toEqual([
      'rmSync at line 1',
      'rmSync at line 2'
    ])
  })

  it('counts rm, rmdir and rmdirSync too, the async and the deprecated removers', () => {
    const source = lines(
      'afterAll(async () => {',
      '  await fs.promises.rm(a, { recursive: true, force: true })',
      '  fs.rmdirSync(b, { recursive: true })',
      '  fs.rmdir(c, { recursive: true }, done)',
      '})'
    )
    expect(readHygiene(source).rawTeardowns).toEqual([
      'rm at line 2',
      'rmdirSync at line 3',
      'rmdir at line 4'
    ])
  })

  it('counts a removal whose options it cannot read as recursive, and says so', () => {
    const teardown = (call: string): readonly string[] =>
      readHygiene(`afterEach(() => ${call})`).rawTeardowns
    for (const unreadable of [
      'fs.rmSync(dir, OPTIONS)',
      'fs.rmSync(dir, { ...OPTIONS })',
      'fs.rmSync(dir, { recursive })',
      "fs.rmSync(dir, { ['recursive']: true })",
      'fs.rmSync(dir, { recursive: false, ...NUKE })',
      // An identifier could be options or `fs.rm`'s callback. It cannot tell, so it counts.
      'fs.rm(dir, done)'
    ]) {
      expect(teardown(unreadable), unreadable).toEqual([
        expect.stringMatching(/at line 1 \(options it cannot read\)$/)
      ])
    }
    expect(teardown('fs.rmSync(dir, { recursive: true })')).toEqual(['rmSync at line 1'])
    // And only those. Without `recursive`, a remove takes a file, never a tree.
    for (const fileOnly of [
      'fs.rmSync(lock, { recursive: false, force: true })',
      'fs.rmSync(lock, { ...QUIET, recursive: false })',
      'fs.rmSync(lock, { force: true } as fs.RmOptions)',
      'fs.rmSync(lock, { force: true, recursive: false } satisfies fs.RmOptions)',
      'fs.rmSync(lock, { recursive: false as const })',
      'fs.rmSync(lock, { force: true })',
      'fs.rmSync(lock)',
      'fs.rm(lock, () => {})'
    ]) {
      expect(teardown(fileOnly), fileOnly).toEqual([])
    }
  })

  it.each([
    ['imports the Agora', "import { Agora } from '../../src/main/agora'"],
    ['imports it under another name', "import { Agora as Store } from '../../src/main/agora'"],
    ['imports the runner', "import { ExecGitRunner } from '../../src/main/git'"],
    ['imports a door by its .js name', "import { readRemotes } from '../../src/main/git.js'"],
    ['imports a door dynamically', "const { ExecGitRunner } = await import('../../src/main/git')"],
    [
      'imports a door through vi.importActual',
      "const git = await vi.importActual('../../src/main/git')"
    ],
    [
      'imports a door through vi.importMock',
      "const git = await vi.importMock('../../src/main/git')"
    ],
    ['requires a door', "const git = require('../../src/main/git')"],
    ['imports a git script, which runs it', "import '../../scripts/arm-hooks.cjs'"],
    [
      'renames a runner',
      "import { execFileSync as run } from 'node:child_process'\nrun('git', ['init'])"
    ],
    [
      "imports child_process's default",
      "import cp from 'node:child_process'\ncp.execFileSync('git', ['init'])"
    ],
    [
      'requires child_process whole',
      "const cp = require('node:child_process')\ncp.spawnSync('git', ['init'])"
    ],
    [
      'imports child_process by its bare name',
      "import { execFileSync } from 'child_process'\nexecFileSync('git', ['init'])"
    ],
    [
      'forks a git script',
      "import { fork } from 'node:child_process'\nfork(path.join(ROOT, 'scripts', 'arm-hooks.cjs'))"
    ],
    ['runs git by execFileSync', `${CHILD}\nexecFileSync('git', ['init'], { cwd: home })`],
    ['runs git by spawn', `${CHILD}\nspawn('git', ['log'], { cwd: home })`],
    ['runs git by its path', `${CHILD}\nspawnSync('/usr/bin/git', ['init'], { cwd: home })`],
    [
      'runs git by its Windows path',
      `${CHILD}\nspawnSync('C:\\\\Program Files\\\\Git\\\\cmd\\\\Git.exe', ['init'])`
    ],
    ['runs git through a shell', `${CHILD}\nexecSync('git init -b main', { cwd: home })`],
    ['runs git through exec', `${CHILD}\nexec('git status', { cwd: home }, done)`],
    ['builds the shell command in a template', `${CHILD}\nexecSync(\`git -C \${home} init\`)`],
    [
      'writes the shell command across lines',
      `${CHILD}\nexecSync(\`\n  git init\n\`, { cwd: home })`
    ],
    ['runs git with shell: true', `${CHILD}\nexecFileSync('git init -q', { shell: true })`],
    ['names git in a template', `${CHILD}\nexecFile(\`git\`, ['status'], { cwd: home }, done)`],
    [
      'runs git through promisify',
      `${CHILD}\nimport { promisify } from 'node:util'\nconst run = promisify(execFile)\nawait run('git', ['init'])`
    ],
    [
      "runs git through child_process's namespace",
      "import * as cp from 'node:child_process'\ncp.execFileSync('git', ['init'])"
    ],
    [
      'runs git through require',
      "const { execFileSync: run } = require('node:child_process')\nrun('git', ['init'])"
    ],
    [
      'runs a script that runs git',
      `${CHILD}\nexecFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-attribution.cjs')])`
    ],
    [
      'builds the script path in a template',
      `${CHILD}\nspawnSync(process.execPath, [\`\${ROOT}/scripts/arm-hooks.cjs\`])`
    ],
    [
      'names the script mid-command',
      `${CHILD}\nexecSync(\`node "\${ROOT}/scripts/check-attribution.cjs" --pending\`, { cwd: dir })`
    ]
  ])('knows a file runs git when it %s', (_how, use) => {
    const source = lines(
      use,
      "const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-x-'))",
      'afterEach(() => fs.rmSync(home, { recursive: true, force: true }))'
    )
    expect(readHygiene(source).git).not.toEqual([])
    expect(faultsIn(source)).toHaveLength(2)
  })

  it.each([
    [
      'a grant that names a git command',
      "const grant = { run: 'git push -u origin agent/', prefix: true }"
    ],
    [
      'a comment that names the runner',
      '// a git child spawned by ExecGitRunner holds the directory'
    ],
    ['a block comment that names the Agora', '/* new Agora({ root }) runs `git init` */'],
    ['the Agora constructed with no import of it', 'const agora = new Agora({ root: home })'],
    [
      'the runner imported only as a type',
      "import type { ExecGitRunner } from '../../src/main/git'"
    ],
    ['the runner named only as a type', "import { type ExecGitRunner } from '../../src/main/git'"],
    ['a type-only re-export of a door', "export type { GitRunner } from '../../src/main/git'"],
    ['a program whose name starts with git', `${CHILD}\nexecFileSync('gitleaks', ['detect'])`],
    ['a shell command for another program', `${CHILD}\nexecSync('gitleaks detect', { cwd: home })`],
    [
      'a runner imported only as a type',
      "import type { execFileSync } from 'node:child_process'\nexecFileSync('git', ['init'])"
    ],
    [
      'a regular expression run on a git command',
      "const push = /^git push (\\S+)/.exec('git push -u origin agent/x')"
    ],
    [
      'a local function that shares a runner name',
      "const execFileSync = (...a: string[]) => a\nexecFileSync('git', ['init'])"
    ],
    ['a mocked runner', "vi.mock('../../src/main/git', () => ({ ExecGitRunner: class {} }))"],
    [
      'a git script named as data',
      "const GIT_ALLOWLIST = [path.join('scripts', 'check-attribution.cjs')]"
    ],
    [
      'a git script read, not run',
      "const text = fs.readFileSync(path.join(ROOT, 'scripts', 'arm-hooks.cjs'), 'utf8')"
    ],
    [
      'a script that runs no git',
      `${CHILD}\nexecFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-coverage.cjs')])`
    ],
    ['a module that is no door', "import { foldIncidents } from '../../src/shared/incident-view'"]
  ])('does not mistake %s for running git', (_what, mention) => {
    const source = lines(
      mention,
      "const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-x-'))",
      'afterEach(() => fs.rmSync(home, { recursive: true, force: true }))'
    )
    expect(readHygiene(source).git).toEqual([])
    expect(faultsIn(source)).toEqual([])
  })

  it('keeps rmSync for a file that never touches git, its measurements included', () => {
    // `tmpdir.test.ts` measures rmSync on purpose, and tears down with it
    // because the directories it pins are by construction still held. A guard
    // that punished either would be punishing the measurement.
    const measurement = lines(
      "import { removeTempDir } from '../tmpdir'",
      '// a `git` child spawned by `ExecGitRunner` is alive, so `rmdir` of the repository fails',
      'afterEach(() => {',
      '  for (const dir of temps.splice(0)) {',
      '    try {',
      '      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })',
      '    } catch {}',
      '  }',
      '})',
      "it('is not something rmSync will wait out', async () => {",
      "  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-pin-'))",
      '  expect(() =>',
      '    fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })',
      '  ).toThrow()',
      '})'
    )
    expect(readHygiene(measurement).git).toEqual([])
    expect(faultsIn(measurement)).toEqual([])
  })

  it('reads the files that measure rmSync on purpose as files that never touch git', () => {
    // The same claim, on the files themselves rather than a copy of their shape.
    for (const file of ['test/main/tmpdir.test.ts', 'test/pin.ts', 'test/tmpdir.ts']) {
      expect(readHygiene(fs.readFileSync(file, 'utf8'), file).git, file).toEqual([])
    }
  })

  it('follows a helper that reaches git into every file that imports it, however it is named', () => {
    const teardownByRmSync = (from: string): string =>
      lines(
        from,
        "const home = fs.mkdtempSync('x')",
        'afterEach(() => fs.rmSync(home, { recursive: true, force: true }))'
      )
    const faults = treeFaults(
      new Map([
        ['test/scenarios/company.ts', "import { Agora } from '../../src/main/agora'"],
        ['test/scenarios/relay.ts', "export { startCompany } from './company'"],
        ['test/helpers/index.ts', "export { startCompany } from '../scenarios/company'"],
        // Relays that carry only types, so importing them runs nothing.
        ['test/scenarios/types.ts', "export type { Company } from './company'"],
        ['test/scenarios/type-names.ts', "export { type Company } from './company'"],
        [
          'test/scenarios/s-x.test.ts',
          teardownByRmSync("import { startCompany } from './company'")
        ],
        [
          'test/main/s-y.test.ts',
          teardownByRmSync("import { startCompany } from '../scenarios/relay'")
        ],
        [
          'test/main/s-js.test.ts',
          teardownByRmSync("import { startCompany } from '../scenarios/company.js'")
        ],
        ['test/main/s-dir.test.ts', teardownByRmSync("import { startCompany } from '../helpers/'")],
        [
          'test/main/s-z.test.ts',
          teardownByRmSync("const { startCompany } = await import('../scenarios/company')")
        ],
        [
          'test/main/s-actual.test.ts',
          teardownByRmSync("const company = await vi.importActual('../scenarios/company')")
        ],
        [
          'test/main/typed.test.ts',
          teardownByRmSync("import type { Company } from '../scenarios/company'")
        ],
        [
          'test/main/typed-names.test.ts',
          teardownByRmSync("import { type Company } from '../scenarios/company'")
        ],
        ['test/main/via-types.test.ts', teardownByRmSync("import '../scenarios/types'")],
        ['test/main/via-type-names.test.ts', teardownByRmSync("import '../scenarios/type-names'")],
        // Helpers in every dialect a test here can import.
        [
          'test/fakes/git-repo.mjs',
          "import { execFileSync } from 'node:child_process'\nexport function initRepo(d) { execFileSync('git', ['init'], { cwd: d }) }"
        ],
        ['test/fakes/old.js', "import { Agora } from '../../src/main/agora'"],
        ['test/renderer/rig.tsx', "import { Agora } from '../../src/main/agora'"],
        [
          'test/main/s-mjs.test.ts',
          teardownByRmSync("import { initRepo } from '../fakes/git-repo.mjs'")
        ],
        ['test/main/s-oldjs.test.ts', teardownByRmSync("import { x } from '../fakes/old.js'")],
        ['test/renderer/s-tsx.test.tsx', teardownByRmSync("import { rig } from './rig'")],
        // A bare specifier names a package, never a file beside the importer.
        ['test/main/company.ts', "import { Agora } from '../../src/main/agora'"],
        ['test/main/s-bare.test.ts', teardownByRmSync("import { thing } from 'company'")],
        // Two helpers that import each other and reach nothing: the chase must end.
        ['test/fakes/loop-a.ts', "import { b } from './loop-b'"],
        ['test/fakes/loop-b.ts', "import { a } from './loop-a'"],
        ['test/main/s-loop.test.ts', teardownByRmSync("import { a } from '../fakes/loop-a'")]
      ])
    )

    expect([...faults.keys()].sort()).toEqual([
      'test/main/s-actual.test.ts',
      'test/main/s-dir.test.ts',
      'test/main/s-js.test.ts',
      'test/main/s-mjs.test.ts',
      'test/main/s-oldjs.test.ts',
      'test/main/s-y.test.ts',
      'test/main/s-z.test.ts',
      'test/renderer/s-tsx.test.tsx',
      'test/scenarios/s-x.test.ts'
    ])
    expect(faults.get('test/main/s-y.test.ts')).toEqual([
      'runs real git (through test/scenarios/relay.ts → test/scenarios/company.ts) and never removes the temp directory it makes at line 2 with removeTempDir',
      'runs real git (through test/scenarios/relay.ts → test/scenarios/company.ts) and removes a tree with rmSync at line 3, outside a test body'
    ])
  })

  it('finds the doors: a module that runs git, and every module that imports one for its values', () => {
    // Listed importer-first, so finding them all takes the fixed point.
    const doors = doorsOf(
      new Map([
        ['src/main/later.ts', "import { boot } from './boot'"],
        ['src/main/boot.ts', "import { Agora } from './agora'"],
        ['src/main/agora.ts', "import { ExecGitRunner, type GitRunner } from './git'"],
        ['src/main/git.ts', `${CHILD}\nexecFile('git', ['status'])`],
        ['src/main/typed.ts', "import type { Agora } from './agora'"],
        ['src/main/plain.ts', "import { foldIncidents } from '../shared/incident-view'"],
        [
          'scripts/tool.cjs',
          "const { execFileSync } = require('node:child_process')\nexecFileSync('git', ['log'])"
        ],
        [
          'scripts/runner.cjs',
          `${CHILD}\nexecFileSync(process.execPath, [path.join('scripts', 'arm-hooks.cjs')])`
        ],
        ['scripts/lister.cjs', "const ALLOW = [path.join('scripts', 'arm-hooks.cjs')]"]
      ])
    )
    expect(doors).toEqual([
      'scripts/runner.cjs',
      'scripts/tool.cjs',
      'src/main/agora.ts',
      'src/main/boot.ts',
      'src/main/git.ts',
      'src/main/later.ts'
    ])
  })

  it('derives the doors from what runs git, never from the list it is checked against', () => {
    // Importing a recorded door opens nothing here, because nothing in this
    // tree runs git: a premise that trusted its own list could not fail.
    expect(doorsOf(new Map([['src/main/x.ts', "import { Agora } from './agora'"]]))).toEqual([])
  })

  it('knows every module outside test/ that git can start through, so a new door cannot open unseen', () => {
    const modules = sourcesOf([
      ...filesUnder('src', /\.tsx?$/),
      ...filesUnder('scripts', /\.[cm]?js$/),
      ...filesUnder('shims', /\.(?:[cm]?js|ts)$/),
      // The fakes are programs the tests run, by a path a test never spells.
      ...filesUnder('test/fakes', /\.[cm]?js$/)
    ])

    expect(doorsOf(modules), PREMISE).toEqual([...GIT_DOORS].sort())
  })
})

/** The faults the rule finds in a fixture standing at `file`, as the tree walk would. */
const faultsAt = (file: string, source: string): readonly string[] =>
  hygieneFaults(readHygiene(source, file))

describe('every directory a file makes reaches a remover the file runs', () => {
  it('fails a second directory the file forgot, though it removes the first', () => {
    // Judged per FILE, this passed: the file calls removeTempDir, so the rule
    // was kept, whatever else it made.
    const forgot = lines(
      'const temps: string[] = []',
      'afterEach(() => { for (const dir of temps.splice(0)) removeTempDir(dir) })',
      "it('a', () => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-a-')); temps.push(home) })",
      "it('b', () => { const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-b-')); use(extra) })"
    )
    expect(faultsIn(forgot)).toEqual([
      'makes a temp directory at line 4 and never removes it with removeTempDir or rmSync'
    ])
  })

  it('tells one home from another by scope, not by name', () => {
    // Test after test declares `const home`. Matched by name, the one that
    // went into the list would vouch for the one that did not.
    const shadowed = lines(
      'const temps: string[] = []',
      'afterEach(() => { for (const dir of temps.splice(0)) removeTempDir(dir) })',
      "it('a', () => { const home = fs.mkdtempSync('a'); temps.push(home) })",
      "it('b', () => { const home = fs.mkdtempSync('b'); use(home) })"
    )
    expect(faultsIn(shadowed)).toEqual([
      'makes a temp directory at line 4 and never removes it with removeTempDir or rmSync'
    ])
  })

  it.each([
    [
      'into a remover beside it',
      "it('x', () => { const home = fs.mkdtempSync('x'); try { work(home) } finally { removeTempDir(home) } })",
      ['removeTempDir']
    ],
    [
      'through a variable one hook sets and another removes',
      lines(
        'let root: string',
        "beforeEach(() => { root = fs.mkdtempSync('x') })",
        'afterEach(() => { removeTempDir(root) })'
      ),
      ['removeTempDir']
    ],
    [
      'through a list a loop empties',
      lines(
        'const temps: string[] = []',
        "it('x', () => { const home = fs.mkdtempSync('x'); temps.push(home) })",
        'afterEach(() => { for (const dir of temps.splice(0)) removeTempDir(dir) })'
      ),
      ['removeTempDir']
    ],
    [
      'through a list popped until empty',
      lines(
        'const homes: string[] = []',
        "it('x', () => { homes.push(fs.mkdtempSync('x')) })",
        'afterEach(() => {',
        '  while (homes.length > 0) {',
        '    const home = homes.pop()',
        '    if (home !== undefined) removeTempDir(home)',
        '  }',
        '})'
      ),
      ['removeTempDir']
    ],
    [
      'through a list a callback empties',
      lines(
        'const temps: string[] = []',
        "it('x', () => { temps.push(fs.mkdtempSync('x')) })",
        'afterEach(() => { temps.splice(0).forEach((dir) => removeTempDir(dir)) })'
      ),
      ['removeTempDir']
    ],
    [
      'through a list handed to the remover whole',
      lines(
        'const temps: string[] = []',
        "it('x', () => { temps.push(fs.mkdtempSync('x')) })",
        'afterEach(() => { temps.splice(0).forEach(removeTempDir) })'
      ),
      ['removeTempDir']
    ],
    [
      'through whichever directory a fallback picks',
      lines(
        'const temps: string[] = []',
        'async function startRig(options: { reuseHome?: string } = {}) {',
        "  const home = options.reuseHome ?? fs.mkdtempSync(path.join(os.tmpdir(), 'eph-agent-wt-'))",
        '  if (options.reuseHome === undefined) temps.push(home)',
        '}',
        'afterEach(() => { for (const dir of temps.splice(0)) removeTempDir(dir) })'
      ),
      ['removeTempDir']
    ],
    [
      'through a helper that lists it and hands it back',
      lines(
        'const dirs: string[] = []',
        'afterEach(() => { for (const dir of dirs.splice(0)) removeTempDir(dir) })',
        'function tempDir(): string {',
        "  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-policy-'))",
        '  dirs.push(dir)',
        '  return dir',
        '}',
        "it('x', () => { fs.writeFileSync(path.join(tempDir(), 'f'), 'x') })"
      ),
      ['removeTempDir']
    ],
    [
      'through each call of a helper that only hands it back',
      lines(
        'function fresh(): string {',
        "  return fs.mkdtempSync('x')",
        '}',
        "it('x', () => { const home = fresh(); try { work(home) } finally { removeTempDir(home) } })"
      ),
      ['removeTempDir']
    ],
    [
      'through each call of an arrow that only hands it back',
      lines(
        "const fresh = (): string => fs.mkdtempSync('x')",
        "it('x', () => { const home = fresh(); removeTempDir(home) })"
      ),
      ['removeTempDir']
    ],
    [
      'through each call of a method that only hands it back',
      lines(
        "class Rig { fresh(): string { return fs.mkdtempSync('x') } }",
        'const rig = new Rig()',
        "it('x', () => { const home = rig.fresh(); removeTempDir(home) })"
      ),
      ['removeTempDir']
    ],
    [
      'through either branch of a conditional',
      lines(
        'const temps: string[] = []',
        "it('x', () => { const home = reuse ? existing : fs.mkdtempSync('x'); temps.push(home) })",
        'afterEach(() => { for (const dir of temps.splice(0)) removeTempDir(dir) })'
      ),
      ['removeTempDir']
    ],
    [
      'through an item handed straight out of the list',
      lines(
        'const homes: string[] = []',
        "it('x', () => { homes.push(fs.mkdtempSync('x')) })",
        'afterEach(() => { while (homes.length > 0) removeTempDir(homes.pop()!) })'
      ),
      ['removeTempDir']
    ],
    [
      'through a Map a loop empties',
      lines(
        'const homes = new Map<string, string>()',
        "it('x', () => { homes.set('a', fs.mkdtempSync('x')) })",
        'afterEach(() => { for (const dir of homes.values()) removeTempDir(dir); homes.clear() })'
      ),
      ['removeTempDir']
    ],
    [
      'into a remover in an IIFE inside the test',
      "it('x', () => { const home = fs.mkdtempSync('x'); (() => removeTempDir(home))() })",
      ['removeTempDir']
    ],
    [
      'into a remover in a Promise executor',
      "it('x', async () => { const home = fs.mkdtempSync('x'); await new Promise<void>((done) => { removeTempDir(home); done() }) })",
      ['removeTempDir']
    ],
    [
      'through a copy of its variable',
      "it('x', () => { const home = fs.mkdtempSync('x'); const dir = home; removeTempDir(dir) })",
      ['removeTempDir']
    ],
    [
      'made by an awaited mkdtemp',
      "it('x', async () => { const home = await fs.promises.mkdtemp('x'); removeTempDir(home) })",
      ['removeTempDir']
    ],
    [
      'made by mkdtempSync imported under another name',
      lines(
        "import { mkdtempSync as makeDir } from 'node:fs'",
        "it('x', () => { const home = makeDir('x'); removeTempDir(home) })"
      ),
      ['removeTempDir']
    ],
    [
      'made by mkdtempSync required under another name',
      lines(
        "const { mkdtempSync: makeDir } = require('node:fs')",
        "it('x', () => { const home = makeDir('x'); removeTempDir(home) })"
      ),
      ['removeTempDir']
    ],
    [
      'removed by removeTempDir imported under another name',
      lines(
        "import { removeTempDir as drop } from '../tmpdir'",
        "it('x', () => { const home = fs.mkdtempSync('x'); drop(home) })"
      ),
      ['removeTempDir']
    ],
    [
      'removed by rmSync imported under another name',
      lines(
        "import { rmSync as nuke } from 'node:fs'",
        "it('x', () => { const home = fs.mkdtempSync('x'); nuke(home, { recursive: true }) })"
      ),
      ['raw']
    ],
    [
      // `test/pin.ts`: other files call `pinHolds`, and its directory never
      // leaves the call, so the removal beside it runs whenever it is made.
      'removed beside it in a function only other files call',
      lines(
        'export function pinHolds(): void {',
        '  let home: string | undefined',
        '  try {',
        "    home = fs.mkdtempSync('x')",
        '  } finally {',
        '    if (home !== undefined) fs.rmSync(home, { recursive: true, force: true })',
        '  }',
        '}'
      ),
      ['raw']
    ]
  ])('follows a directory %s', (_how, source, removedBy) => {
    // One directory, seen, and removed by what the case says: no faults alone
    // would also be the answer for a directory the walk never found.
    expect(readHygiene(source).made.map((dir) => dir.removedBy)).toEqual([removedBy])
    expect(faultsIn(source)).toEqual([])
  })

  it.each([
    [
      'drops the path',
      "it('x', () => { fs.mkdtempSync('x') })",
      'makes a temp directory at line 1 and never removes it with removeTempDir or rmSync: it drops the path, so nothing can remove it'
    ],
    [
      'hands it to a function this does not follow',
      "it('x', () => { track(fs.mkdtempSync('x')) })",
      'makes a temp directory at line 1 and never removes it with removeTempDir or rmSync: it passes it to track(), where this guard cannot follow it'
    ],
    [
      'keeps it in an object',
      "it('x', () => { const rig = { home: fs.mkdtempSync('x') }; use(rig) })",
      'makes a temp directory at line 1 and never removes it with removeTempDir or rmSync: it keeps it where this guard cannot follow it'
    ],
    [
      'lists it where nothing empties the list',
      lines('const kept: string[] = []', "it('x', () => { kept.push(fs.mkdtempSync('x')) })"),
      'makes a temp directory at line 2 and never removes it with removeTempDir or rmSync'
    ],
    [
      'lists it in a list it cannot name',
      "it('x', () => { this.temps.push(fs.mkdtempSync('x')) })",
      'makes a temp directory at line 1 and never removes it with removeTempDir or rmSync: it puts it in a list this guard cannot name'
    ],
    [
      'leaves its removal to a function nothing runs',
      lines(
        'const temps: string[] = []',
        "it('x', () => { temps.push(fs.mkdtempSync('x')) })",
        'function cleanup(): void { for (const dir of temps.splice(0)) removeTempDir(dir) }'
      ),
      'makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: only cleanup would remove it, and nothing in this file runs cleanup: remove it from a hook, or put it in a list a hook empties'
    ],
    [
      'leaves its removal to a function only other files can run',
      lines(
        'const temps: string[] = []',
        "it('x', () => { temps.push(fs.mkdtempSync('x')) })",
        'export function cleanup(): void { for (const dir of temps.splice(0)) removeTempDir(dir) }'
      ),
      'makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: only cleanup would remove it, and nothing in this file runs cleanup: remove it from a hook, or put it in a list a hook empties'
    ],
    [
      'leaves its removal to a function it exports by default',
      lines(
        'const temps: string[] = []',
        "it('x', () => { temps.push(fs.mkdtempSync('x')) })",
        'function cleanup(): void { for (const dir of temps.splice(0)) removeTempDir(dir) }',
        'export default cleanup'
      ),
      'makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: only cleanup would remove it, and nothing in this file runs cleanup: remove it from a hook, or put it in a list a hook empties'
    ],
    [
      'leaves its removal to a function it exports under another name',
      lines(
        'const temps: string[] = []',
        "it('x', () => { temps.push(fs.mkdtempSync('x')) })",
        'function cleanup(): void { for (const dir of temps.splice(0)) removeTempDir(dir) }',
        'export { cleanup as tidy }'
      ),
      'makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: only cleanup would remove it, and nothing in this file runs cleanup: remove it from a hook, or put it in a list a hook empties'
    ],
    [
      'hands a directory back from a function it exports by name',
      lines('function fresh(): string {', "  return fs.mkdtempSync('x')", '}', 'export { fresh }'),
      'makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: fresh hands it to callers in other files, where this guard does not follow it: remove it here, from a module-level hook'
    ],
    [
      'hands a directory back from a function it exports and also calls here',
      lines(
        'export function makeTempDir(): string {',
        "  return fs.mkdtempSync('x')",
        '}',
        "it('x', () => { const dir = makeTempDir(); removeTempDir(dir) })"
      ),
      'makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: makeTempDir hands it to callers in other files, where this guard does not follow it: remove it here, from a module-level hook'
    ],
    [
      'lists it where only a stranded function empties the list, and hands it back',
      lines(
        'const homes: string[] = []',
        'export function cleanup(): void { for (const h of homes.splice(0)) removeTempDir(h) }',
        "function startRig(): string { const home = fs.mkdtempSync('x'); homes.push(home); return home }",
        "it('x', () => { use(startRig()) })"
      ),
      'makes a temp directory at line 3 and never removes it with removeTempDir or rmSync: only cleanup would remove it, and nothing in this file runs cleanup: remove it from a hook, or put it in a list a hook empties'
    ],
    [
      'leaves its removal to a function only a same-named local is called by',
      lines(
        'const temps: string[] = []',
        "it('x', () => { temps.push(fs.mkdtempSync('x')) })",
        'function cleanup(): void { for (const dir of temps.splice(0)) removeTempDir(dir) }',
        'afterEach(() => { const cleanup = (): void => {}; cleanup() })'
      ),
      'makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: only cleanup would remove it, and nothing in this file runs cleanup: remove it from a hook, or put it in a list a hook empties'
    ],
    [
      'takes one directory out of the list in a hook registered inside a loop',
      lines(
        'const temps: string[] = []',
        "it('x', () => { temps.push(fs.mkdtempSync('a')) })",
        'for (const hook of [afterEach]) hook(() => { const d = temps.pop(); if (d) removeTempDir(d) })'
      ),
      'makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: it takes one directory at a time out of temps outside a loop, so the rest are never removed'
    ],
    [
      'removes what one call of a helper hands back and not another',
      lines(
        'function fresh(): string {',
        "  return fs.mkdtempSync('x')",
        '}',
        "it('a', () => { const home = fresh(); removeTempDir(home) })",
        "it('b', () => { const leak = fresh(); use(leak) })"
      ),
      'makes a temp directory at line 5 (through fresh()) and never removes it with removeTempDir or rmSync'
    ],
    [
      'calls rmSync on it without recursive, which cannot remove a directory',
      "it('x', () => { const home = fs.mkdtempSync('x'); fs.rmSync(home) })",
      'makes a temp directory at line 1 and never removes it with removeTempDir or rmSync: it calls rmSync on it without recursive, which cannot remove a directory'
    ],
    [
      'removes it with options this guard cannot read',
      "it('x', () => { const home = fs.mkdtempSync('x'); fs.rmSync(home, OPTIONS) })",
      'makes a temp directory at line 1 and never removes it with removeTempDir or rmSync: it calls rmSync on it with options this guard cannot read as recursive: write recursive: true in the call'
    ],
    [
      'keeps it in an object and removes it through a property',
      lines(
        'const rigs: { home: string }[] = []',
        "it('x', () => { const home = fs.mkdtempSync('x'); rigs.push({ home }) })",
        'afterEach(() => { for (const rig of rigs.splice(0)) removeTempDir(rig.home) })'
      ),
      'makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: it keeps it in an object or an array, and this guard does not follow it out of one: put it in a list a hook empties'
    ],
    [
      'makes it with mkdtempSync imported under another name',
      lines("import { mkdtempSync as makeDir } from 'node:fs'", "const home = makeDir('x')"),
      'makes a temp directory at line 2 and never removes it with removeTempDir or rmSync'
    ]
  ])('fails a file that %s', (_how, source, fault) => {
    expect(faultsIn(source)).toEqual([fault])
  })

  it('holds a file that runs git to removeTempDir for every directory, one removed in a test body included', () => {
    // A raw removal inside a test body is the test, and stays allowed — but
    // when the directory it removes is a temp ROOT, nothing else removes it,
    // and git's detached housekeeping can still be writing into it.
    const repoInTest = lines(
      "import { Agora } from '../../src/main/agora'",
      "it('x', () => {",
      "  const repo = fs.mkdtempSync('r')",
      '  work(repo)',
      '  fs.rmSync(repo, { recursive: true, force: true })',
      '})'
    )
    expect(readHygiene(repoInTest).rawTeardowns).toEqual([])
    expect(faultsIn(repoInTest)).toEqual([
      'runs real git (imports src/main/agora.ts at line 1) and never removes the temp directory it makes at line 3 with removeTempDir'
    ])
  })
})

/**
 * `test/scenarios/company.ts` as it was until 2026-10-02, cut to the lines the
 * rule reads and otherwise verbatim. It made each company's home and left the
 * removal to `cleanupHomes()`, which every one of the twenty scenario files had
 * to remember to call: deleting the call from any of them leaked every home
 * that file made, and the guard, which saw a `removeTempDir(` in the helper,
 * stayed green.
 */
const OLD_COMPANY = lines(
  "import { Agora } from '../../src/main/agora'",
  "import { removeTempDir } from '../tmpdir'",
  'const openHomes: string[] = []',
  '',
  '/** Removes every temp home created this run. Call after closing the companies. */',
  'export function cleanupHomes(): void {',
  '  for (const home of openHomes.splice(0)) removeTempDir(home)',
  '}',
  '',
  'export async function startCompany(options: CompanyOptions = {}): Promise<Company> {',
  "  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-scenario-'))",
  '  openHomes.push(home)',
  '}'
)

describe('a helper removes the directories it makes, rather than trusting its callers to', () => {
  it('fails the company helper as it was, with its removal left to every scenario', () => {
    expect(faultsAt('test/scenarios/company.ts', OLD_COMPANY)).toEqual([
      'runs real git (imports src/main/agora.ts at line 1) and never removes the temp directory it makes at line 11 with removeTempDir: only cleanupHomes would remove it, and nothing in this file runs cleanupHomes: remove it from a hook, or put it in a list a hook empties'
    ])
  })

  it('accepts it once a module-level hook runs the removal, by name or in a callback', () => {
    for (const hook of ['afterAll(cleanupHomes)', 'afterAll(() => { cleanupHomes() })']) {
      expect(faultsAt('test/scenarios/company.ts', lines(OLD_COMPANY, hook)), hook).toEqual([])
    }
  })

  it('then needs nothing from a scenario that forgets cleanupHomes()', () => {
    // The point of moving the removal: the leak is no longer something a
    // scenario can cause, so there is nothing left in one for the guard to find.
    const forgetful = lines(
      "import { startCompany } from './company'",
      'afterAll(async () => { await company.close() })',
      "it('x', async () => { company = await startCompany() })"
    )
    const tree = (helper: string): ReadonlyMap<string, readonly string[]> =>
      treeFaults(
        new Map([
          ['test/scenarios/company.ts', helper],
          ['test/scenarios/s-forgetful.test.ts', forgetful]
        ])
      )
    expect([...tree(OLD_COMPANY).keys()]).toEqual(['test/scenarios/company.ts'])
    expect(tree(lines(OLD_COMPANY, 'afterAll(cleanupHomes)')).size).toBe(0)
  })

  it('fails a makeTempDir that hands its directory back for callers to remove', () => {
    // The shape a `makeTempDir()` beside `removeTempDir` in test/tmpdir.ts
    // would have: every directory it made would leave the file, and no
    // caller's file is judged for it.
    const handsBack = lines(
      "import fs from 'node:fs'",
      "import os from 'node:os'",
      "import path from 'node:path'",
      'export function makeTempDir(prefix: string): string {',
      '  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))',
      '}'
    )
    expect(faultsAt('test/tmpdir.ts', handsBack)).toEqual([
      'makes a temp directory at line 5 and never removes it with removeTempDir or rmSync: makeTempDir hands it to callers in other files, where this guard does not follow it: remove it here, from a module-level hook'
    ])
  })

  it('accepts a makeTempDir that removes what it made itself', () => {
    const selfCleaning = lines(
      "import { afterEach } from 'vitest'",
      'const made: string[] = []',
      'afterEach(() => { for (const dir of made.splice(0)) removeTempDir(dir) })',
      'export function makeTempDir(prefix: string): string {',
      '  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))',
      '  made.push(dir)',
      '  return dir',
      '}'
    )
    expect(faultsAt('test/tmpdir.ts', selfCleaning)).toEqual([])
  })

  it('reads the real helpers as removing their own directories', () => {
    // The two that make directories for other files, as they stand: each
    // removes them from a hook of its own, with the helper.
    for (const file of ['test/scenarios/company.ts', 'test/conformance/adapter-conformance.ts']) {
      const made = readHygiene(fs.readFileSync(file, 'utf8'), file).made
      expect(made.length, file).toBeGreaterThan(0)
      expect(
        made.map((dir) => dir.removedBy),
        file
      ).toEqual(made.map(() => ['removeTempDir']))
    }
  })
})

describe("vitest runs a file's after-hooks last-registered first, which company.ts relies on", () => {
  // `test/scenarios/company.ts` registers `afterAll(cleanupHomes)` when a
  // scenario imports it: before the scenario registers the teardown that
  // closes its companies. Removing a home first would race a commit still in
  // flight, and nothing but this order prevents it. It is vitest's default
  // (`sequence.hooks: 'stack'`), and the one setting orders `afterAll` and
  // `afterEach` alike, so this watches the one a test can observe.
  const ran: string[] = []
  afterEach(() => {
    ran.push('registered first')
  })
  afterEach(() => {
    ran.push('registered second')
  })

  it('registers two hooks', () => {
    expect(ran).toEqual([])
  })

  it('and they ran in the reverse of that order', () => {
    expect(ran).toEqual(['registered second', 'registered first'])
  })
})

/**
 * The `PromptStore` home `test/main/gates.test.ts` built until 2026-10-02, cut
 * to the lines the rule reads and otherwise verbatim. `read()` creates the home
 * and seeds it, and nothing removed it: nine `eph-prompts-<pid>` directories
 * were in %TEMP% that day, one per vitest worker that had run the file.
 */
const OLD_GATES_PROMPTS = lines(
  "import os from 'node:os'",
  "describe('the choke-point wiring (SDD §9), shared with production', () => {",
  '  const prompts = new PromptStore(',
  '    path.join(os.tmpdir(), `eph-prompts-${String(process.pid)}`),',
  "    path.join(process.cwd(), 'prompts')",
  '  )',
  '})'
)

describe('a path built on the temp root without mkdtemp is a directory nothing removes', () => {
  it('fails the prompt home gates.test.ts shipped with', () => {
    expect(faultsIn(OLD_GATES_PROMPTS)).toEqual([
      "names 'eph-prompts-*' on the temp root at line 4 outside an mkdtemp call: make the directory with mkdtemp, the root inside its prefix argument, or, if nothing is ever left there, list it in UNMADE_TEMP_PATHS with the reason"
    ])
  })

  it('accepts the same home once mkdtemp makes it and the describe removes it', () => {
    const fixed = lines(
      "import os from 'node:os'",
      "describe('the choke-point wiring (SDD §9), shared with production', () => {",
      "  let home = ''",
      '  let prompts: PromptStore',
      '  beforeAll(() => {',
      "    home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-prompts-'))",
      "    prompts = new PromptStore(home, path.join(process.cwd(), 'prompts'))",
      '  })',
      '  afterAll(() => {',
      '    removeTempDir(home)',
      '  })',
      '})'
    )
    expect(faultsIn(fixed)).toEqual([])
    expect(readHygiene(fixed).made).toEqual([
      { line: 6, through: null, removedBy: ['removeTempDir'], why: null }
    ])
  })

  it.each([
    ["os's default export", "import os from 'node:os'\nconst p = path.join(os.tmpdir(), 'x')"],
    ["os's namespace", "import * as os from 'os'\nconst p = path.join(os.tmpdir(), 'x')"],
    [
      'tmpdir imported by name',
      "import { tmpdir } from 'node:os'\nconst p = path.join(tmpdir(), 'x')"
    ],
    [
      'tmpdir imported under another name',
      "import { tmpdir as scratchRoot } from 'node:os'\nconst p = path.join(scratchRoot(), 'x')"
    ],
    ['a required os', "const p = path.join(require('node:os').tmpdir(), 'x')"],
    [
      'tmpdir required under another name',
      "const { tmpdir: scratchRoot } = require('os')\nconst p = path.join(scratchRoot(), 'x')"
    ],
    ['TMPDIR from the environment', "const p = path.join(process.env.TMPDIR ?? '/tmp', 'x')"],
    ['TEMP read by key', "const p = path.join(process.env['TEMP'] ?? 'C:/Temp', 'x')"],
    ['TMP from the environment', "const p = path.join(process.env.TMP ?? '/tmp', 'x')"],
    ['the root itself as a working directory', "spawnSync('npm', ['init'], { cwd: os.tmpdir() })"],
    ['a template on the root', 'const p = `${os.tmpdir()}/eph-x`']
  ])('sees a path built on the temp root through %s', (_how, source) => {
    expect(readHygiene(source).tempPaths).toHaveLength(1)
    expect(faultsIn(source)).toHaveLength(1)
  })

  it.each([
    [
      'the prefix mkdtempSync is handed',
      "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-x-'))"
    ],
    ['a template prefix', 'const d = fs.mkdtempSync(`${os.tmpdir()}/eph-x-`)'],
    [
      "an awaited mkdtemp's prefix",
      "const d = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'eph-x-'))"
    ],
    [
      "a renamed mkdtempSync's prefix",
      "import { mkdtempSync as makeDir } from 'node:fs'\nconst d = makeDir(path.join(os.tmpdir(), 'eph-x-'))"
    ],
    [
      'a prefix read from the environment',
      "const d = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'eph-x-'))"
    ],
    ['another environment variable', "const p = path.join(process.env.HOME ?? '', 'x')"],
    ['the home directory', "const p = path.join(os.homedir(), 'x')"],
    ['tmpdir named but never called', 'const root = os.tmpdir'],
    ["an env that is not process's", 'const p = config.env.TMPDIR'],
    ['a comment', "// path.join(os.tmpdir(), 'x')"],
    ['a string', 'const source = "path.join(os.tmpdir(), \'x\')"']
  ])('sees no path built on the temp root in %s', (_what, source) => {
    expect(readHygiene(source).tempPaths).toEqual([])
  })

  it.each([
    ["path.join(os.tmpdir(), 'a', 'b')", 'a/b'],
    ['path.join(os.tmpdir(), `x-${id}.sock`)', 'x-*.sock'],
    ['path.join(os.tmpdir(), label)', '*'],
    ["path.resolve(os.tmpdir(), 'r')", 'r'],
    ['check(temps[0] ?? os.tmpdir())', ''],
    ["path.join(base ?? os.tmpdir(), 'q')", 'q'],
    ["path.join(process.env.TMPDIR ?? '/tmp', 'eph-x')", 'eph-x'],
    ['path.join(prefix, os.tmpdir())', '']
  ])('names %s as %j, the key UNMADE_TEMP_PATHS lists it by', (source, name) => {
    expect(readHygiene(source).tempPaths.map((built) => built.name)).toEqual([name])
  })

  it('allows a listed name in its own file, as often as listed, and nowhere else', () => {
    const nope = "const p = path.join(os.tmpdir(), 'eph-nope')"
    const fault = (name: string, line: number): string =>
      `names '${name}' on the temp root at line ${String(line)} outside an mkdtemp call: make the directory with mkdtemp, the root inside its prefix argument, or, if nothing is ever left there, list it in UNMADE_TEMP_PATHS with the reason`
    const judged = judgeTree(
      new Map([
        ['test/main/a.test.ts', nope],
        ['test/main/b.test.ts', nope],
        ['test/main/c.test.ts', "const p = path.join(os.tmpdir(), 'eph-other')"],
        ['test/main/d.test.ts', lines(nope, nope)]
      ]),
      {
        'test/main/a.test.ts': { 'eph-nope': { sites: 1, why: 'never made' } },
        'test/main/c.test.ts': { 'eph-nope': { sites: 1, why: 'never made' } },
        'test/main/d.test.ts': { 'eph-nope': { sites: 1, why: 'never made' } }
      }
    )
    expect(Object.fromEntries([...judged].map(([file, { faults }]) => [file, faults]))).toEqual({
      'test/main/a.test.ts': [],
      'test/main/b.test.ts': [fault('eph-nope', 1)],
      'test/main/c.test.ts': [fault('eph-other', 1)],
      // A second use of an allowed name is a second path nobody has vouched for.
      'test/main/d.test.ts': [fault('eph-nope', 2)]
    })
  })

  it('lists exactly the paths its files name, each with its reason', () => {
    // An entry that outlived its path would allow the next one of that name
    // without anybody having asked whether it is ever made, and one that
    // allowed more than its file names would allow the next one silently.
    for (const [file, names] of Object.entries(UNMADE_TEMP_PATHS)) {
      const built = readHygiene(fs.readFileSync(file, 'utf8'), file).tempPaths
      for (const [name, { sites, why }] of Object.entries(names)) {
        expect(
          built.filter((each) => each.name === name).length,
          `${file} names '${name}' on the temp root a different number of times than its entry says`
        ).toBe(sites)
        expect(why.length, `${file}: '${name}' needs a reason`).toBeGreaterThan(20)
      }
    }
  })
})

/**
 * A rig as `test/main/control-server.test.ts` and three other files built one
 * until 2026-10-02, cut to the lines the rule reads: the home was removed only
 * by the rig's `close()`, which ran only if `rigs.push(rig)` had registered
 * it. Deleting either that push or the hook's drain leaked every home with
 * the guard green; an adversarial pass did both, in all four files.
 */
const OLD_RIG = lines(
  'const rigs: Rig[] = []',
  'afterEach(async () => {',
  '  for (const rig of rigs.splice(0)) await rig.close()',
  '})',
  'async function startRig(): Promise<Rig> {',
  "  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-'))",
  '  const server = new ControlServer({ deps })',
  '  const rig: Rig = {',
  '    home,',
  '    async close() {',
  '      await server.stop()',
  '      removeTempDir(home)',
  '    }',
  '  }',
  '  rigs.push(rig)',
  '  return rig',
  '}',
  "it('x', async () => { await startRig() })"
)

describe('shapes an adversarial pass found the rule accepting (2026-10-02)', () => {
  const keptOnly = (owner: string): string =>
    `only a function ${owner} keeps — an object's method, or one stored or returned — would remove it, and nothing in this file is seen to run that: remove it from a hook, or put it in a list a hook empties`
  const uncalled = (name: string): string =>
    `${name} hands it back, and nothing in this file calls that: remove it where it is made, or from a module-level hook`

  it.each([
    [
      "a rig whose close() alone removed its home, the four files' shape",
      'test/main/control-server.test.ts',
      OLD_RIG,
      `makes a temp directory at line 6 and never removes it with removeTempDir or rmSync: ${keptOnly('startRig')}`
    ],
    [
      'a helper that hands back a cleanup closure, the tmp-promise shape',
      'test/fakes/temp-home.ts',
      lines(
        'export function tempHome(prefix: string) {',
        '  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix))',
        '  return { home, cleanup: () => removeTempDir(home) }',
        '}'
      ),
      `makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: ${keptOnly('tempHome')}`
    ],
    [
      'a removal closure pushed onto a list nothing runs',
      'test/main/fixture.test.ts',
      lines(
        'const disposers: (() => void)[] = []',
        "it('x', () => { const home = fs.mkdtempSync('x'); disposers.push(() => removeTempDir(home)) })"
      ),
      `makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: ${keptOnly('the file')}`
    ],
    [
      'a stranded remover exported inside an object',
      'test/scenarios/company.ts',
      lines(OLD_COMPANY, 'export const company = { startCompany, cleanupHomes }'),
      'runs real git (imports src/main/agora.ts at line 1) and never removes the temp directory it makes at line 11 with removeTempDir: only cleanupHomes would remove it, and nothing in this file runs cleanupHomes: remove it from a hook, or put it in a list a hook empties'
    ],
    [
      'a stranded remover named in a type',
      'test/scenarios/company.ts',
      lines(OLD_COMPANY, 'export type Cleanup = typeof cleanupHomes'),
      'runs real git (imports src/main/agora.ts at line 1) and never removes the temp directory it makes at line 11 with removeTempDir: only cleanupHomes would remove it, and nothing in this file runs cleanupHomes: remove it from a hook, or put it in a list a hook empties'
    ],
    [
      'a stranded close() beside an unrelated server.close() in a hook',
      'test/fakes/rig.ts',
      lines(
        'const homes: string[] = []',
        'export function close(): void { for (const h of homes.splice(0)) removeTempDir(h) }',
        "export function startRig() { const home = fs.mkdtempSync('x'); homes.push(home) }",
        'afterAll(() => { server.close() })'
      ),
      'makes a temp directory at line 3 and never removes it with removeTempDir or rmSync: only close would remove it, and nothing in this file runs close: remove it from a hook, or put it in a list a hook empties'
    ],
    [
      'a hand-back exported inside an object',
      'test/tmpdir.ts',
      lines(
        'function makeTempDir(prefix: string): string {',
        '  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))',
        '}',
        'export const tmp = { makeTempDir }'
      ),
      `makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: ${uncalled('makeTempDir')}`
    ],
    [
      'a hand-back exported under another name',
      'test/tmpdir.ts',
      lines(
        'function makeTempDir(prefix: string): string {',
        '  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))',
        '}',
        'export const mkTemp = makeTempDir'
      ),
      `makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: ${uncalled('makeTempDir')}`
    ],
    [
      'a hand-back through module.exports',
      'test/fakes/temp.cjs',
      lines(
        'function makeTempDir(prefix) {',
        '  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))',
        '}',
        'module.exports = { makeTempDir }'
      ),
      `makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: ${uncalled('makeTempDir')}`
    ],
    [
      'a hand-back from a method of a class a factory hands out',
      'test/fakes/homes.ts',
      lines(
        "class TempHomes { make(): string { return fs.mkdtempSync('x') } }",
        'export function tempHomes(): TempHomes { return new TempHomes() }'
      ),
      `makes a temp directory at line 1 and never removes it with removeTempDir or rmSync: ${uncalled('make')}`
    ],
    [
      'a hand-back handed by reference to Array.from',
      'test/main/fixture.test.ts',
      lines(
        "function freshHome(): string { return fs.mkdtempSync('x') }",
        "it('x', () => { const homes = Array.from({ length: 3 }, freshHome); use(homes) })"
      ),
      `makes a temp directory at line 1 and never removes it with removeTempDir or rmSync: ${uncalled('freshHome')}`
    ],
    [
      'a list a hook takes one directory out of, while a test makes two',
      'test/main/fixture.test.ts',
      lines(
        'const temps: string[] = []',
        "function tempDir(): string { const d = fs.mkdtempSync('x'); temps.push(d); return d }",
        'afterEach(() => { const d = temps.pop(); if (d) removeTempDir(d) })',
        "it('x', () => { use(tempDir(), tempDir()) })"
      ),
      'makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: it takes one directory at a time out of temps outside a loop, so the rest are never removed'
    ],
    [
      'a list an afterAll removes only the first of',
      'test/main/fixture.test.ts',
      lines(
        'const temps: string[] = []',
        "it('x', () => { temps.push(fs.mkdtempSync('x')) })",
        'afterAll(() => removeTempDir(temps[0]!))'
      ),
      'makes a temp directory at line 2 and never removes it with removeTempDir or rmSync: it takes one directory at a time out of temps outside a loop, so the rest are never removed'
    ]
  ])('fails %s', (_shape, file, source, fault) => {
    expect(faultsAt(file, source)).toEqual([fault])
  })

  it('fails a second bare temp root in a file whose one bare use is listed', () => {
    // The empty name covers the root itself, so one listed bare use must not
    // let a second through: the entry says how many there are.
    const setup = lines(
      'export function sweep(now: number, root: string = os.tmpdir()): number { return 0 }',
      'const scratchRoot = os.tmpdir()'
    )
    expect(
      Object.fromEntries(
        [...judgeTree(new Map([['test/global-setup.ts', setup]]))].map(([file, j]) => [
          file,
          j.faults
        ])
      )
    ).toEqual({
      'test/global-setup.ts': [
        'names the temp root itself at line 2 outside an mkdtemp call: make the directory with mkdtemp, the root inside its prefix argument, or, if nothing is ever left there, list it in UNMADE_TEMP_PATHS with the reason'
      ]
    })
  })

  it.each([
    ['a template', 'fs.mkdirSync(`${os.tmpdir()}/eph-leak-${id}`)', 'eph-leak-*'],
    ['a + chain', "fs.mkdirSync(os.tmpdir() + '/eph-leak-' + pid)", 'eph-leak-*'],
    ['a realpath of the root', "path.join(fs.realpathSync(os.tmpdir()), 'eph-x')", 'eph-x']
  ])('names a path built from the root by %s', (_how, source, name) => {
    expect(readHygiene(source).tempPaths.map((built) => built.name)).toEqual([name])
  })

  it('accepts the rig once its homes go into a list its hook empties after closing the rigs', () => {
    const fixedRig = OLD_RIG.replace(
      "  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-'))",
      "  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ctl-'))\n  homes.push(home)"
    )
      .replace('const rigs: Rig[] = []', 'const rigs: Rig[] = []\nconst homes: string[] = []')
      .replace(
        '  for (const rig of rigs.splice(0)) await rig.close()',
        '  for (const rig of rigs.splice(0)) await rig.close()\n  for (const home of homes.splice(0)) removeTempDir(home)'
      )
    expect(fixedRig).toContain('homes.push(home)')
    expect(faultsAt('test/main/control-server.test.ts', fixedRig)).toEqual([])
  })

  it('refuses a cleanup closure even where the test runs it, and says why', () => {
    // The price of not following objects: this test does call `r.cleanup()`,
    // and the rule cannot see that it is the closure the rig returned.
    // Recorded as a known false positive; the message names the shape that
    // passes.
    const runsItsCleanup = lines(
      'function rig() {',
      "  const home = fs.mkdtempSync('x')",
      '  return { home, cleanup: () => removeTempDir(home) }',
      '}',
      "it('x', () => { const r = rig(); try { work(r.home) } finally { r.cleanup() } })"
    )
    expect(readHygiene(runsItsCleanup).made.map((dir) => dir.why)).toEqual([keptOnly('rig')])
  })
})

describe('sweeping what per-file teardown cannot reach', () => {
  it('removes a directory older than the age gate', () => {
    const root = scratch()
    const stale = path.join(root, 'eph-old-abc123')
    fs.mkdirSync(stale)
    fs.writeFileSync(path.join(stale, 'f.txt'), 'x')
    const now = Date.now() + SWEEP_OLDER_THAN_MS + 60_000

    expect(sweepStaleTempDirs(now, SWEEP_OLDER_THAN_MS, root)).toBe(1)
    expect(fs.existsSync(stale)).toBe(false)
  })

  it('leaves a LIVE run alone, which is the whole reason for the age gate', () => {
    // This repository is regularly worked on from more than one worktree at
    // once, so a sweep that removed a fresh directory would break somebody
    // else's suite while tidying. Two hours against a 30 s per-test timeout is
    // that margin.
    const root = scratch()
    const fresh = path.join(root, 'eph-live-xyz789')
    fs.mkdirSync(fresh)

    expect(sweepStaleTempDirs(Date.now(), SWEEP_OLDER_THAN_MS, root)).toBe(0)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('touches nothing that is not ours', () => {
    const root = scratch()
    const theirs = path.join(root, 'some-other-tool-cache')
    fs.mkdirSync(theirs)
    const now = Date.now() + SWEEP_OLDER_THAN_MS + 60_000

    expect(sweepStaleTempDirs(now, SWEEP_OLDER_THAN_MS, root)).toBe(0)
    expect(fs.existsSync(theirs)).toBe(true)
  })

  it('never throws when a directory cannot be read or removed', () => {
    // Tidying is a courtesy. A sweep that failed a run would be worse than the
    // residue it was cleaning.
    expect(() =>
      sweepStaleTempDirs(Date.now(), 0, path.join(os.tmpdir(), 'eph-does-not-exist-at-all'))
    ).not.toThrow()
  })
})

describe('refusing to start on a machine that cannot run the suite', () => {
  it('refuses below the measured floor', () => {
    expect(() => requireHeadroom(MIN_FREE_BYTES - 1, 16_800_000_000)).toThrow(
      /Not enough free memory/
    )
  })

  it('allows exactly the floor', () => {
    // Stated rather than left to whichever comparison was typed.
    expect(() => requireHeadroom(MIN_FREE_BYTES, 16_800_000_000)).not.toThrow()
  })

  it('names the numbers, because a refusal that cannot be acted on is noise', () => {
    const said = headroomRefusal(370_000_000, 16_800_000_000)
    expect(said).toContain('0.37 GB free of 16.80 GB')
    expect(said).toContain('2 GB')
  })

  it('says what the failure LOOKS like, which is the part that cost an hour', () => {
    // The refusal exists because the symptom is unrecognisable: a few dozen
    // unrelated tests failing, a different set each run. Telling somebody only
    // "out of memory" would not stop them reading the next red run as a
    // regression.
    const said = headroomRefusal(110_000_000, 16_800_000_000)
    expect(said).toMatch(/does NOT look like a memory problem/)
    expect(said).toMatch(/regression/)
  })
})
