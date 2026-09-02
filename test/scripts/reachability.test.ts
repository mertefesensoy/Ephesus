import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../tmpdir'

/**
 * The reachability half of the seam rule (ENGINEERING-STANDARDS §6.7, M8.0).
 *
 * Two layers, tested two ways:
 *
 * - The **walk** runs over a fixture project in a temp directory, so each edge
 *   kind the header promises to count (or to ignore) has a file that exists for
 *   no other reason. The fixture is the specification.
 * - The **rule** is also run over THIS repository with an empty allowlist, so
 *   the test proves the tripwire bites on the real tree — the Herald is the
 *   defect this check was written for, and a test that only ever saw a fixture
 *   would be a check against nothing.
 */

const require_ = createRequire(import.meta.url)
const SCRIPT = fileURLToPath(new URL('../../scripts/reachability.cjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

interface AllowEntry {
  readonly prefix: string
  readonly reason: string
}
const reach = require_(SCRIPT) as {
  ENTRY_POINTS: readonly string[]
  UNREACHABLE_ALLOWLIST: readonly AllowEntry[]
  valueImportSpecifiers: (file: string, text: string) => string[]
  hasRuntimeCode: (file: string, text: string) => boolean
  reachableModules: (
    root: string,
    entries?: readonly string[]
  ) => { reached: Set<string>; universe: Set<string>; typeOnly: Set<string> }
  unreachableModules: (root: string, entries?: readonly string[]) => string[]
  reachabilityFailures: (
    root: string,
    allowlist?: readonly AllowEntry[],
    entries?: readonly string[]
  ) => string[]
}

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

const ENTRY = ['src/main/index.ts']

/** A tiny project whose every file exists to exercise exactly one edge kind. */
function fixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-reach-'))
  temps.push(root)
  const write = (rel: string, text: string): void => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  write(
    'src/main/index.ts',
    [
      "import { wired } from './wired'",
      "import type { Shape } from '../shared/typed-only'",
      "import { type A, type B } from '../shared/all-type-bindings'",
      "import './side-effect'",
      "export * from '../shared/reexported'",
      "export type { T } from '../shared/type-reexported'",
      "import * as ns from '../shared/namespaced'",
      "import './styles.css'",
      "import electron from 'electron'",
      'export async function boot(): Promise<void> {',
      "  const lazy = await import('../shared/lazy')",
      '  void [wired, ns, lazy, electron, null as unknown as Shape, null as unknown as A, null as unknown as B]',
      '}',
      ''
    ].join('\n')
  )
  write('src/main/wired.ts', "import { deep } from '../shared/deep'\nexport const wired = deep\n")
  write('src/main/side-effect.ts', 'globalThis.sideEffect = true\n')
  write('src/shared/deep.ts', 'export const deep = 1\n')
  write('src/shared/reexported.ts', 'export const re = 1\n')
  write('src/shared/type-reexported.ts', 'export type T = number\n')
  write('src/shared/namespaced.ts', 'export const n = 1\n')
  write('src/shared/lazy.ts', 'export const lazy = 1\n')
  // These three carry a run-time value beside their types, so a type-only
  // import of them is a real gap: the value is never loaded.
  write(
    'src/shared/typed-only.ts',
    'export interface Shape { x: number }\nexport const SHAPE_VERSION = 1\n'
  )
  write(
    'src/shared/all-type-bindings.ts',
    'export type A = 1\nexport type B = 2\nexport const ab = 3\n'
  )
  write('src/shared/type-reexported.ts', 'export type T = number\nexport const t = 1\n')
  write('src/shared/orphan.ts', 'export const orphan = 1\n')
  // Nothing here survives compilation: no module, nothing to reach.
  write(
    'src/shared/pure-types.ts',
    [
      "import type { Shape } from './typed-only'",
      "import { type A } from './all-type-bindings'",
      'export type Wide = Shape & { y: number; a: A }',
      'export interface Box { w: number }',
      'export declare const AMBIENT: number',
      'declare global {',
      '  interface Window { eph?: unknown }',
      '}',
      'export {}',
      ''
    ].join('\n')
  )
  write('src/shared/env.d.ts', 'declare const __X__: string\n')
  write('src/shared/data.json', '{}\n')
  write('src/main/styles.css', 'body {}\n')
  return root
}

describe('the walk counts value edges and ignores erased ones', () => {
  it('reaches through static, namespace, side-effect, re-export and dynamic imports', () => {
    const root = fixtureProject()
    const { reached } = reach.reachableModules(root, ENTRY)
    expect([...reached].sort()).toEqual([
      'src/main/index.ts',
      'src/main/side-effect.ts',
      'src/main/wired.ts',
      'src/shared/deep.ts',
      'src/shared/lazy.ts',
      'src/shared/namespaced.ts',
      'src/shared/reexported.ts'
    ])
  })

  it('does not reach a module named only in erased type positions, nor an orphan', () => {
    const root = fixtureProject()
    expect(reach.unreachableModules(root, ENTRY)).toEqual([
      'src/shared/all-type-bindings.ts',
      'src/shared/orphan.ts',
      'src/shared/type-reexported.ts',
      'src/shared/typed-only.ts'
    ])
  })

  it('keeps declarations, json and stylesheets out of the universe', () => {
    const root = fixtureProject()
    const { universe } = reach.reachableModules(root, ENTRY)
    expect(universe.has('src/shared/env.d.ts')).toBe(false)
    expect(universe.has('src/shared/data.json')).toBe(false)
    expect(universe.has('src/main/styles.css')).toBe(false)
  })

  it('a module with no run-time code is type-only: neither reached nor unreachable', () => {
    const root = fixtureProject()
    const { universe, typeOnly } = reach.reachableModules(root, ENTRY)
    expect([...typeOnly]).toEqual(['src/shared/pure-types.ts'])
    expect(universe.has('src/shared/pure-types.ts')).toBe(false)
    expect(reach.unreachableModules(root, ENTRY)).not.toContain('src/shared/pure-types.ts')
  })

  it('classifies run-time code by statement kind, not by file name', () => {
    const rt = (text: string): boolean => reach.hasRuntimeCode('x.ts', text)
    expect(rt('export interface A { x: number }\nexport type B = A\n')).toBe(false)
    expect(rt("import type { A } from './a'\nexport type { A }\n")).toBe(false)
    expect(rt("import { A } from './a'\nexport type B = A\n")).toBe(false)
    expect(rt('declare module "x" { export const y: number }\n')).toBe(false)
    expect(rt('export declare function f(): void\n')).toBe(false)
    expect(rt('export {}\n')).toBe(false)
    expect(rt('export const a = 1\n')).toBe(true)
    expect(rt('export function f(): void {}\n')).toBe(true)
    expect(rt('export enum E { A }\n')).toBe(true)
    expect(rt('export class C {}\n')).toBe(true)
    expect(rt("export * from './a'\n")).toBe(true)
    expect(rt("export { a } from './a'\n")).toBe(true)
    expect(rt("export type { a } from './a'\n")).toBe(false)
    expect(rt("export { type a } from './a'\n")).toBe(false)
    // A bare import is kept by the compiler: loading a module IS a run-time act.
    expect(rt("import './side-effect'\n")).toBe(true)
  })

  it('lists exactly the run-time specifiers of one file, in source order', () => {
    const text = fs.readFileSync(path.join(fixtureProject(), 'src/main/index.ts'), 'utf8')
    expect(reach.valueImportSpecifiers('index.ts', text)).toEqual([
      './wired',
      './side-effect',
      '../shared/reexported',
      '../shared/namespaced',
      './styles.css',
      'electron',
      '../shared/lazy'
    ])
  })
})

describe('the rule', () => {
  it('fails by name on an unreachable module that nobody decided on', () => {
    const root = fixtureProject()
    const failures = reach.reachabilityFailures(root, [], ENTRY)
    expect(failures).toHaveLength(4)
    expect(failures[0]).toMatch(/^src\/shared\/all-type-bindings\.ts {2}unreachable/)
    expect(failures.every((f) => f.includes('the seam rule'))).toBe(true)
  })

  it('accepts a recorded gap, by directory prefix or by file', () => {
    const root = fixtureProject()
    const byFile = [
      { prefix: 'src/shared/typed-only.ts', reason: 'fixture' },
      { prefix: 'src/shared/all-type-bindings.ts', reason: 'fixture' },
      { prefix: 'src/shared/type-reexported.ts', reason: 'fixture' },
      { prefix: 'src/shared/orphan.ts', reason: 'fixture' }
    ]
    expect(reach.reachabilityFailures(root, byFile, ENTRY)).toEqual([])
    const byDir = [{ prefix: 'src/shared/', reason: 'fixture' }]
    expect(reach.reachabilityFailures(root, byDir, ENTRY)).toEqual([])
  })

  it('fails on an allowlist entry whose gap has closed, so the record cannot go stale', () => {
    const root = fixtureProject()
    const allowlist = [
      { prefix: 'src/shared/', reason: 'fixture' },
      { prefix: 'src/main/wired.ts', reason: 'reached — this entry is stale' }
    ]
    const failures = reach.reachabilityFailures(root, allowlist, ENTRY)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain("allowlist entry 'src/main/wired.ts' names nothing unreachable")
  })

  it('a file entry matches that file only; a directory entry needs its trailing slash', () => {
    const root = fixtureProject()
    fs.writeFileSync(path.join(root, 'src/shared/orphan.tsx'), 'export const twin = 1\n')
    const allowlist = [
      { prefix: 'src/shared/typed-only.ts', reason: 'fixture' },
      { prefix: 'src/shared/all-type-bindings.ts', reason: 'fixture' },
      { prefix: 'src/shared/type-reexported.ts', reason: 'fixture' },
      { prefix: 'src/shared/orphan.ts', reason: 'fixture' }
    ]
    const failures = reach.reachabilityFailures(root, allowlist, ENTRY)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/^src\/shared\/orphan\.tsx {2}unreachable/)
    // 'src/shared' without the slash is a file name that does not exist: stale, and
    // it accepts nothing.
    const noSlash = [{ prefix: 'src/shared', reason: 'fixture' }]
    const failures2 = reach.reachabilityFailures(root, noSlash, ENTRY)
    expect(failures2).toHaveLength(6)
    expect(failures2.at(-1)).toContain("allowlist entry 'src/shared' names nothing unreachable")
  })

  it('FAILS, rather than reporting nothing, when an entry point is missing', () => {
    const root = fixtureProject()
    expect(reach.reachabilityFailures(root, [], ['src/main/no-such-entry.ts'])).toEqual([
      'reachability could not be established: entry point does not exist: src/main/no-such-entry.ts'
    ])
  })
})

