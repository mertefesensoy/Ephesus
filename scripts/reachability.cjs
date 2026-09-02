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
 * borrowed one of its interfaces.
 *
 * Two things the walk cannot see, stated so nobody mistakes the answer for more
 * than it is. A value import whose bindings are used only in type positions is
 * dropped by esbuild at build time and IS counted here. A dynamic import whose
 * specifier is not a literal (a template, `import.meta.glob`) is NOT followed,
 * so a module loaded only that way reads as unreachable — the safe direction,
 * and the failure text says so. Reachability is the floor of wiring, not proof
 * of it: a module the app can load may still never be called, which is what
 * the coverage half of the rule (`check-coverage.cjs`) and each package's
 * stated call path are for.
 *
 * ## Type-only modules, and why the classification is conservative
 *
 * A file made only of interfaces, type aliases, `import type` / `export type`
 * and ambient declarations is erased entirely: there is no module to load, so
 * there is nothing to reach, and it is classified TYPE-ONLY rather than
 * unreachable. The rule is deliberately narrow. ANY import written in value
 * syntax — `import { A } from './a'` — makes a file runtime here, even when
 * `A` is a type the compiler would elide, because the alternative reading
 * ("bindings in a file with no other runtime statement can only be types")
 * was refuted on 2026-09-02: `import { x } from './x'; export { x }` is a
 * value barrel under `isolatedModules`, and the first draft classified it
 * type-only, hid it from the gate, and stopped the walk at it. A file misread
 * as runtime shows up as unreachable and gets a decision; a file misread as
 * type-only vanishes. Only the first is a mistake you can see.
 *
 * ## Why the allowlist names files, and carries a decision
 *
 * A gap this check accepts is a gap somebody chose, one file at a time. A
 * directory entry would accept the next file dropped beside the seven it was
 * written for, and would read as live while a single one of them stayed
 * unreachable — so entries are exact files. Each says which decision, so that
 * when the decision changes (M6.9 lands; ADR-0024 is superseded) the entry
 * reads as stale on sight — and the check fails on a stale entry too, so the
 * record cannot quietly outlive the gap it recorded.
 *
 * Contract: pure apart from reading the tree. `reachabilityFailures` returns
 * one line per fault and never throws; an entry point that does not exist, a
 * module that cannot be read, or an empty universe is itself a failure rather
 * than an empty answer, because "nothing is unreachable" from a missing or
 * unreadable root would be a check that cannot fail (the probe rule:
 * could-not-establish must FAIL, not pass).
 */
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..')

/** The three programs electron-vite builds; each is a root of the walk. */
const ENTRY_POINTS = ['src/main/index.ts', 'src/preload/index.ts', 'src/renderer/src/main.tsx']

/** Where production modules live. Everything under it that is not a `.d.ts` must be reached. */
const UNIVERSE_DIR = 'src'

const HERALD_DEFERRED =
  'M6.9 (wiring the Herald) is DEFERRED INDEFINITELY by Architect decision, 2026-08-30 — built and tested, not connected on purpose (BUILD-PROMPT build state; IMPLEMENTATION M6 amendment)'

/**
 * Modules the application deliberately does not reach — one exact file per
 * entry and the decision that made the gap deliberate. Add an entry only with
 * a decision to cite; remove it when the decision is reversed, and the check
 * will insist that you do.
 */
const UNREACHABLE_ALLOWLIST = [
  { file: 'src/main/herald/elevenlabs.ts', reason: HERALD_DEFERRED },
  { file: 'src/main/herald/narration.ts', reason: HERALD_DEFERRED },
  { file: 'src/main/herald/openai-realtime.ts', reason: HERALD_DEFERRED },
  { file: 'src/main/herald/phrasebook.ts', reason: HERALD_DEFERRED },
  { file: 'src/main/herald/policy.ts', reason: HERALD_DEFERRED },
  { file: 'src/main/herald/seam.ts', reason: HERALD_DEFERRED },
  { file: 'src/main/herald/session.ts', reason: HERALD_DEFERRED },
  {
    file: 'src/shared/contrast.ts',
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
 * Does this module do anything at run time? See the header: only statements
 * the compiler provably erases count as nothing — a type-only import, a type
 * alias, an interface, an ambient declaration, a type-only export, and the
 * empty `export {}`. Everything else, an import in value syntax included, is
 * runtime. Pure.
 */
function hasRuntimeCode(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKindFor(file))
  return source.statements.some((statement) => {
    if (ts.isImportDeclaration(statement)) return !importClauseIsTypeOnly(statement.importClause)
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) return false
    if (ts.isEmptyStatement(statement)) return false
    if (isAmbient(statement)) return false
    if (ts.isExportDeclaration(statement)) {
      if (exportIsTypeOnly(statement)) return false
      const clause = statement.exportClause
      const empty =
        statement.moduleSpecifier === undefined &&
        clause !== undefined &&
        ts.isNamedExports(clause) &&
        clause.elements.length === 0
      return !empty
    }
    return true
  })
}

