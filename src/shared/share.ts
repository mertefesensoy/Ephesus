import { z } from 'zod'
import { AUTONOMY_RANK, GATE_KINDS, type AutonomyLevel, type GateKind } from './gates'
import { hireTemplateSchema, type HireTemplate } from './org'
import { parseProfile, profileNameSchema, requestedAutonomy, type ProfileFiles } from './profile'
import { secretShapeIn } from './secret-shapes'

/**
 * Shareable hires and profiles (FR-10.4, ADR-0012 — M7.6).
 *
 * FR-10.4: *"export/import a role template via link/file; import only pre-fills
 * the spawn form — a human always confirms."* ADR-0012 extends it to whole
 * bundles: *"shareable like hires … and diffable in review since they're plain
 * files."*
 *
 * The package's risk line is the design constraint: **an imported profile is
 * UNTRUSTED CONTENT (invariant §13's spirit) — it may not raise its own
 * privileges on the way in.**
 *
 * ## Two decisions that shape everything here
 *
 * **The envelope carries FILES, not a parsed bundle.** ADR-0012's whole
 * argument for declarative bundles is that they are plain files, diffable in
 * review; an envelope carrying a re-serialized object would hand the reviewer a
 * diff of the importer's formatting rather than of what the author wrote, and
 * round-tripping would be lossless only for the fields this build happens to
 * know. Carrying the text makes `export → import` lossless by construction.
 *
 * **The manifest is DERIVED, never trusted.** An envelope carries a manifest —
 * the disclosure a human reads before confirming: which secret names it wants,
 * what autonomy it asks for, which repositories it would reach. On import that
 * manifest is recomputed from the payload by the same function that produced
 * it, and a mismatch is refused by name. That single check is what makes the
 * confirmation meaningful: without it, the human would be approving a summary
 * the payload is free to contradict, which is not a gate but a decoration.
 */

export const SHARE_SCHEMA_VERSION = 1

export const SHARE_KINDS = ['hire', 'profile'] as const
export const shareKindSchema = z.enum(SHARE_KINDS)
export type ShareKind = z.infer<typeof shareKindSchema>

/**
 * What the Architect is shown before confirming an import.
 *
 * Every field answers "what would this be allowed to do", because that is the
 * question a confirmation is for. Nothing here is decorative and nothing is
 * free text the author controls: it is all derived from the payload.
 */
export const shareManifestSchema = z
  .object({
    kind: shareKindSchema,
    name: z.string().min(1).max(64),
    /** Secret NAMES across every hire (ADR-0010 — names, never values). */
    envGrants: z.array(z.string().min(1).max(64)).max(64),
    /** Role templates the payload carries, by name. */
    hires: z.array(z.string().min(1).max(64)).max(64),
    /** Per-class autonomy the profile REQUESTS. Empty for a hire. */
    autonomy: z
      .array(
        z.object({ kind: z.string().min(1).max(32), level: z.string().min(1).max(32) }).strict()
      )
      .max(32),
    /** Trigger ids that would be armed. Empty for a hire. */
    triggers: z.array(z.string().min(1).max(64)).max(64),
    /** Runbook file names. Empty for a hire. */
    playbooks: z.array(z.string().min(1).max(120)).max(64),
    /** Repositories the instance would reach through the Harbor (FR-10.1). */
    repos: z.array(z.string().min(1).max(200)).max(64),
    /**
     * A digest over the PROSE the bundle carries — every hire's brief and every
     * playbook's text.
     *
     * The rest of this manifest is names: which grants, which hires, which
     * triggers. A replacement whose names are all identical therefore discloses
     * as "nothing changed" while having rewritten every runbook — and a playbook
     * is the agent's actual task list, on a timer, with whatever autonomy the
     * profile holds. That is the sharpest thing a shared bundle can change
     * without changing a single name.
     *
     * A digest rather than the text itself: the manifest is a disclosure a human
     * reads, and pasting four runbooks into it would bury the grants and the
     * autonomy rows that also need reading. What this buys is the ability to say
     * "the instructions changed" — the files are plain and diffable (ADR-0012),
     * so the diff is where the reading happens.
     */
    proseDigest: z.string().min(1).max(64)
  })
  .strict()

export type ShareManifest = z.infer<typeof shareManifestSchema>

/**
 * A file NAME inside a bundle: a bare name, and nothing that could be a path.
 *
 * This is load-bearing, not tidiness. `install` writes each entry with
 * `path.join(dir, 'playbooks', name)`, and `path.join` resolves `..` — so a
 * shared bundle carrying a playbook called `../../../gate-policy.json` would
 * write OUTSIDE its own directory, over the Watch's policy file. SDD §2 says
 * that file "can only ever loosen, never tighten", so an attacker who reaches
 * it turns the whole approval system off.
 *
 * Found by an adversarial pass against this module before it shipped; the
 * regression is `test/shared/share.test.ts` "refuses a file name that escapes
 * the bundle directory".
 */