describe('over this repository', () => {
  it('bites: with no allowlist, the deferred Herald is reported by name', () => {
    const named = reach.reachabilityFailures(REPO_ROOT, []).map((f) => f.split('  ')[0])
    for (const file of [
      'src/main/herald/elevenlabs.ts',
      'src/main/herald/narration.ts',
      'src/main/herald/openai-realtime.ts',
      'src/main/herald/phrasebook.ts',
      'src/main/herald/policy.ts',
      'src/main/herald/seam.ts',
      'src/main/herald/session.ts'
    ]) {
      expect(named).toContain(file)
    }
  })

  it('reports the view-type modules as type-only, not as gaps', () => {
    const { typeOnly } = reach.reachableModules(REPO_ROOT)
    for (const file of [
      'src/main/engines/types.ts',
      'src/shared/gym-view.ts',
      'src/shared/mode-view.ts',
      'src/shared/profile-view.ts',
      'src/shared/share-view.ts',
      'src/shared/stoa-view.ts'
    ]) {
      expect(typeOnly.has(file)).toBe(true)
    }
  })

  it('holds: every unreachable module is a recorded decision, and every record is live', () => {
    expect(reach.reachabilityFailures(REPO_ROOT)).toEqual([])
    for (const entry of reach.UNREACHABLE_ALLOWLIST) {
      // A reason is a decision, not a label: it must say who decided and when/where.
      expect(entry.reason.length).toBeGreaterThan(60)
    }
  })

  it('walks from the three programs electron-vite builds, all of which exist', () => {
    expect(reach.ENTRY_POINTS).toEqual([
      'src/main/index.ts',
      'src/preload/index.ts',
      'src/renderer/src/main.tsx'
    ])
    for (const entry of reach.ENTRY_POINTS) {
      expect(fs.existsSync(path.join(REPO_ROOT, entry))).toBe(true)
    }
  })
})
