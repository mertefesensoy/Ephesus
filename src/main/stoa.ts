import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './fsx'
import {
  EMPTY_WATCHLIST,
  STOA_SCHEMA_VERSION,
  checkRegistrar,
  parseWatchlist,
  parseWatchlistMarkdown,
  registerDraftSchema,
  sourceIdFor,
  uniqueSourceId,
  type RegisterDraft,
  type Watchlist,
  type WatchlistEntry
} from '../shared/stoa'

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

export interface StoaOptions {
  readonly agoraRoot: string
  /** The repo's build-phase archive: `docs/stoa/` (FR-13.7). */
  readonly seedFrom: string
  /** `log` kind `stoa` (SDD §4.3) — every curation event. */
  onLogEvent?(draft: { kind: 'stoa' } & Record<string, unknown>): void
  commitSoon?(subject: string): void
  onDegraded?(detail: string): void
  now?(): Date
}

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