const bundleFileName = (extension: 'json' | 'md'): z.ZodString =>
  z
    .string()
    .min(1)
    .max(120)
    .regex(
      extension === 'json' ? /^[a-z0-9][a-z0-9-]*\.json$/ : /^[a-z0-9][a-z0-9-]*\.md$/,
      `a bare file name like example.${extension} — no path separators, no ".."`
    )

/** A bundle's files, as JSON can carry them (`ProfileFiles` has Maps). */
export const profilePayloadSchema = z
  .object({
    name: profileNameSchema,
    profileJson: z.string().min(1).max(200_000),
    hires: z.record(bundleFileName('json'), z.string().max(200_000)),
    triggers: z.record(bundleFileName('json'), z.string().max(200_000)),
    playbooks: z.record(bundleFileName('md'), z.string().max(200_000)),
    memoPolicyJson: z.string().min(1).max(200_000),
    harborJson: z.string().min(1).max(200_000)
  })
  .strict()

export type ProfilePayload = z.infer<typeof profilePayloadSchema>

export const shareEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(SHARE_SCHEMA_VERSION),
    kind: shareKindSchema,
    /** ISO-8601. Informational only — nothing is decided from it. */
    exportedAt: z.string().min(1).max(64),
    manifest: shareManifestSchema,
    /** Exactly one of these is present, matching `kind`. */
    hire: z.unknown().optional(),
    profile: profilePayloadSchema.optional()
  })
  .strict()

export type ShareEnvelope = z.infer<typeof shareEnvelopeSchema>

/** `ProfileFiles` from the JSON-carryable payload. */
export function filesOf(payload: ProfilePayload): ProfileFiles {
  return {
    name: payload.name,
    profileJson: payload.profileJson,
    hires: new Map(Object.entries(payload.hires)),
    triggers: new Map(Object.entries(payload.triggers)),
    playbooks: new Map(Object.entries(payload.playbooks)),
    memoPolicyJson: payload.memoPolicyJson,
    harborJson: payload.harborJson
  }
}

/** The JSON-carryable payload from `ProfileFiles`. */
export function payloadOf(files: ProfileFiles): ProfilePayload {
  return {
    name: files.name,
    profileJson: files.profileJson,
    hires: Object.fromEntries(files.hires),
    triggers: Object.fromEntries(files.triggers),
    playbooks: Object.fromEntries(files.playbooks),
    memoPolicyJson: files.memoPolicyJson,
    harborJson: files.harborJson
  }
}

/**
 * Contract: the manifest for one hire template. Pure and total.
 *
 * Used on BOTH sides — export writes it, import recomputes it and compares. One
 * function, so a manifest that matches is a manifest that was honestly derived,
 * and the comparison cannot be defeated by an exporter that summarizes
 * differently from the importer.
 */
export function manifestOfHire(template: HireTemplate): ShareManifest {
  return {
    kind: 'hire',
    name: template.name,
    envGrants: [...template.envGrants].sort(),
    hires: [template.name],
    autonomy: [],
    triggers: [],
    playbooks: [],
    repos: [],
    proseDigest: digestOf([template.brief])
  }
}

/**
 * A short, stable digest of the prose a bundle carries.
 *
 * FNV-1a rather than a crypto hash, and deliberately: this is not a signature
 * and must not be mistaken for one. Nothing here authenticates an author or
 * resists a determined forger — the manifest is recomputed from the payload on
 * import, so the digest's whole job is to make "the instructions are not the
 * ones you approved last time" VISIBLE to a human comparing two imports. A
 * SHA-256 would imply a guarantee this design does not make.
 */
