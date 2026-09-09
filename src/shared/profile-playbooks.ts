/**
 * Where an activated instance's playbooks live, and whether they are all there
 * (M8b.1 — Finding 8 of the 2026-09-09 exit run).
 *
 * ## The gap this closes
 *
 * A profile bundle is read from the REPOSITORY (`<app>/profiles/<name>/`, or
 * the Architect's copy under `<home>/profiles/<name>/`). Its agents run in
 * worktrees under the HARNESS HOME. Nothing carried the bundle's playbooks
 * across that boundary, so `activations.json` named three runbooks that no
 * agent could open: on the exit run the health watcher refused its duty twice,
 * the dependency updater was on course to do the same, and eighteen incidents
 * were raised with `incident-triaged: 0` because the on-call agent had no
 * runbook to follow. Every party could name a file none of them could read.
 *
 * ## Why an instance-scoped directory, and not `<home>/profiles/`
 *
 * `<home>/profiles/` is the Architect's own override root, and `ProfileStore`
 * resolves it BEFORE the app's built-ins. Copying a built-in bundle into it at
 * activation would do exactly what that store's doc comment forbids — "a
 * silently seeded copy would shadow the built-in forever, so the next Ephesus
 * that shipped a corrected Skeleton Crew would not be the one running."
 *
 * So the installed copy lands under `<home>/instances/<dir>/playbooks/`
 * instead: reachable by every agent of that instance, invisible to profile
 * resolution, and scoped to the activation rather than to the profile name —
 * two targets running one profile get one directory each and cannot overwrite
 * each other's runbooks.
 *
 * ## Why a COPY at all, rather than a path into the repository
 *
 * The same rule the activation plan already obeys. A plan is persisted and
 * restored verbatim rather than re-derived, because "restore exactly" (NFR-5)
 * is a claim about the plan the Architect approved, not about what
 * `profiles/` happens to contain later. The runbook is part of what was
 * approved, so it is frozen with it and drift is DISCLOSED (`profileVersion`
 * is already compared at boot) rather than silently applied. It also makes the
 * home self-contained: moving or deleting the Ephesus checkout cannot silently
 * un-arm a running company.
 *
 * Pure. No `node:path`, no `node:fs` — `src/shared` is reachable from the
 * renderer and must stay so (invariant §2). The filesystem half is
 * `src/main/playbooks.ts`.
 */

/** `<home>/instances/` — one subdirectory per activated instance. */
export const INSTANCES_REL = 'instances'

/** `<instance dir>/playbooks/` — the runbooks that instance's hires follow. */
export const PLAYBOOKS_REL = 'playbooks'

/**
 * Contract: a directory name for an instance id. Pure, total, injective.
 *
 * `instanceIdSchema` admits `crew@repo:myapp`, and `:` cannot appear in a
 * Windows path component — it is the alternate-data-stream separator, so
 * `mkdir` either fails or writes somewhere nobody meant. The id is therefore
 * transformed rather than used directly.
 *
 * Injective, which is what makes it safe to key a directory on: the id shape
 * is `<profile>@<kind>:<target>` with exactly one `@`, and `kind` is `repo` or
 * `app`. Replacing that single `:` with `-` cannot collide with another id,
 * because no legal id contains `@` twice and no legal target ref begins
 * `repo-`/`app-` where a `:` would otherwise be. Two instances therefore never
 * share a directory, which is the property the whole scheme rests on.
 *
 * Anything not matching the id grammar is still folded to a safe name rather
 * than thrown on: this runs on a path that already validated the id, and a
 * throw here would turn a naming problem into a failed activation.
 *
 * `.` is NOT in the safe set, and that is deliberate rather than tidy. Leaving
 * it in made `..` fold to itself, so an id of `..` — which the schema cannot
 * produce, but which this function claims to be total over — would have named
 * the PARENT directory and put an instance's runbooks one level above where
 * everything reads them. A defence-in-depth fold that passes through the one
 * string the filesystem treats as an instruction is not defence in depth. No
 * legal instance id contains a dot, so nothing is lost by excluding it.
 */
export function instanceDirName(instanceId: string): string {
  const folded = instanceId.replace(/[^A-Za-z0-9@_-]/g, '-')
  // The empty string names the parent of nothing: `path.join(home,
  // 'instances', '', 'playbooks')` collapses to `<home>/instances/playbooks`,
  // where a second empty id would land on top of the first.
  return folded === '' ? '-' : folded
}

/** What an instance declares versus what is actually installed for it. */
export interface PlaybookComparison {
  /** Declared by the activation plan, absent from disk. The defect. */
  readonly missing: readonly string[]
  /** On disk, declared by nothing — a stale install, or a hand-edit. */
  readonly extra: readonly string[]
}

/**
 * Contract: the two-way difference between the declared set and the on-disk
 * set, both sorted. Pure.
 *
 * TWO-way rather than "are any missing", because M8b.1's acceptance is that
 * the sets are EQUAL. A leftover runbook from a previous activation of the
 * same instance is not harmless: the agent is told which file to follow by
 * name, and a stale file that still opens is a runbook nobody approved. It is
 * reported rather than silently deleted so the Architect learns their home was
 * edited.
 */
export function comparePlaybooks(
  declared: readonly string[],
  onDisk: readonly string[]
): PlaybookComparison {
  const have = new Set(onDisk)
  const want = new Set(declared)
  return {
    missing: [...want].filter((file) => !have.has(file)).sort(),
    extra: [...have].filter((file) => !want.has(file)).sort()
  }
}

/** True when the declared set and the on-disk set are the same set. */
export function playbooksAgree(comparison: PlaybookComparison): boolean {
  return comparison.missing.length === 0 && comparison.extra.length === 0
}

/**
 * Contract: the sentence a restored instance's missing runbooks deserve, or
 * null when there is nothing wrong. Pure.
 *
 * A sentence rather than a code, because this is the one condition the exit
 * run proves is invisible until an agent hits it: `activations.json` survives
 * a restart and the home directory might not, so a restored instance can come
 * back looking healthy and fail forty minutes later at a wall its own record
 * says is not there. It names the instance, the files and the fix, because a
 * degradation that does not say what to do gets read once and ignored.
 */
export function playbooksMissingDetail(
  instanceId: string,
  comparison: PlaybookComparison,
  dir: string
): string | null {
  if (playbooksAgree(comparison)) return null
  const parts: string[] = []
  if (comparison.missing.length > 0) {
    parts.push(`declares ${comparison.missing.join(', ')}, which ${dir} does not carry`)
  }
  if (comparison.extra.length > 0) {
    parts.push(`carries ${comparison.extra.join(', ')} in ${dir}, which it does not declare`)
  }
  return (
    `${instanceId} ${parts.join('; and ')} — ` +
    `its hires cannot follow a runbook that is not there. Reactivate the ` +
    `instance to reinstall the bundle's playbooks.`
  )
}
