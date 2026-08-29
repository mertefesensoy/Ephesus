import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './fsx'
import {
  EMPTY_WATCHLIST,
  STOA_SCHEMA_VERSION,
  buildStudyPlan,
  checkRegistrar,
  isSafeScratchPath,
  nextBriefId,
  parseWatchlist,
  parseWatchlistMarkdown,
  registerDraftSchema,
  sourceIdFor,
  uniqueSourceId,
  type RegisterDraft,
  type StudyPlan,
  type Watchlist,
  type WatchlistEntry
} from '../shared/stoa'
import {
  briefFileName,
  checkBriefAgainstSource,
  parseResearchBrief,
  renderBrief
} from '../shared/stoa-brief'
import type { Message } from '../shared/message'
import type { PromptStore } from './prompts'

/**
 * The Stoa's driver (ADR-0017, FR-13, SDD §4.7/§7.7).
 *
 * `agora/stoa/watchlist.json` is the ONLY set of sources the company may
 * study, and this class is the only thing that writes it. Two properties are
 * load-bearing and both are structural rather than advisory:
 *
 * - **Curation is Architect-only** (R1, FR-13.1). `register`/`retire` take a
 *   `by` from the CALLER, and the only caller that may pass `architect` is the
 *   IPC handler — which knows it is the Architect because the call arrived on
 *   the window bridge. Nothing here accepts a claimed identity from an agent,
 *   and there is no agent-facing path to this file at all.
 * - **Nothing is deleted.** Retiring moves an entry to `retired`, verbatim.
 *   The build-phase watchlist strikes retired rows through rather than
 *   removing them, and the running system keeps that habit: a source the
 *   company used to study is part of how its briefs came to exist.
 *
 * At first run the watchlist seeds from the repository's own `docs/stoa/`
 * (FR-13.7) — the markdown table AND `briefs/`, together. The Gymnasium seed
 * shipped its ledger without its proposals once and every row's link broke
 * (M5 close-out audit, finding 3); a watchlist whose briefs did not cross over
 * would be the same half-archive one subsystem over.
 */

/**
 * The Stoa's cadence (SDD §7.7). One study a day: a reading list the Architect
 * curates by hand does not grow fast enough to justify more, and a researcher
 * spawn costs Gymnasium budget (R4) that the missions are also paying for.
 */
export const STOA_EVERY_MS = 24 * 60 * 60 * 1000

export interface StoaOptions {
  readonly agoraRoot: string
  /** The repo's build-phase archive: `docs/stoa/` (FR-13.7). */
  readonly seedFrom: string
  /**
   * Where a study checks a watched source out. NEVER the Agora and never one
   * of its worktrees (ADR-0004, NFR-17) — asserted, not assumed.
   */
  readonly scratchRoot?: string
  /** `<home>/worktrees` — refused as a checkout target for the same reason. */
  readonly worktreesRoot?: string
  /**
   * Invariant §8: the researcher's instructions — the injection rule included —
   * are rendered from `prompts/stoa/`, never written as literals here. A study
   * plan with no prompt store carries `instructions: null`, which is a visible
   * degradation rather than a silently un-briefed researcher.
   */
  readonly prompts?: PromptStore | null
  /** `log` kind `stoa` (SDD §4.3) — every curation event. */
  onLogEvent?(draft: { kind: 'stoa' } & Record<string, unknown>): void
  commitSoon?(subject: string): void
  onDegraded?(detail: string): void
  now?(): Date
}

export type PlanOutcome =
  | {
      readonly ok: true
      readonly plan: StudyPlan
      /** The rendered study prompt, or null when no prompt store is wired. */
      readonly instructions: string | null
    }
  | { readonly ok: false; readonly reason: string }

export type FileBriefOutcome =
  | {
      readonly ok: true
      readonly briefId: string
      readonly findings: number
      readonly commit: string
    }
  | { readonly ok: false; readonly reasons: readonly string[] }

export type CurateOutcome =
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: string }

/** One archived brief, as the panel lists it. */
export interface ArchivedBrief {
  readonly id: string
  readonly title: string
  readonly file: string
}

export class Stoa {
  private readonly now: () => Date

  constructor(private readonly options: StoaOptions) {
    this.now = options.now ?? (() => new Date())
  }

  private stoaDir(): string {
    return path.join(this.options.agoraRoot, 'stoa')
  }

  private watchlistPath(): string {
    return path.join(this.stoaDir(), 'watchlist.json')
  }

  private briefsDir(): string {
    return path.join(this.stoaDir(), 'briefs')
  }

