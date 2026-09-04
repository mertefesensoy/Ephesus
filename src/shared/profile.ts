import { z } from 'zod'
import { autonomyLevelSchema, GATE_KINDS, type AutonomyLevel } from './gates'
import { memoTriggerSchema } from './memo'
import { hireTemplateSchema, type HireTemplate } from './org'
import { isolationModeSchema } from './isolation'
import { exitPolicySchema } from './respawn'

/**
 * Mission profiles (ADR-0012, FR-9.1/9.4, SDD §2 `profiles/<name>/`, §7.5).
 *
 * ADR-0012's central claim is that Skeleton Crew and Front Office are not
 * features but *configurations* — "they exercise no private APIs, proving the
 * format is sufficient". Everything in this file exists to make that claim
 * checkable: if a built-in needs a field the schema does not have, the claim is
 * false and the fork ADR-0012 was written to prevent has already happened.
 *
 * Two rules govern every line here.
 *
 * - **Playbooks are prose, policy is data.** Judgment lives in the markdown
 *   runbooks agents read; anything mechanically enforced — autonomy levels,
 *   memo triggers, env grants, budgets — is JSON the harness reads. So a
 *   playbook is carried as TEXT and is never parsed, matched, or consulted for
 *   a decision. The same split as ADR-0005.
 * - **The schema is a public contract from the day it ships.** It is
 *   transcribed from ADR-0012's bundle listing and the SRS clauses that name
 *   its parts, and it is not extended past them. A field nobody can point at a
 *   document for is a field the next migration has to carry forever.
 *
 * Loading is defined here as a PURE function over file text (`parseProfile`);
 * reading the files is `src/main/profiles.ts`'s job. That split is the same one
 * `parseWatchlist`/`stoa.ts` uses, and it is what lets the refusal table be a
 * unit test instead of a temp-directory rig.
 */

export const PROFILE_SCHEMA_VERSION = 1

/**
 * A profile's name, which is also its directory name under `profiles/`. The
 * two are checked against each other at load: a bundle whose `profile.json`
 * disagrees with the directory it sits in is refused rather than silently
 * renamed, because the registry (`SDD §4.1`) records the name and a mismatch
 * would make a spawned agent unattributable to the bundle that spawned it.
 */
export const profileNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'a lowercase profile name like skeleton-crew')

/**
 * The hire a profile names when it wants root causes checked by somebody who
 * did not write them (`src/shared/root-cause.ts`).
 *
 * A CONVENTION over the bundle, deliberately not a schema field. ADR-0012's
 * rule is "playbooks are prose, policy is data", and this is data of the
 * cheapest kind: a profile that wants an independent verifier adds a hire by
 * this name and one gets spawned with its own brief, its own engine and its own
 * `budget.dailyTokens` — which is also the honest answer to who pays for the
 * second opinion, in a line the Architect reads on the activation screen before
 * agreeing to it. A profile that does not add one gets its incidents triaged and
 * unverified, and the incident log says so on every incident.
 *
 * Adding a `verifier` FIELD to `profile.json` was the alternative. It was
 * rejected because the schema is a public contract from the day it ships
 * (see below) and this needs no new contract: hires are already a list, already
 * carry a budget, and are already instantiated one-agent-per-hire at activation.
 * The name is short on purpose — it becomes part of an agent id, and the id is
 * capped at 64 characters with the profile and target names already spent.
 */
export const VERIFIER_HIRE = 'verifier'

/**
 * What a profile binds to. ADR-0012: "Activation instantiates the hires as
 * agents bound to a **target** (a repo/app)". The concrete target arrives at
 * activation (M7.2) — `profile.json` declares only the KIND it accepts, so a
 * bundle written for repositories cannot be pointed at an app by a typo.
 */
export const TARGET_KINDS = ['repo', 'app'] as const
export const targetKindSchema = z.enum(TARGET_KINDS)
export type TargetKind = z.infer<typeof targetKindSchema>

