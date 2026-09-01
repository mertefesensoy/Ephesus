import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../fsx'
import { hireRef, type HireTemplate } from '../../shared/org'
import { requestedAutonomy, type ProfileBundle } from '../../shared/profile'
import { GATE_KINDS, type AutonomyLevel, type GateKind } from '../../shared/gates'
import {
  SHARE_SCHEMA_VERSION,
  inspectImport,
  manifestOfHire,
  manifestOfProfile,
  payloadOf,
  type ImportResult,
  type InstalledFacts,
  type ShareEnvelope
} from '../../shared/share'
import type { ProfileStore } from '../profiles'

/**
 * Export and import of hires and profiles (FR-10.4, ADR-0012 — SDD §1.1
 * `harbor/hires.ts`).
 *
 * The judgement lives in `src/shared/share.ts`, which is pure and refuses
 * without touching a disk. This module is the part that needs a filesystem:
 * finding what to export, and — only after a human has confirmed — writing an
 * accepted bundle into the harness home.
 *
 * ## Why `install` is a separate call from `inspect`
 *
 * FR-10.4 is exact: *"import only pre-fills the spawn form — a human always
 * confirms."* So `inspect` reads a blob and returns a disclosure; it writes
 * nothing and starts nothing. `install` is what a confirmed form reaches, and
 * it writes files and nothing else — the imported profile still has to be
 * ACTIVATED, which is its own human action through `profiles:activate`.
 *
 * Two human steps rather than one, and deliberately: ADR-0012 says the human
 * confirms activation, and nothing here shortens that to a single click on a
 * screen showing a summary the payload could contradict.
 */

export interface HireExchangeOptions {
  /** Where accepted imports land: `<harness home>/profiles`. */
  readonly homeProfilesDir: string
  /** Reads what is already installed, so an import cannot silently widen it. */
  readonly store: ProfileStore
  now?(): Date
}

export type ExportResult =
  | { readonly ok: true; readonly blob: string; readonly filename: string }
  | { readonly ok: false; readonly reason: string }

export type InstallResult =
  | { readonly ok: true; readonly name: string; readonly replaced: boolean }
  | { readonly ok: false; readonly reasons: readonly string[] }

export class HireExchange {
  private readonly now: () => Date

