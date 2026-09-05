import fs from 'node:fs'
import path from 'node:path'
import {
  NO_TOOLS,
  type ResolvedTools,
  type ToolGrant,
  type ToolGrantRoot
} from '../../shared/engine-tools'

/**
 * Turns a hire's declared tool grants into absolute directories (ADR-0026,
 * M8.7b).
 *
 * This is where "by name" is enforced rather than merely intended. A grant is a
 * root plus a relative path, and the resolved directory must still be INSIDE
 * that root — otherwise a bundle could write `target:../../.ssh` and the flag
 * the harness composes would hand an agent a directory the Architect never
 * approved, from a file the Architect skim-read.
 *
 * Containment is checked on REALPATHS, not on string prefixes. A prefix test
 * passes every unit test anyone writes for it and then fails on the first
 * symlink or Windows junction, which is the shape `resolveProjectKey` already
 * had to learn for workspace trust.
 */

/** The harness-home subdirectory holding the company's own tool directories. */
export const TOOLS_DIR = 'tools'

/** The absolute directories the named roots stand for. */
export interface ToolRoots {
  /** The activation target — the repository this profile was activated on. */
  readonly target: string
  /** `~/.ephesus/tools` — the company's own, Architect-editable. */
  readonly home: string
}

export type ToolGrantResolution =
  | { readonly ok: true; readonly tools: ResolvedTools }
  | { readonly ok: false; readonly because: string }

/**
 * Contract: resolves every grant, or refuses the whole set naming the offender.
 *
 * **Refuses on escape, reports on absence.** They are different failures: a
 * directory outside its root is a bundle asking for something it may not have,
 * and honouring seven of eight such grants would be a security decision taken
 * by a loop; a directory that is simply not there is the `envGrants` case, and
 * ADR-0010's answer there is a visible degradation rather than a refused spawn.
 *
 * Returns `NO_TOOLS` for an empty list, so a hire that declared nothing and an
 * agent on no profile are the same value rather than two shapes to handle.
 */
export function resolveToolGrants(
  grants: readonly ToolGrant[],
  roots: ToolRoots
): ToolGrantResolution {
  if (grants.length === 0) return { ok: true, tools: NO_TOOLS }

  const pluginDirs: string[] = []
  const missing: string[] = []
  const seen = new Set<string>()

  for (const grant of grants) {
    const root = roots[grant.root satisfies ToolGrantRoot]
    if (root === undefined || root.length === 0) {
      return { ok: false, because: `tool grant ${label(grant)}: no ${grant.root} root to resolve` }
    }
    if (path.isAbsolute(grant.path)) {
      return { ok: false, because: `tool grant ${label(grant)}: must be relative to its root` }
    }

    const joined = path.resolve(root, grant.path)
    const contained = containedIn(root, joined)
    if (!contained.ok) return { ok: false, because: `tool grant ${label(grant)}: ${contained.why}` }

    if (!fs.existsSync(joined)) {
      missing.push(label(grant))
      continue
    }
    // A file is not a mistake worth refusing over, but it is not a tool
    // directory either, and passing it would make the engine complain about
    // something the Architect wrote in a bundle rather than about the bundle.
    if (!fs.statSync(joined).isDirectory()) {
      return { ok: false, because: `tool grant ${label(grant)}: not a directory` }
    }
    // Two grants naming one directory would pass the same flag twice; harmless
    // to the engine and confusing in the log line that says what was granted.
    if (seen.has(joined)) continue
    seen.add(joined)
    pluginDirs.push(joined)
  }

  return { ok: true, tools: { pluginDirs, missing } }
}

function label(grant: ToolGrant): string {
  return `${grant.root}:${grant.path}`
}

/**
 * Contract: true when `candidate` is `root` or lives under it, judged after
 * both are canonicalised. Pure apart from reading the filesystem.
 *
 * The root is resolved too, not just the candidate: on Windows the harness home
 * frequently sits under a OneDrive junction, so comparing a resolved candidate
 * against an unresolved root reports "outside" for a directory that is plainly
 * inside — a refusal nobody could explain.
 */
function containedIn(root: string, candidate: string): { ok: true } | { ok: false; why: string } {
  let realRoot: string
  try {
    realRoot = fs.realpathSync.native(root)
  } catch {
    return { ok: false, why: `its ${JSON.stringify(root)} root does not resolve` }
  }
  // The candidate may not exist yet; resolve the deepest ancestor that does, so
  // a missing directory is judged by where it WOULD be rather than skipped.
  let probe = candidate
  const tail: string[] = []
  for (;;) {
    try {
      probe = fs.realpathSync.native(probe)
      break
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return { ok: false, why: 'does not resolve' }
      tail.unshift(path.basename(probe))
      probe = parent
    }
  }
  const real = path.resolve(probe, ...tail)
  const relative = path.relative(realRoot, real)
  if (relative.length === 0) return { ok: true }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, why: 'resolves outside its root' }
  }
  return { ok: true }
}