/**
 * How the registry names a concrete target: `repo:myapp` (SDD §4.1's
 * `"target": "repo:myapp"`). Defined here beside the kind it is built from so
 * the two cannot drift.
 */
export const targetRefSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(repo|app):[A-Za-z0-9][\w.\-/]*$/, 'a target ref like repo:myapp')

/**
 * The profile's autonomy declaration.
 *
 * LEVELS, not rules. SDD §9 is exact about this — "profile autonomy levels can
 * only *loosen* up to global maxima — stricter wins" — so a profile says how
 * much latitude a class of action gets and nothing else. It carries no spend
 * cap, no channel list and no repeat-back flag, because those are the global
 * `gate-policy.json`'s to set (`src/shared/gates.ts`): a bundle that could
 * name its own approval CHANNELS could grant itself remote approval of a
 * destructive act, which is a privilege the file would be handing itself.
 *
 * `default` applies to any gate kind `byKind` does not mention. Both are
 * composed against the global policy by taking the stricter side (M7.2); the
 * values here are a ceiling request, never an entitlement.
 */
export const profileAutonomySchema = z
  .object({
    default: autonomyLevelSchema,
    /**
     * Per-class overrides, keyed by the gate kinds `gates.ts` already names.
     * A partial record: an unmentioned kind takes `default`, and an unknown
     * key is refused by `.strict()` rather than ignored — a typo'd
     * `"destructve": "manual"` that silently fell back to a laxer default is
     * exactly the silent privilege escalation FR-11.1 exists to prevent.
     */
    byKind: z
      .object(
        Object.fromEntries(GATE_KINDS.map((kind) => [kind, autonomyLevelSchema.optional()])) as {
          [K in (typeof GATE_KINDS)[number]]: z.ZodOptional<typeof autonomyLevelSchema>
        }
      )
      .strict()
  })
  .strict()

export type ProfileAutonomy = z.infer<typeof profileAutonomySchema>

/**
 * `profile.json` — ADR-0012's "name, version, target binding, autonomy levels",
 * plus the `schemaVersion` the ADR requires ("it is versioned … with a
 * migration path from day one") and ENGINEERING-STANDARDS §3 makes mandatory.
 *
 * There is deliberately no description, title or icon. The activation UI shows
 * "what this profile MAY do" by reading the hires, triggers, grants and
 * autonomy it actually carries (M7.2) — a prose blurb beside those facts is a
 * second place for the bundle to describe itself, and the one a reader would
 * believe over the mechanism.
 */
export const profileDocumentSchema = z
  .object({
    schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
    name: profileNameSchema,
    /**
     * Bumped whenever anything in the bundle changes. ADR-0012: "the org layer
     * (UC-12) edits hire templates *inside* profiles, so profile versioning
     * doubles as the performance-review changelog" — the number is a record,
     * not decoration.
     */
    version: z.number().int().min(1).max(10_000),
    target: z.object({ kind: targetKindSchema }).strict(),
    autonomy: profileAutonomySchema,
    /**
     * The bundle's default isolation, for hires that declare none (M8.6).
     *
     * The middle layer of `composeIsolation`: a profile whose whole point is
     * that its agents never touch the Architect's checkout says so once, here,
     * instead of repeating itself in every hire template.
     */
    isolation: isolationModeSchema.optional(),
    /** The bundle's default exit policy, for hires that declare none (M8.6). */
    onExit: exitPolicySchema.optional()
  })
  .strict()

export type ProfileDocument = z.infer<typeof profileDocumentSchema>