/**
 * Contract: the run-time module specifiers one file imports — value imports,
 * value re-exports and literal dynamic imports, in source order. Type-only
 * edges are excluded; non-literal dynamic imports are not visible (header). Pure.
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
 * Contract: every module under `<root>/src` the walk from `entries` reaches,
 * as root-relative `/`-separated paths; the universe it was measured against
 * (every module with run-time code); the type-only modules, which belong to
 * neither because there is nothing to reach; and the modules that could not be
 * read. The walk traverses every module it reaches, type-only ones included,
 * so a classification mistake can never stop it. Throws only when an entry
 * point is missing — `reachabilityFailures` is the non-throwing form.
 */
function reachableModules(root = ROOT, entries = ENTRY_POINTS) {
  const universe = new Set()
  const typeOnly = new Set()
  const unreadable = new Set()
  const known = new Set()
  for (const file of walk(path.join(root, UNIVERSE_DIR))) {
    const rel = slashed(path.relative(root, file))
    known.add(rel)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      unreadable.add(rel)
      universe.add(rel) // unreadable is not "nothing to reach"; it is a fault, reported below
      continue
    }
    if (hasRuntimeCode(file, text)) universe.add(rel)
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
      unreadable.add(rel)
      continue
    }
    for (const specifier of valueImportSpecifiers(file, text)) {
      const resolved = ts.resolveModuleName(specifier, file, RESOLUTION, ts.sys).resolvedModule
      if (resolved === undefined) continue // a package, a stylesheet, an asset URL
      const target = path.resolve(resolved.resolvedFileName)
      const targetRel = slashed(path.relative(root, target))
      if (!known.has(targetRel)) continue // node_modules, json, declarations
      if (!reached.has(targetRel)) queue.push(target)
    }
  }
  return { reached, universe, typeOnly, unreadable }
}

/** Contract: the universe minus the reached set, sorted. Throws as `reachableModules` does. */
function unreachableModules(root = ROOT, entries = ENTRY_POINTS) {
  const { reached, universe } = reachableModules(root, entries)
  return [...universe].filter((file) => !reached.has(file)).sort()
}

/**
 * Contract: one failure line per module that is unreachable and not
 * allowlisted; one per allowlist entry that no longer names an unreachable
 * module (the gap closed — or the file went — and the record did not); one per
 * module that could not be read; one if the universe is empty; one if the walk
 * could not run at all. Empty means the rule holds. Never throws.
 */
function reachabilityFailures(
  root = ROOT,
  allowlist = UNREACHABLE_ALLOWLIST,
  entries = ENTRY_POINTS
) {
  let result
  try {
    result = reachableModules(root, entries)
  } catch (err) {
    return [
      `reachability could not be established: ${err instanceof Error ? err.message : String(err)}`
    ]
  }
  const { reached, universe, unreadable } = result
  const failures = []
  if (universe.size === 0) {
    failures.push(
      `reachability could not be established: no module with run-time code was found under ${UNIVERSE_DIR}/ — the walk is measuring nothing`
    )
  }
  for (const file of [...unreadable].sort()) {
    failures.push(`${file}  could not be read — reachability is unknown for everything behind it`)
  }
  const allowed = new Set(allowlist.map((entry) => entry.file))
  const unreachable = [...universe].filter((file) => !reached.has(file)).sort()
  for (const file of unreachable) {
    if (allowed.has(file)) continue
    failures.push(
      `${file}  unreachable from every entry point (${entries.join(', ')}) by static value imports — template-literal dynamic imports and import.meta.glob are not followed — the seam rule (ENGINEERING-STANDARDS §6.7): wire it, delete it, or allowlist THIS FILE in scripts/reachability.cjs with the decision that makes the gap deliberate`
    )
  }
  const unreachableSet = new Set(unreachable)
  for (const entry of allowlist) {
    if (unreachableSet.has(entry.file)) continue
    failures.push(
      `scripts/reachability.cjs allowlist entry '${entry.file}' names nothing unreachable any more — the gap it recorded has closed, or the file is gone; remove the entry so the record stays true`
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
  const allowlisted = UNREACHABLE_ALLOWLIST.map((entry) => entry.file)
  console.log(
    `reachability ok (${String(reached.size)}/${String(universe.size)} src modules reached from ${String(ENTRY_POINTS.length)} entry points; ${String(allowlisted.length)} unreachable by recorded decision; ${String(typeOnly.size)} type-only, nothing to reach)`
  )
  console.log(`  by decision: ${allowlisted.join(', ')}`)
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