  /**
   * The watchlist, seeding it from the repo's archive on first use (FR-13.7).
   *
   * A missing or unreadable seed is a DEGRADATION, not a failure: the company
   * can still be given sources by hand, it just starts with none, and it says
   * so out loud (invariant §7). A malformed watchlist on disk is reported the
   * same way and read as empty rather than crashing the boot — but it is never
   * overwritten, because the file may be the only copy of what was registered.
   */
  watchlist(): Watchlist {
    const file = this.watchlistPath()
    if (existsSync(file)) {
      const parsed = parseWatchlist(readFileSync(file, 'utf8'))
      if (parsed.ok) return parsed.watchlist
      this.options.onDegraded?.(
        `stoa: ${file} is not a valid watchlist (${parsed.reasons.join('; ')}); reading it as empty and leaving the file untouched`
      )
      return EMPTY_WATCHLIST
    }
    return this.seed()
  }

  /** Every source the Stoa may study, in registration order. */
  sources(): readonly WatchlistEntry[] {
    return this.watchlist().sources
  }

  /**
   * Registers one source (FR-13.1, R1).
   *
   * Contract: `by` comes from the caller and must be `architect`. The draft
   * carries no id, no registrar and no timestamp — main mints all three, so an
   * untrusted surface has no field with which to claim provenance.
   */
  register(draft: RegisterDraft, by: string): CurateOutcome {
    const allowed = checkRegistrar(by)
    if (!allowed.allowed) return this.refuse('register', by, allowed.because)

    const parsed = registerDraftSchema.safeParse(draft)
    if (!parsed.success) {
      return this.refuse(
        'register',
        by,
        parsed.error.issues
          .map(
            (issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'entry'}: ${issue.message}`
          )
          .join('; ')
      )
    }

    const current = this.watchlist()
    const taken = [...current.sources, ...current.retired].map((entry) => entry.id)
    const existing = current.sources.find((entry) => entry.url === parsed.data.url)
    if (existing !== undefined) {
      return { ok: false, reason: `${parsed.data.url} is already registered as ${existing.id}` }
    }
    const id = uniqueSourceId(sourceIdFor(parsed.data.url), taken)
    const entry: WatchlistEntry = {
      id,
      url: parsed.data.url,
      kind: 'git',
      tags: [...parsed.data.tags],
      license: parsed.data.license,
      pin: parsed.data.pin,
      registeredBy: 'architect',
      registeredAt: this.now().toISOString(),
      notes: parsed.data.notes
    }
    this.write({ ...current, sources: [...current.sources, entry] })
    this.options.onLogEvent?.({
      kind: 'stoa',
      event: 'registered',
      sourceId: id,
      by,
      url: entry.url,
      tags: [...entry.tags],
      license: entry.license,
      pin: entry.pin
    })
    this.options.commitSoon?.(`stoa: register ${id}`)
    return { ok: true, id }
  }

  /**
   * Retires one source (FR-13.1, R1).
   *
   * Contract: the entry MOVES to `retired`, verbatim and permanently. Retiring
   * is not deleting — the briefs a retired source produced still cite it, and a
   * citation whose source vanished from the record is a citation nobody can
   * check.
   */
  retire(id: string, by: string): CurateOutcome {
    const allowed = checkRegistrar(by)
    if (!allowed.allowed) return this.refuse('retire', by, allowed.because)

    const current = this.watchlist()
    const entry = current.sources.find((candidate) => candidate.id === id)
    if (entry === undefined) {
      const already = current.retired.some((candidate) => candidate.id === id)
      return {
        ok: false,
        reason: already ? `${id} is already retired` : `no source ${id} on the watchlist`
      }
    }
    this.write({
      ...current,
      sources: current.sources.filter((candidate) => candidate.id !== id),
      retired: [...current.retired, entry]
    })
    this.options.onLogEvent?.({ kind: 'stoa', event: 'retired', sourceId: id, by })
    this.options.commitSoon?.(`stoa: retire ${id}`)
    return { ok: true, id }
  }

  /**
   * The read-only, secret-free plan for studying one source (FR-13.2, NFR-17).
   *
   * Contract: a PLAN, not a spawn. The caller executes it; this makes the
   * security posture assertable without running anything, which is how S-STOA
   * proves "no secret grants" rather than trusting a comment.
   *
   * The checkout path is checked against the Agora and `worktrees/` here, even
   * though `buildStudyPlan` constructs it from a root this class supplies: the
   * one place a third-party repository must never land is the company's own
   * record, and a defence that depends on nobody passing the wrong root is not
   * a defence.
   */
  plan(sourceId: string): PlanOutcome {
    const entry = this.watchlist().sources.find((candidate) => candidate.id === sourceId)
    if (entry === undefined) {
      const retired = this.watchlist().retired.some((candidate) => candidate.id === sourceId)
      return {
        ok: false,
        reason: retired
          ? `${sourceId} is retired from the watchlist`
          : `no source ${sourceId} on the watchlist`
      }
    }
    const built = buildStudyPlan(
      entry,
      this.options.scratchRoot ?? path.join(this.stoaDir(), 'scratch')
    )
    if (!built.ok) {
      this.options.onLogEvent?.({
        kind: 'stoa',
        event: 'study-refused',
        sourceId,
        because: built.reason
      })
      return built
    }
    const agoraRoot = this.options.agoraRoot
    const worktrees = this.options.worktreesRoot ?? path.join(path.dirname(agoraRoot), 'worktrees')
    if (!isSafeScratchPath(built.plan.cwd, agoraRoot, worktrees)) {
      const reason = `stoa: refusing to check ${sourceId} out inside the Agora or its worktrees (ADR-0004, NFR-17)`
      this.options.onLogEvent?.({ kind: 'stoa', event: 'study-refused', sourceId, because: reason })
      return { ok: false, reason }
    }
    this.options.onLogEvent?.({
      kind: 'stoa',
      event: 'study-planned',
      sourceId,
      commit: built.plan.commit,
      readOnly: built.plan.readOnly,
      envGrants: built.plan.envGrants.length,
      intakePermitted: built.plan.intakePermitted
    })
    return { ok: true, plan: built.plan, instructions: this.instructionsFor(built.plan) }
  }

  /**
   * The researcher's briefing, rendered from `prompts/stoa/` (invariant §8).
   *
   * The injection rule lives in that file rather than in this one on purpose:
   * NFR-17 is the instruction most likely to need rewording as real sources
   * teach us how they phrase an attack, and a rule the Architect cannot edit
   * without a rebuild is a rule that ages badly.
   */
  private instructionsFor(plan: StudyPlan): string | null {
    const words = this.options.prompts
    if (!words) {
      this.options.onDegraded?.(
        `stoa: no prompt store; the study plan for ${plan.sourceId} carries no researcher instructions`
      )
      return null
    }
    const intakeNote = words
      .render(
        path.join('stoa', plan.intakePermitted ? 'intake-permitted.md' : 'intake-refused.md'),
        { license: plan.license }
      )
      .trim()
    return words
      .render(path.join('stoa', 'study.md'), {
        sourceId: plan.sourceId,
        url: plan.url,
        commit: plan.commit,
        question: plan.question,
        license: plan.license,
        cwd: plan.cwd,
        intakeNote
      })
      .trim()
  }

  /**
   * Takes one filed research brief and archives it, or refuses it (FR-13.3).
   *
   * Contract: the shape is enforced BEFORE any human is involved — the FR-12.2
   * pattern applied to research. A finding with no citation is not a weak
   * finding to argue about in review; it is a brief that does not exist yet,
   * because the whole value of the archive is that a reader can open what it
   * cites.
   *
   * Archiving is write-once. A brief is immutable (FR-13.4) and the proposals
   * that cite it must keep resolving to the words their author read, so a
   * second filing under an existing id is refused rather than merged.
   */
  fileBrief(message: Message): FileBriefOutcome {
    const parsed = parseResearchBrief(message.body)
    if (!parsed.ok) return this.refuseBrief(message, parsed.reasons)

    const entry = this.watchlist().sources.find(
      (candidate) => candidate.id === parsed.brief.sourceId
    )
    if (entry === undefined) {
      return this.refuseBrief(message, [
        `no source ${parsed.brief.sourceId} on the watchlist; a brief cites a source the Architect registered (FR-13.1)`
      ])
    }
    const against = checkBriefAgainstSource(parsed.brief, entry)
    if (!against.ok) return this.refuseBrief(message, against.reasons)

    const dir = this.briefsDir()
    mkdirSync(dir, { recursive: true })
    const id = nextBriefId(this.briefs().map((row) => row.id))
    const file = path.join(dir, briefFileName(id, parsed.brief.title))
    if (existsSync(file)) {
      return this.refuseBrief(message, [
        `${id} is already archived; briefs are immutable (FR-13.4)`
      ])
    }
    writeFileAtomic(file, renderBrief(id, parsed.brief, entry.url))

    const directives = parsed.brief.findings.filter((finding) => finding.directive).length
    this.options.onLogEvent?.({
      kind: 'stoa',
      event: 'brief-archived',
      briefId: id,
      sourceId: entry.id,
      by: message.from,
      commit: parsed.brief.commit,
      findings: parsed.brief.findings.length,
      // NFR-17: how many instructions the source aimed at its reader, and the
      // fact that they were written down rather than acted on. A later reader
      // auditing an incident wants this findable without opening the brief.
      directivesReported: directives
    })
    this.options.commitSoon?.(`stoa: archive ${id}`)
    return {
      ok: true,
      briefId: id,
      findings: parsed.brief.findings.length,
      commit: parsed.brief.commit
    }
  }

  private refuseBrief(message: Message, reasons: readonly string[]): FileBriefOutcome {
    this.options.onLogEvent?.({
      kind: 'stoa',
      event: 'brief-refused',
      by: message.from,
      msgId: message.id,
      reasons: [...reasons]
    })
    return { ok: false, reasons }
  }

  /** Every archived brief, newest id first. Immutable once archived (FR-13.4). */
  briefs(): readonly ArchivedBrief[] {
    const dir = this.briefsDir()
    // Reading the watchlist first has the side effect of seeding, which is what
    // brings the build-phase briefs across on a fresh home.
    this.watchlist()
    if (!existsSync(dir)) return []
    const briefs: ArchivedBrief[] = []
    for (const name of readdirSync(dir)) {
      const id = /^(RB-\d{3,})-/.exec(name)?.[1]
      if (id === undefined || !name.endsWith('.md')) continue
      const first = readFileSync(path.join(dir, name), 'utf8').split('\n')[0] ?? ''
      briefs.push({
        id,
        title: first
          .replace(/^#\s*/, '')
          .replace(new RegExp(`^${id}\\s*—\\s*`), '')
          .trim(),
        file: name
      })
    }
    return briefs.sort((a, b) => b.id.localeCompare(a.id))
  }

  /** One brief's text, as archived. Null when unknown. */
  brief(id: string): string | null {
    // Seed first, exactly as `briefs()` does. Without this, a fresh home whose
    // FIRST Stoa-touching action was a proposal citing a seeded brief refused
    // it — `briefExists` asked before anything had brought the build-phase
    // archive across (M5b close-out audit, finding 2; the M5 audit's
    // half-seeded-seam class, one method over).
    this.watchlist()
    const dir = this.briefsDir()
    if (!existsSync(dir)) return null
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${id}-`) && name.endsWith('.md')) {
        return readFileSync(path.join(dir, name), 'utf8')
      }
    }
    return null
  }