/**
 * `triggers/*.json` — ADR-0012's "schedules (cron-like) + event bindings
 * (webhook, CI, health)".
 *
 * Every trigger names the hire it wakes and the playbook that hire follows,
 * because SDD §7.5's incident path runs
 * `webhook/health trigger ─► profile trigger binding ─► on-call agent task` —
 * a binding that named no agent could not produce the task, and one that named
 * no playbook would leave the agent to improvise the runbook.
 *
 * "Cron-like" is an INTERVAL here, not a cron expression: `scheduler.ts` ships
 * `Trigger.everyMs` with idempotent ticks (SDD §1.1), and a cron parser would
 * be a new dependency — a BUILD-PROMPT §8.3 must-ask — bought for a precision
 * ("every Tuesday at 03:00") nothing in the SRS asks for.
 */
export const TRIGGER_EVENTS = ['webhook', 'ci', 'health'] as const
export const triggerEventSchema = z.enum(TRIGGER_EVENTS)
export type TriggerEvent = z.infer<typeof triggerEventSchema>

export const triggerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'a lowercase trigger id')

const triggerBaseFields = {
  id: triggerIdSchema,
  /** The hire template this trigger wakes, by `hireTemplate.name`. */
  hire: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'a lowercase template name'),
  /** The runbook that hire follows, by file name under `playbooks/`. */
  playbook: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*\.md$/, 'a playbook file name like incident.md')
}

export const profileTriggerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...triggerBaseFields,
      kind: z.literal('schedule'),
      /**
       * Minimum one minute. Not a style preference: `SchedulerLoop` fires a
       * trigger at most once per interval, so a sub-minute interval would ask
       * the company to start work faster than a turn can finish, and the guard
       * belongs where the number is written rather than in the scheduler that
       * would merely absorb it.
       */
      everyMs: z
        .number()
        .int()
        .min(60_000)
        .max(30 * 24 * 60 * 60 * 1_000)
    })
    .strict(),
  z.object({ ...triggerBaseFields, kind: z.literal('event'), event: triggerEventSchema }).strict()
])

export type ProfileTrigger = z.infer<typeof profileTriggerSchema>

/**
 * `memo-policy.json` — ADR-0012's "which action classes require decision memos
 * (feeds ADR-0008)".
 *
 * The classes are `MEMO_TRIGGERS` and only those. `src/shared/memo.ts` says why
 * in its own words: ADR-0008 calls memo-policy granularity the Architect's
 * tuning knob, so a profile that could name a fifth class would be turning a
 * knob that is not its. What a profile CAN do is choose which of the four it
 * requires — which is exactly the knob ADR-0008 hands it.
 */
export const profileMemoPolicySchema = z
  .object({
    schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
    /**
     * Action classes this profile holds for a memo. An empty list is legal and
     * means "this profile adds no memo requirement" — it does not disable the
     * global policy, which composes on top (ADR-0008's engine is the Odeon's,
     * not the bundle's).
     */
    requires: z.array(memoTriggerSchema).max(16)
  })
  .strict()

export type ProfileMemoPolicy = z.infer<typeof profileMemoPolicySchema>

/**
 * `harbor.json` — ADR-0012's "integration wiring: repos, channels, webhook
 * endpoints".
 *
 * Only `repos` has a consumer in M7 (M7.3's `gh` ingestion, FR-10.1); channels
 * and webhook endpoints are wired by the chat bridge in M7b (FR-10.2). They are
 * schema'd now because ADR-0012 names all three in the bundle and because
 * adding a field later costs a migration — but they are schema'd as NAMES and
 * IDS only. No URL, token, or endpoint secret has a field to live in: a profile
 * is shareable by design (FR-10.4), and a bundle with somewhere to put a
 * credential is a bundle that will eventually be exported carrying one.
 */
