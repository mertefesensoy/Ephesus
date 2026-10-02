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

/** The doors a test reaches by running them: the git-starting scripts, by file name. */
const GIT_SCRIPTS = GIT_DOORS.filter((door) => !door.startsWith('src/')).map((door) =>
  path.posix.basename(door)
)

const TEMP_MAKERS = new Set(['mkdtempSync', 'mkdtemp'])
const RAW_REMOVERS = new Set(['rmSync', 'rm', 'rmdirSync', 'rmdir'])
const CHILD_PROCESS = new Set(['child_process', 'node:child_process'])
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

/** What the rule needs to know about one file, read from its syntax tree. */
export interface HygieneReading {
  readonly makesTempDir: boolean
  readonly callsRemoveTempDir: boolean
  readonly callsRmSync: boolean
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
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const value = unwrap(node.initializer)
      const required =
        ts.isCallExpression(value) &&
        nameOf(value.expression) === 'require' &&
        CHILD_PROCESS.has(literalText(value.arguments[0]) ?? '')
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
   * Whether `node` runs as part of a test. The first test registration,
   * after-test hook, `finally` or named function it sits in decides; at the
   * top of the file it is no test.
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

  let makesTempDir = false
  let callsRemoveTempDir = false
  let callsRmSync = false
  const git: GitSighting[] = []
  const rawTeardowns: string[] = []
  const imports: string[] = []

  const imported = (specifier: string, at: ts.Node): void => {
    imports.push(specifier)
    const door = candidatesFor(fileName, specifier).find((candidate) => DOORS.has(candidate))
    if (door !== undefined) git.push({ how: `imports ${door}`, line: lineOf(at), starts: false })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = nameOf(node.expression) ?? ''
      const first = literalText(node.arguments[0])
      if (TEMP_MAKERS.has(name)) makesTempDir = true
      if (name === 'removeTempDir') callsRemoveTempDir = true
      if (name === 'rmSync') callsRmSync = true
      if (RAW_REMOVERS.has(name)) {
        const recursion = recursionOf(node)
        if (recursion !== 'no' && !inTest(node)) {
          const unread = recursion === 'unread' ? ' (options it cannot read)' : ''
          rawTeardowns.push(`${name} at line ${String(lineOf(node))}${unread}`)
        }
      }
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
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return {
    makesTempDir,
    callsRemoveTempDir,
    callsRmSync,
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
 * reaches git through, for a file that does not reach it itself.
 */
export function hygieneFaults(
  reading: HygieneReading,
  helpers: readonly string[] = []
): readonly string[] {
  const via = gitVia(reading, helpers)
  if (via === null) {
    return reading.makesTempDir && !reading.callsRemoveTempDir && !reading.callsRmSync
      ? ['creates a temp directory and never removes it with removeTempDir or rmSync']
      : []
  }
  const faults: string[] = []
  if (reading.makesTempDir && !reading.callsRemoveTempDir) {
    faults.push(`runs real git (${via}) and never calls removeTempDir`)
  }
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
 * failed on CI would fail the same way on a helper's directory.
 */
export function judgeTree(sources: ReadonlyMap<string, string>): ReadonlyMap<string, Judgement> {
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
    if (!reading.makesTempDir && via === null) continue
    judged.set(file, { git: via, faults: hygieneFaults(reading, helpers) })
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
  'these files leave a temp directory behind, or remove a tree that git may still be writing into',
  'with a raw recursive remove. A file that runs real git must remove its temp directories with',
  "removeTempDir (test/tmpdir.ts): rmSync's maxRetries retries the rmdir of a directory whose",
  'children it listed ONCE, so one entry a still-running git writes after that listing (a',
  'detached `git repack`, CI run 36924116592) spends the whole budget and throws ENOTEMPTY.',
  'A raw removal inside a test, called from nowhere else, is the test and stays allowed.'
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
  })

  it('catches a file that makes a directory and removes nothing', () => {
    expect(faultsIn("const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-x-'))")).toEqual([
      'creates a temp directory and never removes it with removeTempDir or rmSync'
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
    expect(faultsIn('fs.mkdtempSync(x)\nremoveTempDir(home)')).toEqual([])
    expect(faultsIn('fs.mkdtempSync(x)\nfs.rmSync(home, { recursive: true })')).toEqual([])
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
      'runs real git (imports src/main/agora.ts at line 1) and never calls removeTempDir',
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
    // Calling the helper once is not removing every temp directory with it.
    const mixed = lines(
      CHILD,
      "const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-repo-'))",
      "execFileSync('git', ['init'], { cwd: repo })",
      'afterEach(() => {',
      '  for (const dir of homes.splice(0)) removeTempDir(dir)',
      '  for (const dir of repos.splice(0)) fs.rmSync(dir, { recursive: true, force: true })',
      '})'
    )
    expect(faultsIn(mixed)).toEqual([
      "runs real git (execFileSync('git') at line 3) and removes a tree with rmSync at line 6, outside a test body"
    ])
  })

  it('judges a file that reaches git through a helper even when the helper made the directory', () => {
    // The scenario files make no temp directory: `startCompany` does. The
    // teardown that failed on CI fails the same way on the company's home.
    const company = lines(
      "import { Agora } from '../../src/main/agora'",
      'const openHomes: string[] = []',
      "export async function startCompany() { const home = fs.mkdtempSync('x'); openHomes.push(home); return { home } }",
      'export function cleanupHomes(): void { for (const home of openHomes.splice(0)) removeTempDir(home) }'
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
      'runs real git (through test/scenarios/relay.ts → test/scenarios/company.ts) and never calls removeTempDir',
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