  /**
   * Seeds the watchlist and the brief archive from `docs/stoa/` (FR-13.7).
   *
   * Both halves cross over together, deliberately: the ledger seed that copied
   * a table without the documents its rows linked to is the exact defect the
   * M5 close-out audit found, and repeating it here would break every brief
   * reference a seeded source already has.
   */
  private seed(): Watchlist {
    const table = path.join(this.options.seedFrom, 'WATCHLIST.md')
    if (!existsSync(table)) {
      this.options.onDegraded?.(
        `stoa: no build-phase watchlist at ${table}; the Stoa starts with no sources`
      )
      this.write(EMPTY_WATCHLIST)
      return EMPTY_WATCHLIST
    }

    const sources = parseWatchlistMarkdown(readFileSync(table, 'utf8'), this.now().toISOString())
    const seeded: Watchlist = { schemaVersion: STOA_SCHEMA_VERSION, sources, retired: [] }
    this.write(seeded)

    const seedBriefs = path.join(this.options.seedFrom, 'briefs')
    let copied = 0
    if (existsSync(seedBriefs)) {
      const target = this.briefsDir()
      mkdirSync(target, { recursive: true })
      for (const name of readdirSync(seedBriefs)) {
        if (!/^RB-\d{3,}-.*\.md$/.test(name)) continue
        writeFileAtomic(path.join(target, name), readFileSync(path.join(seedBriefs, name), 'utf8'))
        copied += 1
      }
    }

    this.options.onLogEvent?.({
      kind: 'stoa',
      event: 'seeded',
      from: table,
      sources: sources.length,
      briefs: copied
    })
    this.options.commitSoon?.('stoa: seed the watchlist from the build-phase archive')
    return seeded
  }

  /** The watchlist file, written atomically (invariant §3). */
  private write(watchlist: Watchlist): void {
    mkdirSync(this.stoaDir(), { recursive: true })
    writeFileAtomic(this.watchlistPath(), `${JSON.stringify(watchlist, null, 2)}\n`)
  }

  private refuse(event: string, by: string, because: string): CurateOutcome {
    // A refused curation attempt is exactly what a later reader will look for
    // (NFR-13), so it is an event in its own right rather than a silent false.
    this.options.onLogEvent?.({ kind: 'stoa', event: `${event}-refused`, by, because })
    return { ok: false, reason: because }
  }
}