export const profileHarborSchema = z
  .object({
    schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
    /** Registered repositories, `owner/repo` as the `gh` CLI names them. */
    repos: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .max(64)
              .regex(/^[a-z0-9][a-z0-9-]*$/, 'a lowercase repo id'),
            remote: z
              .string()
              .min(3)
              .max(200)
              .regex(/^[\w.-]+\/[\w.-]+$/, 'a remote like owner/repo')
          })
          .strict()
      )
      .max(64),
    /** Chat channels by name; the bridge that resolves them lands in M7b. */
    channels: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .max(64)
              .regex(/^[a-z0-9][a-z0-9-]*$/, 'a lowercase channel id'),
            name: z.string().min(1).max(120)
          })
          .strict()
      )
      .max(32),
    /**
     * Inbound webhook endpoints this profile listens on, by the event they
     * carry. A PATH, never a URL: the endpoint is one the harness exposes
     * (FR-10.2's inbound webhooks), so an outbound address here would be a
     * profile telling the company where to send its data.
     */
    webhooks: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .max(64)
              .regex(/^[a-z0-9][a-z0-9-]*$/, 'a lowercase webhook id'),
            event: triggerEventSchema
          })
          .strict()
      )
      .max(32)
  })
  .strict()

export type ProfileHarbor = z.infer<typeof profileHarborSchema>

/**
 * One runbook, carried as text.
 *
 * The type has no parsed half on purpose. ADR-0012 draws the line here
 * ("playbooks are prose, policy is data"), and a `sections`, `steps` or
 * `severity` field on this interface would be the first crack in it: once a
 * playbook has machine-readable parts, a later package will read a policy out
 * of one, and the bundle will have two places that say what is allowed.
 */
export interface Playbook {
  /** File name under `playbooks/`, e.g. `incident.md`. */
  readonly file: string
  /** The markdown, verbatim. Never parsed. */
  readonly text: string
}

/** A loaded, validated bundle — ADR-0012's six parts. */
export interface ProfileBundle {
  readonly name: string
  readonly document: ProfileDocument
  readonly hires: readonly HireTemplate[]
  readonly triggers: readonly ProfileTrigger[]
  readonly playbooks: readonly Playbook[]
  readonly memoPolicy: ProfileMemoPolicy
  readonly harbor: ProfileHarbor
}

/** The files a bundle is made of, as text — what `parseProfile` consumes. */
export interface ProfileFiles {
  /** Directory name; must match `profile.json`'s `name`. */
  readonly name: string
  readonly profileJson: string
  /** `hires/<file>` → contents. At least one; a profile with no roles hires nobody. */
  readonly hires: ReadonlyMap<string, string>
  /** `triggers/<file>` → contents. May be empty (a profile can be manual-only). */
  readonly triggers: ReadonlyMap<string, string>
  /** `playbooks/<file>` → markdown. Carried, never parsed. */
  readonly playbooks: ReadonlyMap<string, string>
  readonly memoPolicyJson: string
  readonly harborJson: string
}

export type ProfileParse =
  | { readonly ok: true; readonly bundle: ProfileBundle }
  | { readonly ok: false; readonly name: string; readonly reasons: readonly string[] }

/**
 * The migration ladder. Empty at v1, and that is the honest state: there is no
 * older profile document in existence to migrate.
 *
 * The LADDER is what ADR-0012 asks for ("a migration path from day one"), not a
 * migration — so the walk below exists, is total, and refuses in every case it
 * cannot handle. A loader that shrugged at an unknown `schemaVersion` and
 * parsed the document anyway would be the silent fallback invariant §7 forbids,
 * wearing a version number.
 */
export type ProfileMigration = (raw: Record<string, unknown>) => Record<string, unknown>

export const PROFILE_MIGRATIONS: Readonly<Record<number, ProfileMigration>> = {}

export type ProfileMigrateResult =
  | { readonly ok: true; readonly raw: Record<string, unknown> }
  | { readonly ok: false; readonly reasons: readonly string[] }