export function digestOf(parts: readonly string[]): string {
  let hash = 0x811c9dc5
  for (const part of [...parts].sort()) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= 0x2f
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`
}

/** Contract: the manifest for a whole bundle. Pure; throws only on bad input. */
export function manifestOfProfile(files: ProfileFiles): ShareManifest | null {
  const parsed = parseProfile(files)
  if (!parsed.ok) return null
  const { bundle } = parsed
  return {
    kind: 'profile',
    name: bundle.name,
    envGrants: [...new Set(bundle.hires.flatMap((hire) => hire.envGrants))].sort(),
    hires: bundle.hires.map((hire) => hire.name).sort(),
    // Every gate class, always — including the ones the bundle did not mention,
    // which take its default. A manifest that listed only the explicit
    // overrides would let a permissive DEFAULT arrive undisclosed.
    autonomy: GATE_KINDS.map((kind) => ({
      kind,
      level: requestedAutonomy(bundle.document.autonomy, kind)
    })),
    triggers: bundle.triggers.map((trigger) => trigger.id).sort(),
    playbooks: bundle.playbooks.map((playbook) => playbook.file).sort(),
    repos: bundle.harbor.repos.map((repo) => repo.remote).sort(),
    // Briefs AND playbooks: both are prose an agent reads as instructions.
    proseDigest: digestOf([
      ...bundle.hires.map((hire) => hire.brief),
      ...bundle.playbooks.map((playbook) => playbook.text)
    ])
  }
}

/**
 * What a same-named thing already installed here is allowed to do.
 *
 * Supplied by the caller (main reads it from the `ProfileStore`), because the
 * comparison below is the one that catches the sharpest attack in this package:
 * a shared bundle reusing a name the Architect already trusts, arriving with
 * more authority than the version they trusted.
 */
export interface InstalledFacts {
  readonly envGrants: readonly string[]
  readonly autonomy: readonly { readonly kind: GateKind; readonly level: AutonomyLevel }[]
}

export type ImportResult =
  | {
      readonly ok: true
      /** The bundle's files, ready to be written once a human confirms. */
      readonly payload: ProfilePayload | null
      readonly hire: HireTemplate | null
      /** The recomputed, trustworthy disclosure. */
      readonly manifest: ShareManifest
      /** True when a thing of this name is already installed here. */
      readonly replaces: boolean
    }
  | { readonly ok: false; readonly reasons: readonly string[] }

const AUTONOMY_ORDER: Readonly<Record<string, number>> = AUTONOMY_RANK

/**
 * Contract: inspects an import, or lists every reason it is refused. Pure; no
 * fs, no clock, no activation. Never throws.
 *
 * **It does not install anything.** The result is a pre-filled form — FR-10.4's
 * "import only pre-fills the spawn form — a human always confirms". Writing the
 * bundle to disk is a separate call a human action reaches, and there is no
 * path from here to a running agent.
 *
 * The refusals, and what each one is for:
 *
 * 1. **A credential in the payload.** ADR-0010 makes env grants NAMES the
 *    broker resolves; a value in a shared file is a leak already in progress,
 *    and importing it would spread it. Named by shape, never quoted.
 * 2. **A manifest that disagrees with its payload.** The disclosure the human
 *    reads must be the truth about what they are approving. This is the check
 *    that turns the confirmation from a decoration into a gate, and it is what
 *    catches an *undeclared env grant* — a hire quietly asking for a credential
 *    the summary did not list.
 * 3. **A widening of something already installed.** A shared bundle reusing a
 *    trusted name may not arrive with more autonomy or more grants than the
 *    version it replaces. Activation-time clamping does not cover this: the
 *    global ceiling might legitimately be high, and the point is that THIS
 *    profile's own request grew without anyone deciding it should.
 */
export function inspectImport(blob: string, installed: InstalledFacts | null = null): ImportResult {
  const reasons: string[] = []

  let raw: unknown
  try {
    raw = JSON.parse(blob)
  } catch (err) {
    return {
      ok: false,
      reasons: [
        `import: not JSON — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
      ]
    }
  }

  // (1) Every DECODED string in the document, not the raw text.
  //
  // Scanning the raw blob is the obvious thing and it is wrong: JSON lets a
  // string be written as `ghp…`, so a credential can be encoded
  // such that the raw text matches nothing while `JSON.parse` hands the
  // importer the real token. Walking the parsed value scans what the payload
  // MEANS rather than how it was spelled.
  //
  // Found by an adversarial pass against this module before it shipped; the
  // regression is "catches a credential written with JSON unicode escapes".
  const shape = secretShapeInValue(raw)
  if (shape !== null) {
    return {
      ok: false,
      reasons: [
        `import: the payload contains ${shape} — a shared bundle carries env grant NAMES only (ADR-0010), never a value`
      ]
    }
  }

  const envelope = shareEnvelopeSchema.safeParse(raw)
  if (!envelope.success) {
    return {
      ok: false,
      reasons: envelope.error.issues.map((issue) => {
        const where = issue.path.length > 0 ? issue.path.join('.') : 'import'
        return `${where}: ${issue.message}`
      })
    }
  }

  const { kind, manifest } = envelope.data

  if (kind === 'hire') {
    if (envelope.data.hire === undefined) {
      return { ok: false, reasons: ['import: kind is "hire" but no hire template is present'] }
    }
    const parsed = hireTemplateSchema.safeParse(envelope.data.hire)
    if (!parsed.success) {
      return {
        ok: false,
        reasons: parsed.error.issues.map(
          (issue) => `hire.${issue.path.join('.') || 'template'}: ${issue.message}`
        )
      }
    }
    const derived = manifestOfHire(parsed.data)
    reasons.push(...manifestMismatches(manifest, derived))
    reasons.push(...wideningsAgainstInstalled(derived, installed))
    if (reasons.length > 0) return { ok: false, reasons }
    return {
      ok: true,
      payload: null,
      hire: parsed.data,
      manifest: derived,
      replaces: installed !== null
    }
  }

  if (envelope.data.profile === undefined) {
    return { ok: false, reasons: ['import: kind is "profile" but no bundle is present'] }
  }
  const files = filesOf(envelope.data.profile)
  const parsed = parseProfile(files)
  if (!parsed.ok) {
    return { ok: false, reasons: parsed.reasons.map((reason) => `import: ${reason}`) }
  }
  const derived = manifestOfProfile(files)
  if (derived === null) {
    return { ok: false, reasons: ['import: the bundle could not be summarized'] }
  }
  reasons.push(...manifestMismatches(manifest, derived))
  reasons.push(...wideningsAgainstInstalled(derived, installed))
  if (reasons.length > 0) return { ok: false, reasons }

  return {
    ok: true,
    payload: envelope.data.profile,
    hire: null,
    manifest: derived,
    replaces: installed !== null
  }
}

