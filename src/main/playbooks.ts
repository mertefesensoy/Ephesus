import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './fsx'
import {
  INSTANCES_REL,
  PLAYBOOKS_REL,
  comparePlaybooks,
  instanceDirName,
  playbooksMissingDetail,
  type PlaybookComparison
} from '../shared/profile-playbooks'

/**
 * Installing an activated instance's runbooks into the harness home, and
 * checking they are still there (M8b.1 — Finding 8).
 *
 * The judgement is in `src/shared/profile-playbooks.ts`, which is pure and has
 * no filesystem. This is the half that needs one: writing the bundle's
 * playbooks where the agents can reach them, and reading back what is
 * actually on disk.
 *
 * The write path mirrors `harbor/hires.ts`'s `install` deliberately, because
 * it is the same problem and that one has already been got wrong once:
 * REPLACE rather than merge, atomic writes, and a bare-name check standing
 * between author-controlled text and `path.join`.
 */

/** `<home>/instances/<dir>/playbooks` — where this instance's hires read. */
export function playbooksDir(homeRoot: string, instanceId: string): string {
  return path.join(homeRoot, INSTANCES_REL, instanceDirName(instanceId), PLAYBOOKS_REL)
}

/** The absolute path an agent is told to open, for one declared runbook. */
export function playbookPath(homeRoot: string, instanceId: string, file: string): string {
  return path.join(playbooksDir(homeRoot, instanceId), file)
}

/** Installed, or refused with every reason at once. */
export type PlaybookInstall =
  | { readonly ok: true; readonly dir: string; readonly installed: readonly string[] }
  | { readonly ok: false; readonly reasons: readonly string[] }

/**
 * Contract: writes one instance's playbooks into the home, replacing whatever
 * was there, or refuses with every reason at once. Never throws.
 *
 * Called after the plan is settled and BEFORE the first hire is spawned, so a
 * refusal costs nothing: no process exists, no token has been spent, and the
 * Architect gets a sentence instead of a crew that discovers the wall forty
 * minutes later. That ordering is the whole point — the 2026-09-09 run spent
 * $11.22 and 40.45M tokens on four agents re-firing a duty against a runbook
 * that was never on disk, and every one of them reported it correctly.
 *
 * REPLACE, never merge: a v2 bundle that dropped a runbook would otherwise
 * leave the v1 copy readable, and an agent told to follow `incident.md` would
 * open a file the current profile does not carry. `harbor/hires.ts` paid for
 * this exact lesson on the import path; the fix is the same one.
 */
export function installPlaybooks(
  homeRoot: string,
  instanceId: string,
  playbooks: ReadonlyMap<string, string>
): PlaybookInstall {
  const dir = playbooksDir(homeRoot, instanceId)

  // Defence in depth on the one call that turns a bundle author's file name
  // into a filesystem path. `playbookSchema` already refuses anything but
  // `^[a-z0-9][a-z0-9-]*\.md$`, so nothing should reach here — but a single
  // schema regex is thin cover for a directory escape that would land in the
  // harness home, and this guard is reachable from a test whereas the regex's
  // absence would not be.
  const escaping = [...playbooks.keys()].filter(
    (file) => path.basename(file) !== file || file === '.' || file === '..'
  )
  if (escaping.length > 0) {
    return {
      ok: false,
      reasons: escaping.map(
        (file) => `playbooks: "${file}" is not a bare file name and would write outside ${dir}`
      )
    }
  }

  try {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    for (const [file, body] of playbooks) writeFileAtomic(path.join(dir, file), body)
  } catch (err) {
    // The reason names the destination, not just the errno. A runner who is
    // told `EACCES` learns nothing; one who is told which directory could not
    // be written knows whether they picked a home they cannot write to.
    return {
      ok: false,
      reasons: [
        `playbooks: could not install ${[...playbooks.keys()].join(', ')} into ${dir} — ` +
          `${err instanceof Error ? err.message : String(err)}`
      ]
    }
  }
  return { ok: true, dir, installed: [...playbooks.keys()].sort() }
}

/**
 * Contract: the `.md` files actually present for this instance, sorted. Never
 * throws — an absent directory reads as the empty set, which is the state the
 * exit run was in and must be reportable rather than fatal.
 */
export function installedPlaybooks(homeRoot: string, instanceId: string): readonly string[] {
  try {
    return fs
      .readdirSync(playbooksDir(homeRoot, instanceId), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Contract: what one instance declares versus what is installed for it.
 *
 * The assertion M8b.1 owes, in one call, so the boot check and the test ask
 * the same question of the same code rather than two copies of it.
 */
export function auditPlaybooks(
  homeRoot: string,
  instance: { readonly instanceId: string; readonly declared: readonly string[] }
): PlaybookComparison {
  return comparePlaybooks(instance.declared, installedPlaybooks(homeRoot, instance.instanceId))
}

/**
 * Contract: one degradation sentence per restored instance whose runbooks do
 * not match its record, in instance order. Empty when every instance agrees.
 *
 * This is the second half of the Architect's decision of 2026-09-09, and it
 * covers the case an activation-time check structurally cannot: the record
 * survives a restart in `activations.json`, and the home directory it points
 * into might have been cleaned, moved or half-copied while the harness was
 * off. Without this the instance comes back looking healthy and the failure
 * surfaces only as an agent's refusal, which is how the exit run found it.
 */
export function playbookDegradations(
  homeRoot: string,
  instances: readonly { readonly instanceId: string; readonly declared: readonly string[] }[]
): readonly string[] {
  return instances.flatMap((instance) => {
    const detail = playbooksMissingDetail(
      instance.instanceId,
      auditPlaybooks(homeRoot, instance),
      playbooksDir(homeRoot, instance.instanceId)
    )
    return detail === null ? [] : [detail]
  })
}