  constructor(private readonly options: HireExchangeOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Contract: exports one role template, by `<profile>/<hire>`.
   *
   * A hire template is not a free-floating file in this system — it lives
   * inside a bundle (`profiles/<name>/hires/*.json`), which is why the address
   * is qualified. Exporting one by bare name would have needed a second,
   * flatter place hire templates live, and two places is how the org layer's
   * versioning would start disagreeing with the bundle's.
   */
  exportHire(profile: string, hire: string): ExportResult {
    const loaded = this.options.store.load(profile)
    if (!loaded.ok) return { ok: false, reason: `no profile "${profile}"` }
    const template = loaded.bundle.hires.find((candidate) => candidate.name === hire)
    if (template === undefined) {
      return { ok: false, reason: `profile "${profile}" has no hire "${hire}"` }
    }
    const envelope: ShareEnvelope = {
      schemaVersion: SHARE_SCHEMA_VERSION,
      kind: 'hire',
      exportedAt: this.now().toISOString(),
      manifest: manifestOfHire(template),
      hire: template
    }
    return {
      ok: true,
      blob: `${JSON.stringify(envelope, null, 2)}\n`,
      filename: `${hireRef(template).replace('@', '-v')}.eph-hire.json`
    }
  }

  /** Contract: exports a whole bundle as the FILES it is made of. */
  exportProfile(name: string): ExportResult {
    const files = this.options.store.filesOf(name)
    if (files === null) return { ok: false, reason: `no profile "${name}"` }
    const manifest = manifestOfProfile(files)
    if (manifest === null) {
      // An invalid bundle is not exported. Sharing one would spread a refusal
      // rather than a profile, and the importer's reasons would describe a
      // mistake the exporter could have seen first.
      return { ok: false, reason: `profile "${name}" does not currently validate` }
    }
    const envelope: ShareEnvelope = {
      schemaVersion: SHARE_SCHEMA_VERSION,
      kind: 'profile',
      exportedAt: this.now().toISOString(),
      manifest,
      profile: payloadOf(files)
    }
    return {
      ok: true,
      blob: `${JSON.stringify(envelope, null, 2)}\n`,
      filename: `${name}.eph-profile.json`
    }
  }

  /**
   * Contract: inspects a blob and returns what importing it WOULD do. Writes
   * nothing, starts nothing.
   *
   * The installed facts are looked up here rather than passed in, so the
   * widening check cannot be skipped by a caller that forgot to supply them.
   */
  inspect(blob: string): ImportResult {
    const installed = this.installedFacts(nameIn(blob))
    if ('unreadable' in installed) return { ok: false, reasons: [installed.unreadable] }
    return inspectImport(blob, installed.facts)
  }

  /**
   * Contract: writes an inspected, human-confirmed import into the harness
   * home. Re-inspects first — the blob is the only thing trusted to describe
   * itself, and a caller that inspected once and installed something else is
   * exactly the confusion this package exists to prevent.
   *
   * Writes files. Does NOT activate: the imported profile is inert until the
   * Architect activates it, which is its own action.
   */
  install(blob: string): InstallResult {
    const inspected = this.inspect(blob)
    if (!inspected.ok) return { ok: false, reasons: inspected.reasons }
    if (inspected.payload === null) {
      return { ok: false, reasons: ['import: a hire template is not installed on its own'] }
    }

    const payload = inspected.payload
    const dir = path.join(this.options.homeProfilesDir, payload.name)

    // Defence in depth on the one path that WRITES. `profilePayloadSchema`
    // already refuses a file name containing a separator or `..`, so nothing
    // should reach here — but this is the call that turns author-controlled
    // text into a filesystem path, and a directory escape here lands on the
    // Watch's own policy file. One schema regex is thin cover for that.
    const escapes = escapingNames(payload)
    if (escapes.length > 0) {
      return {
        ok: false,
        reasons: escapes.map(
          (name) => `import: "${name}" is not a bare file name and would write outside the bundle`
        )
      }
    }

    const replaced = fs.existsSync(dir)

    // REPLACE, never merge. `install` used to mkdir and write the payload's
    // files over whatever was already there, so a v2 that dropped a hire or a
    // trigger left the old one on disk and the loader read back the UNION of
    // the two. The Architect would have confirmed a manifest listing two hires
    // and got three — and the third would still be armed. Removing the
    // directory first makes what is installed equal to what was disclosed.
    if (replaced) fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(path.join(dir, 'hires'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'triggers'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'playbooks'), { recursive: true })

    // Atomic writes, like everything another process reads (invariant §3).
    writeFileAtomic(path.join(dir, 'profile.json'), payload.profileJson)
    writeFileAtomic(path.join(dir, 'memo-policy.json'), payload.memoPolicyJson)
    writeFileAtomic(path.join(dir, 'harbor.json'), payload.harborJson)
    for (const [file, body] of Object.entries(payload.hires)) {
      writeFileAtomic(path.join(dir, 'hires', file), body)
    }
    for (const [file, body] of Object.entries(payload.triggers)) {
      writeFileAtomic(path.join(dir, 'triggers', file), body)
    }
    for (const [file, body] of Object.entries(payload.playbooks)) {
      writeFileAtomic(path.join(dir, 'playbooks', file), body)
    }

    return { ok: true, name: payload.name, replaced }
  }

  /**
   * What a same-named profile already installed here is allowed to do, or a
   * refusal when one exists and cannot be read.
   *
   * The refusal matters. Returning null for an unreadable profile would skip
   * the widening check entirely — so a bundle that arrives while the installed
   * copy happens to be broken gets more latitude than one that arrives while it
   * is healthy, which is the wrong way round. "We cannot tell what this name is
   * allowed to do" is a reason to stop, not to proceed.
   */
  private installedFacts(
    name: string | null
  ): { readonly facts: InstalledFacts | null } | { readonly unreadable: string } {
    if (name === null) return { facts: null }
    const loaded = this.options.store.load(name)
    if (loaded.ok) return { facts: factsOf(loaded.bundle) }
    // Absent is fine — this is a first-time import. Present-but-broken is not.
    const exists = this.options.store.list().some((row) => row.name === name)
    if (!exists) return { facts: null }
    return {
      unreadable: `import: a profile named "${name}" is already installed here but does not currently validate, so what it is allowed to do cannot be compared — repair or remove it first`
    }
  }
}

/**
 * Contract: every file name in a payload that is not a bare name. Pure.
 *
 * Exported and tested directly, not folded inline into `install`. The schema
 * already refuses these (`profilePayloadSchema`), so nothing reaches the
 * inline check through the normal path — and a guard no test can reach is the
 * shape of defect this build has already paid for once (the M6 Herald). Giving
 * it a name makes it testable code with one production caller, so the
 * redundancy is deliberate depth rather than dead weight: if the schema is
 * ever relaxed, this still stands between untrusted text and `path.join`.
 */
export function escapingNames(payload: {
  readonly hires: Readonly<Record<string, string>>
  readonly triggers: Readonly<Record<string, string>>
  readonly playbooks: Readonly<Record<string, string>>
}): readonly string[] {
  return [
    ...Object.keys(payload.hires),
    ...Object.keys(payload.triggers),
    ...Object.keys(payload.playbooks)
  ].filter((name) => path.basename(name) !== name || name === '..' || name === '.')
}

/** The installed authority of a bundle, in the shape the comparison needs. */
export function factsOf(bundle: ProfileBundle): InstalledFacts {
  return {
    envGrants: [...new Set(bundle.hires.flatMap((hire: HireTemplate) => hire.envGrants))].sort(),
    autonomy: GATE_KINDS.map((kind: GateKind) => ({
      kind,
      level: requestedAutonomy(bundle.document.autonomy, kind) as AutonomyLevel
    }))
  }
}

/**
 * The name a blob claims, read without trusting anything else about it.
 *
 * Only used to look up what is already installed under that name; every real
 * decision is made by `inspectImport` from the payload, so a blob that lies
 * here buys nothing — it would simply be compared against the wrong (or no)
 * installed profile, and then refused for the mismatch.
 */
function nameIn(blob: string): string | null {
  try {
    const raw: unknown = JSON.parse(blob)
    if (typeof raw !== 'object' || raw === null) return null
    const manifest = (raw as { manifest?: unknown }).manifest
    if (typeof manifest !== 'object' || manifest === null) return null
    const name = (manifest as { name?: unknown }).name
    return typeof name === 'string' ? name : null
  } catch {
    return null
  }
}