/**
 * Contract: the first credential shape in any string reachable in `value`,
 * including object KEYS. Pure and total; never throws.
 *
 * Keys as well as values, because a bundle's file names and record keys are
 * author-controlled text too, and a scan that only read values would leave the
 * obvious place to hide one unexamined.
 *
 * Depth-bounded: a shared bundle is untrusted input, and a deeply nested
 * document should be refused by the schema rather than be allowed to exhaust
 * the stack here first.
 */
function secretShapeInValue(value: unknown, depth = 0): string | null {
  if (depth > 20) return null
  if (typeof value === 'string') return secretShapeIn(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = secretShapeInValue(item, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const inKey = secretShapeIn(key)
      if (inKey !== null) return inKey
      const found = secretShapeInValue(item, depth + 1)
      if (found !== null) return found
    }
  }
  return null
}

/** Every way the declared manifest differs from the derived one, by name. */
function manifestMismatches(declared: ShareManifest, derived: ShareManifest): readonly string[] {
  const out: string[] = []
  const compare = (field: string, a: readonly string[], b: readonly string[]): void => {
    const missing = b.filter((item) => !a.includes(item))
    const extra = a.filter((item) => !b.includes(item))
    for (const item of missing) {
      out.push(
        `import: the bundle asks for ${field} "${item}", which its manifest does not declare`
      )
    }
    for (const item of extra) {
      out.push(
        `import: the manifest declares ${field} "${item}", which the bundle does not contain`
      )
    }
  }

  if (declared.kind !== derived.kind) {
    out.push(`import: the manifest says "${declared.kind}" and the payload is a ${derived.kind}`)
  }
  if (declared.name !== derived.name) {
    out.push(
      `import: the manifest names "${declared.name}" and the payload names "${derived.name}"`
    )
  }
  compare('the env grant', declared.envGrants, derived.envGrants)
  compare('the hire', declared.hires, derived.hires)
  compare('the trigger', declared.triggers, derived.triggers)
  compare('the playbook', declared.playbooks, derived.playbooks)
  compare('the repository', declared.repos, derived.repos)
  if (declared.proseDigest !== derived.proseDigest) {
    out.push(
      'import: the manifest declares a prose digest that does not match the briefs and playbooks the bundle carries'
    )
  }

  for (const row of derived.autonomy) {
    const stated = declared.autonomy.find((candidate) => candidate.kind === row.kind)
    if (stated === undefined) {
      out.push(
        `import: the bundle requests "${row.level}" autonomy for ${row.kind}, which its manifest does not declare`
      )
      continue
    }
    if (stated.level !== row.level) {
      out.push(
        `import: the manifest declares "${stated.level}" autonomy for ${row.kind} and the bundle requests "${row.level}"`
      )
    }
  }
  return out
}

/** Every way this import would give a same-named thing more than it has. */
function wideningsAgainstInstalled(
  derived: ShareManifest,
  installed: InstalledFacts | null
): readonly string[] {
  if (installed === null) return []
  const out: string[] = []

  for (const grant of derived.envGrants) {
    if (!installed.envGrants.includes(grant)) {
      out.push(
        `import: this would add the env grant "${grant}" to "${derived.name}", which does not hold it — export it under a new name if that is intended`
      )
    }
  }

  for (const row of derived.autonomy) {
    const current = installed.autonomy.find((candidate) => candidate.kind === row.kind)
    if (current === undefined) continue
    const before = AUTONOMY_ORDER[current.level] ?? 0
    const after = AUTONOMY_ORDER[row.level] ?? 0
    if (after > before) {
      out.push(
        `import: this would raise ${row.kind} autonomy for "${derived.name}" from "${current.level}" to "${row.level}"`
      )
    }
  }
  return out
}
