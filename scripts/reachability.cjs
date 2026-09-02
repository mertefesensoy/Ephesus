#!/usr/bin/env node
/**
 * The seam rule's first half (ENGINEERING-STANDARDS §6, item 7 — M8.0): every
 * module under `src/` is reachable from an application entry point, or its
 * unreachability is a recorded decision.
 *
 * ## Why an import graph, and not a grep
 *
 * The M6 close-out audit found 1,406 lines of Herald — seam, policy, two
 * provider adapters, session, narration — whose only importers were test files.
 * Three milestones of green suites, a clean live demo and a written exit review
 * all passed over it, because a test reaches a module by importing it and the
 * application reaches it by importing it, and nothing ever asked which of the
 * two had. This script asks. It walks the compiler's own module resolution
 * from the three entry points the app actually boots — main, preload, renderer
 * — and reports every `src/**` module the walk never touches.
 *
 * ## What "reachable" means here, precisely
 *
 * An edge is a VALUE import or re-export: `import x from`, `import './fx'`,
 * `export * from`, `export { x } from`, and a dynamic `import('...')` with a
 * literal specifier. `import type` and `export type` are erased by the compiler
 * and are NOT edges — a module only ever named as a type is not loaded at run
 * time, and counting it would make the Herald "reachable" the moment something
 * borrowed one of its interfaces. The one over-approximation, stated so nobody
 * mistakes the answer for more than it is: a value import whose bindings are
 * used only in type positions is also dropped by esbuild at build time, and IS
 * counted here. Reachability is the floor of wiring, not proof of it — a module
 * the app can load may still never be called, which is what the coverage half
 * of the rule (`check-coverage.cjs`) and each package's stated call path are
 * for.
 *
 * ## Why the allowlist carries a decision, not a name
 *
 * A gap this check accepts is a gap somebody chose. The entry says which
 * decision, so that when the decision changes (M6.9 lands; ADR-0024 is
 * superseded) the entry reads as stale on sight — and the check fails on a
 * stale entry too, so the record cannot quietly outlive the gap it recorded.
 *
 * Contract: pure apart from reading the tree. `reachabilityFailures` returns
 * one line per fault and never throws; an entry point that does not exist is
 * itself a failure rather than an empty answer, because "nothing is
 * unreachable" from a missing root would be a check that cannot fail (the
 * probe rule: could-not-establish must FAIL, not pass).
 */
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..')

/** The three programs electron-vite builds; each is a root of the walk. */
const ENTRY_POINTS = ['src/main/index.ts', 'src/preload/index.ts', 'src/renderer/src/main.tsx']

/** Where production modules live. Everything under it that is not a `.d.ts` must be reached. */
const UNIVERSE_DIR = 'src'

/**
 * Modules the application deliberately does not reach — a prefix (a directory
 * with its trailing slash, or one file) and the decision that made the gap
 * deliberate. Add an entry only with a decision to cite; remove it when the
 * decision is reversed, and the check will insist that you do.
 */
const UNREACHABLE_ALLOWLIST = [
  {
    prefix: 'src/main/herald/',
    reason:
      'M6.9 (wiring the Herald) is DEFERRED INDEFINITELY by Architect decision, 2026-08-30 — built and tested, not connected on purpose (BUILD-PROMPT build state; IMPLEMENTATION M6 amendment)'
  },
  {
    prefix: 'src/shared/contrast.ts',
    reason:
      'the CI token/contrast gate (UI-DESIGN §8, NFR-15) — kept in src/shared so the token test and future design tooling share one arithmetic; no runtime caller by design (its own header)'
  }
]

/**
 * Resolution options mirroring tsconfig.base.json's `moduleResolution: bundler`.
 * Only the fields that change how a specifier resolves are set; this is not a
 * type-check and must never become one.
 */
const RESOLUTION = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  allowJs: true,
  resolveJsonModule: true,
  jsx: ts.JsxEmit.ReactJSX
}

const MODULE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const DECLARATION = /\.d\.(ts|mts|cts)$/

/** Path separators differ by platform; every path this module reports uses `/`. */
const slashed = (p) => p.split(path.sep).join('/')

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (MODULE_EXT.test(entry.name) && !DECLARATION.test(entry.name)) out.push(full)
  }
  return out
}

function scriptKindFor(file) {
  switch (path.extname(file)) {
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS
    default:
      return ts.ScriptKind.TS
  }
}

/**
 * Is this import clause erased at run time? `import type {…}` says so on the
 * clause; `import { type A, type B }` says so on every binding and leaves the
 * clause's own flag false, so both spellings are checked.
 */
function importClauseIsTypeOnly(clause) {
  if (clause === undefined) return false // `import './side-effect'` — a value edge
  if (clause.isTypeOnly) return true
  if (clause.name !== undefined) return false // a default binding is a value
  const bindings = clause.namedBindings
  if (bindings === undefined) return false
  if (ts.isNamespaceImport(bindings)) return false
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)
}

function exportIsTypeOnly(decl) {
  if (decl.isTypeOnly) return true
  const clause = decl.exportClause
  if (clause === undefined || !ts.isNamedExports(clause)) return false
  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly)
}

const isAmbient = (statement) =>
  ts.canHaveModifiers(statement) &&
  (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)

/**
 * Does this module do anything at run time? A file made only of interfaces,
 * type aliases, `import type` / `export type` and ambient declarations is
 * erased entirely by the compiler: there is no module to load, so there is
 * nothing to reach, and such a file is classified TYPE-ONLY rather than
 * unreachable. An import WITH bindings counts as erased here — in a file with
 * no runtime statement, its bindings can only have been used in type
 * positions — and so does a local `export { A }` without a `from`, for the
 * same reason. A bare `import './fx'` is kept by the compiler and is runtime.
 * A re-export WITH a `from` that is not marked `type` is counted as runtime,
 * conservatively: telling a value barrel from a type barrel would mean
 * resolving every name, and a type barrel misread as runtime shows up as
 * unreachable and gets a decision, which is the safe direction to be wrong in.
 */
