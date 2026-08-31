import fs from 'node:fs'
import path from 'node:path'
import { parseProfile, profileNameSchema, type ProfileFiles } from '../shared/profile'
import type { ProfileLoad, ProfileSummary } from '../shared/profile-view'

/**
 * The profile store (SDD §1.1 `profiles.ts`, SDD §2 `~/.ephesus/profiles/<name>/`,
 * ADR-0012).
 *
 * M7.1 is the load/validate half; activate/instantiate is M7.2. The halves are
 * separated on purpose and the separation is testable: **loading is pure.**
 * Nothing here spawns, writes, commits, schedules or registers. A `list()` on a
 * broken bundle must leave the disk exactly as it found it, because the
 * Architect's first act with a new profile is to read it, and a reader with
 * side effects is not a reader.
 *
 * Two roots, home first:
 *
 *  - `<harness home>/profiles/<name>/` — what the Architect edits (SDD §2);
 *  - the app's bundled `profiles/` — the built-ins that ship with Ephesus
 *    (ENGINEERING-STANDARDS §2), Skeleton Crew and Front Office among them
 *    from M7.4/M7.5.
 *
 * Unlike `PromptStore`, this store does **not** seed the home copy on read.
 * Seeding is a write, and a write is a side effect; more to the point, a
 * silently seeded copy would shadow the built-in forever, so the next Ephesus
 * that shipped a corrected Skeleton Crew would not be the one running. When the
 * Architect wants to edit a built-in, copying the directory is the explicit act
 * that makes the override visible in `list()` as `source: "home"`.
 */
export class ProfileStore {
  /**
   * @param homeProfilesDir `<harness home>/profiles` — the Architect's copies.
   * @param builtinProfilesDir the app's bundled `profiles/` — the built-ins.
   */
  constructor(
    private readonly homeProfilesDir: string,
    private readonly builtinProfilesDir: string
  ) {}

  /**
   * Contract: every profile directory under either root, home shadowing
   * builtin, sorted by name. Read-only; never throws on a broken bundle.
   *
   * A directory whose name is not a legal profile name is skipped rather than
   * listed as invalid: it was never a profile, so reporting it as a broken one
   * would put the Architect's `.DS_Store` and their mistyped `memo-policy.json`
   * in the same list.
   */
  list(): readonly ProfileSummary[] {
    const seen = new Map<string, ProfileSummary>()
    for (const [dir, source] of [
      [this.homeProfilesDir, 'home'],
      [this.builtinProfilesDir, 'builtin']
    ] as const) {
      for (const name of readDirNames(dir)) {
        if (seen.has(name)) continue
        if (!profileNameSchema.safeParse(name).success) continue
        const loaded = this.loadFrom(dir, name, source)
        seen.set(name, {
          name,
          source,
          valid: loaded.ok,
          version: loaded.ok ? loaded.bundle.document.version : null
        })
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Contract: loads one bundle by name, or refuses it BY NAME with every reason
   * at once. Read-only; never throws.
   *
   * The refusal never degrades to defaults. ADR-0012 chose declarative bundles
   * so a profile can be read before it is trusted; a loader that supplied a
   * missing `memo-policy.json` would have made that reading a lie in exactly
   * the field that decides what gets held for a memo.
   */
  load(name: string): ProfileLoad {
    if (!profileNameSchema.safeParse(name).success) {
      return { ok: false, name, reasons: ['profile: not a legal profile name'] }
    }
    for (const [dir, source] of [
      [this.homeProfilesDir, 'home'],
      [this.builtinProfilesDir, 'builtin']
    ] as const) {
      if (!isDirectory(path.join(dir, name))) continue
      return this.loadFrom(dir, name, source)
    }
    return {
      ok: false,
      name,
      reasons: [
        `profile: no bundle named "${name}" in ${this.homeProfilesDir} or ${this.builtinProfilesDir}`
      ]
    }
  }

  private loadFrom(root: string, name: string, source: 'home' | 'builtin'): ProfileLoad {
    const dir = path.join(root, name)
    const read = readBundleFiles(dir, name)
    if (!read.ok) return { ok: false, name, reasons: read.reasons }
    const parsed = parseProfile(read.files)
    if (!parsed.ok) return { ok: false, name, reasons: parsed.reasons }
    return { ok: true, bundle: parsed.bundle, source }
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function readDirNames(dir: string): readonly string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // A missing root is not a fault: a fresh harness home has no profiles, and
    // an app built without built-ins still runs.
    return []
  }
}

function readTextFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** `<dir>/<sub>/*.<ext>` → contents, keyed by file name. Missing dir ⇒ empty. */
function readSubdir(dir: string, sub: string, ext: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>()
  let entries: readonly fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(dir, sub), { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(ext)) continue
    const text = readTextFile(path.join(dir, sub, entry.name))
    if (text !== null) files.set(entry.name, text)
  }
  return files
}

/**
 * Reads the six parts of ADR-0012's bundle off disk as TEXT.
 *
 * The three required JSON files are reported missing by name here rather than
 * as a parse failure downstream, because "memo-policy.json: missing" and
 * "memo-policy.json: not JSON" send the Architect to two different places.
 */
function readBundleFiles(
  dir: string,
  name: string
): { ok: true; files: ProfileFiles } | { ok: false; reasons: readonly string[] } {
  const reasons: string[] = []
  const required = {
    profileJson: 'profile.json',
    memoPolicyJson: 'memo-policy.json',
    harborJson: 'harbor.json'
  } as const
  const bodies: Partial<Record<keyof typeof required, string>> = {}
  for (const [key, file] of Object.entries(required) as [keyof typeof required, string][]) {
    const text = readTextFile(path.join(dir, file))
    if (text === null) reasons.push(`${file}: missing from the bundle`)
    else bodies[key] = text
  }
  if (
    reasons.length > 0 ||
    bodies.profileJson === undefined ||
    bodies.memoPolicyJson === undefined ||
    bodies.harborJson === undefined
  ) {
    return { ok: false, reasons }
  }
  return {
    ok: true,
    files: {
      name,
      profileJson: bodies.profileJson,
      hires: readSubdir(dir, 'hires', '.json'),
      triggers: readSubdir(dir, 'triggers', '.json'),
      playbooks: readSubdir(dir, 'playbooks', '.md'),
      memoPolicyJson: bodies.memoPolicyJson,
      harborJson: bodies.harborJson
    }
  }
}