/**
 * Contract: walks a raw `profile.json` up to `target`, or says why it cannot.
 * Pure; never throws.
 *
 * `ladder` and `target` are parameters rather than module constants so the walk
 * itself is exercisable on day one, when the production ladder is empty. A
 * mechanism whose only test is "the empty case does nothing" is a mechanism
 * nobody has run.
 *
 * Refusals, all of them by name:
 *  - not an object, or no integer `schemaVersion` — nothing to migrate FROM;
 *  - a version ABOVE `target` — written by a newer Ephesus; downgrading would
 *    mean dropping fields this build cannot see, which is data loss disguised
 *    as compatibility;
 *  - a gap in the ladder — the step is named, so the missing migration is a
 *    thing somebody can go and write.
 */
export function migrateProfileDocument(
  raw: unknown,
  ladder: Readonly<Record<number, ProfileMigration>> = PROFILE_MIGRATIONS,
  target: number = PROFILE_SCHEMA_VERSION
): ProfileMigrateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reasons: ['profile.json: not a JSON object'] }
  }
  let doc = { ...(raw as Record<string, unknown>) }
  const from = doc.schemaVersion
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 1) {
    return { ok: false, reasons: ['profile.json: schemaVersion missing or not a positive integer'] }
  }
  if (from > target) {
    return {
      ok: false,
      reasons: [
        `profile.json: schemaVersion ${String(from)} is newer than this Ephesus understands (${String(target)})`
      ]
    }
  }
  for (let version = from; version < target; version += 1) {
    const step = ladder[version]
    if (step === undefined) {
      return {
        ok: false,
        reasons: [
          `profile.json: no migration from schemaVersion ${String(version)} to ${String(version + 1)}`
        ]
      }
    }
    doc = { ...step(doc), schemaVersion: version + 1 }
  }
  return { ok: true, raw: doc }
}

/** Every zod issue on one file, prefixed with the file it came from. */
function issuesOf(file: string, error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : file
    return `${file}: ${where === file ? '' : `${where}: `}${issue.message}`
  })
}