function hasRuntimeCode(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKindFor(file))
  return source.statements.some((statement) => {
    if (ts.isImportDeclaration(statement)) return statement.importClause === undefined
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) return false
    if (ts.isEmptyStatement(statement)) return false
    if (isAmbient(statement)) return false
    if (ts.isExportDeclaration(statement)) {
      return statement.moduleSpecifier !== undefined && !exportIsTypeOnly(statement)
    }
    return true
  })
}

/**
 * Contract: the run-time module specifiers one file imports — value imports,
 * value re-exports and literal dynamic imports, in source order. Type-only
 * edges are excluded (see the header). Pure.
 */
function valueImportSpecifiers(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKindFor(file))
  const specifiers = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (!importClauseIsTypeOnly(node.importClause) && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text)
      }
    } else if (ts.isExportDeclaration(node)) {
      if (
        !exportIsTypeOnly(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text)
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

/**
 * Contract: every module under `<root>/src` the walk from `entries` reaches, as
 * root-relative `/`-separated paths; the universe it was measured against
 * (every module with run-time code); and the type-only modules, which belong
 * to neither because there is nothing to reach. Throws only when an entry
 * point is missing — `reachabilityFailures` is the non-throwing form.
 */
function reachableModules(root = ROOT, entries = ENTRY_POINTS) {
  const universe = new Set()
  const typeOnly = new Set()
  for (const file of walk(path.join(root, UNIVERSE_DIR))) {
    const rel = slashed(path.relative(root, file))
    if (hasRuntimeCode(file, fs.readFileSync(file, 'utf8'))) universe.add(rel)
    else typeOnly.add(rel)
  }
  const reached = new Set()
  const queue = []
  for (const entry of entries) {
    const abs = path.join(root, entry)
    if (!fs.existsSync(abs)) throw new Error(`entry point does not exist: ${entry}`)
    queue.push(abs)
  }
  while (queue.length > 0) {
    const file = queue.pop()
    const rel = slashed(path.relative(root, file))
    if (reached.has(rel)) continue
    reached.add(rel)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const specifier of valueImportSpecifiers(file, text)) {
      const resolved = ts.resolveModuleName(specifier, file, RESOLUTION, ts.sys).resolvedModule
      if (resolved === undefined) continue // a package, a stylesheet, an asset URL
      const target = path.resolve(resolved.resolvedFileName)
      const targetRel = slashed(path.relative(root, target))
      if (!universe.has(targetRel)) continue // node_modules, json, declarations
      if (!reached.has(targetRel)) queue.push(target)
    }
  }
  return { reached, universe, typeOnly }
}

/** Contract: the universe minus the reached set, sorted. Throws as `reachableModules` does. */
function unreachableModules(root = ROOT, entries = ENTRY_POINTS) {
  const { reached, universe } = reachableModules(root, entries)
  return [...universe].filter((file) => !reached.has(file)).sort()
}

const matchesPrefix = (file, prefix) =>
  prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix

/**
 * Contract: one failure line per module that is unreachable and not
 * allowlisted; one per allowlist entry that no longer names an unreachable
 * module (the gap closed and the record did not); one if the walk could not
 * run at all. Empty means the rule holds. Never throws.
 */
function reachabilityFailures(
  root = ROOT,
  allowlist = UNREACHABLE_ALLOWLIST,
  entries = ENTRY_POINTS
) {
  let unreachable
  try {
    unreachable = unreachableModules(root, entries)
  } catch (err) {
    return [
      `reachability could not be established: ${err instanceof Error ? err.message : String(err)}`
    ]
  }
  const failures = []
  for (const file of unreachable) {
    if (allowlist.some((entry) => matchesPrefix(file, entry.prefix))) continue
    failures.push(
      `${file}  unreachable from every entry point (${entries.join(', ')}) — the seam rule (ENGINEERING-STANDARDS §6.7): wire it, delete it, or allowlist it in scripts/reachability.cjs with the decision that makes the gap deliberate`
    )
  }
  for (const entry of allowlist) {
    if (unreachable.some((file) => matchesPrefix(file, entry.prefix))) continue
    failures.push(
      `scripts/reachability.cjs allowlist entry '${entry.prefix}' names nothing unreachable any more — the gap it recorded has closed; remove the entry so the record stays true`
    )
  }
  return failures
}

/** @returns {number} the process exit code, so a test can call this without exiting. */
function main() {
  const failures = reachabilityFailures()
  if (failures.length > 0) {
    console.error('Reachability failures (the seam rule, ENGINEERING-STANDARDS §6.7):\n')
    for (const failure of failures) console.error(`  ${failure}`)
    console.error('')
    return 1
  }
  const { reached, universe, typeOnly } = reachableModules()
  const allowlisted = [...universe].filter(
    (file) =>
      !reached.has(file) && UNREACHABLE_ALLOWLIST.some((entry) => matchesPrefix(file, entry.prefix))
  )
  console.log(
    `reachability ok (${String(reached.size)}/${String(universe.size)} src modules reached from ${String(ENTRY_POINTS.length)} entry points; ${String(allowlisted.length)} unreachable by recorded decision; ${String(typeOnly.size)} type-only, nothing to reach)`
  )
  return 0
}

if (require.main === module) process.exit(main())

module.exports = {
  ENTRY_POINTS,
  UNREACHABLE_ALLOWLIST,
  valueImportSpecifiers,
  hasRuntimeCode,
  reachableModules,
  unreachableModules,
  reachabilityFailures,
  main
}