function parseJson(
  file: string,
  body: string
): { ok: true; raw: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, raw: JSON.parse(body) as unknown }
  } catch (err) {
    return {
      ok: false,
      reason: `${file}: not JSON — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
    }
  }
}

/**
 * Contract: validates a whole bundle, or lists EVERYTHING wrong with it under
 * the profile's name. Pure — no fs, no clock, no activation. Never throws.
 *
 * Every reason at once, for the reason `parseWatchlist` gives: the Architect
 * fixing a bundle by hand gets one list, not a game of whack-a-mole where each
 * fix reveals the next refusal.
 *
 * The refusal is the feature. ADR-0012 chose declarative bundles so the
 * Architect could "read what this profile may do before activating"; a loader
 * that filled a missing `memo-policy.json` with a default would have made that
 * reading a lie, because the bundle on disk and the profile in memory would
 * differ in exactly the field that decides what gets held for a memo.
 */
export function parseProfile(files: ProfileFiles): ProfileParse {
  const reasons: string[] = []

  const documentJson = parseJson('profile.json', files.profileJson)
  let document: ProfileDocument | null = null
  if (!documentJson.ok) {
    reasons.push(documentJson.reason)
  } else {
    const migrated = migrateProfileDocument(documentJson.raw)
    if (!migrated.ok) {
      reasons.push(...migrated.reasons)
    } else {
      const parsed = profileDocumentSchema.safeParse(migrated.raw)
      if (!parsed.success) {
        reasons.push(...issuesOf('profile.json', parsed.error))
      } else {
        document = parsed.data
        if (parsed.data.name !== files.name) {
          reasons.push(
            `profile.json: name "${parsed.data.name}" does not match its directory "${files.name}"`
          )
        }
      }
    }
  }

  const hires: HireTemplate[] = []
  if (files.hires.size === 0) reasons.push('hires/: a profile must declare at least one hire')
  for (const [file, body] of [...files.hires].sort(([a], [b]) => a.localeCompare(b))) {
    const where = `hires/${file}`
    const json = parseJson(where, body)
    if (!json.ok) {
      reasons.push(json.reason)
      continue
    }
    const parsed = hireTemplateSchema.safeParse(json.raw)
    if (!parsed.success) reasons.push(...issuesOf(where, parsed.error))
    else hires.push(parsed.data)
  }
  const hireNames = new Set(hires.map((hire) => hire.name))
  if (hireNames.size !== hires.length) {
    reasons.push('hires/: two hires share a template name')
  }

  const triggers: ProfileTrigger[] = []
  for (const [file, body] of [...files.triggers].sort(([a], [b]) => a.localeCompare(b))) {
    const where = `triggers/${file}`
    const json = parseJson(where, body)
    if (!json.ok) {
      reasons.push(json.reason)
      continue
    }
    const parsed = profileTriggerSchema.safeParse(json.raw)
    if (!parsed.success) reasons.push(...issuesOf(where, parsed.error))
    else triggers.push(parsed.data)
  }
  if (new Set(triggers.map((trigger) => trigger.id)).size !== triggers.length) {
    reasons.push('triggers/: two triggers share an id')
  }

  // A trigger naming a hire or a playbook the bundle does not contain is
  // refused, not dropped. SDD §7.5 makes the binding the thing that turns an
  // incident into a task; a binding that resolves to nothing is a watcher the
  // Architect believes is on duty and is not.
  const playbookFiles = new Set(files.playbooks.keys())
  for (const trigger of triggers) {
    if (hires.length > 0 && !hireNames.has(trigger.hire)) {
      reasons.push(
        `triggers/: "${trigger.id}" names hire "${trigger.hire}", which this profile has no template for`
      )
    }
    if (!playbookFiles.has(trigger.playbook)) {
      reasons.push(
        `triggers/: "${trigger.id}" names playbook "${trigger.playbook}", which this profile does not carry`
      )
    }
  }

  const memoJson = parseJson('memo-policy.json', files.memoPolicyJson)
  let memoPolicy: ProfileMemoPolicy | null = null
  if (!memoJson.ok) reasons.push(memoJson.reason)
  else {
    const parsed = profileMemoPolicySchema.safeParse(memoJson.raw)
    if (!parsed.success) reasons.push(...issuesOf('memo-policy.json', parsed.error))
    else memoPolicy = parsed.data
  }

  const harborJson = parseJson('harbor.json', files.harborJson)
  let harbor: ProfileHarbor | null = null
  if (!harborJson.ok) reasons.push(harborJson.reason)
  else {
    const parsed = profileHarborSchema.safeParse(harborJson.raw)
    if (!parsed.success) reasons.push(...issuesOf('harbor.json', parsed.error))
    else harbor = parsed.data
  }

  if (document === null || memoPolicy === null || harbor === null || reasons.length > 0) {
    return { ok: false, name: files.name, reasons }
  }

  return {
    ok: true,
    bundle: {
      name: files.name,
      document,
      hires,
      triggers,
      // Prose, carried verbatim and in a stable order. Nothing reads it.
      playbooks: [...files.playbooks]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, text]) => ({ file, text })),
      memoPolicy,
      harbor
    }
  }
}

/**
 * Contract: the autonomy this profile REQUESTS for a gate kind — its own
 * declaration, before composition.
 *
 * Named `requested` rather than `for` because the answer is not what the agent
 * gets. Composition against the global policy happens in M7.2 and takes the
 * stricter side (`composeAutonomy`); a caller that used this value directly
 * would have let a bundle grant itself latitude, which is the exact direction
 * FR-11.1 forbids.
 */
export function requestedAutonomy(
  autonomy: ProfileAutonomy,
  kind: (typeof GATE_KINDS)[number]
): AutonomyLevel {
  return autonomy.byKind[kind] ?? autonomy.default
}

/** Every secret NAME the bundle's hires declare (ADR-0010: names, never values). */
export function declaredEnvGrants(bundle: ProfileBundle): readonly string[] {
  return [...new Set(bundle.hires.flatMap((hire) => hire.envGrants))].sort()
}
