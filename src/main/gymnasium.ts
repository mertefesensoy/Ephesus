import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './fsx'
import {
  DEFAULT_GYM_SLICE,
  checkVerdict,
  checkWidening,
  measuredOutcome,
  nextGymId,
  parseGymProposal,
  parseLedger,
  renderRow,
  withinSlice,
  type GymProposal,
  type GymRow,
  type VerdictName
} from '../shared/gym'
import type { Message } from '../shared/message'
import { citedBriefIds } from '../shared/stoa-brief'

/**
 * The Gymnasium's driver (ADR-0015, FR-12, SDD §7.6).
 *
 * `agora/gymnasium/LEDGER.md` is append-only and total: rows are added, never
 * edited away, and a rejected or regressed row stays because ADR-0015 calls it
 * training data for better proposals. Status changes rewrite the row in place
 * — the FILE is the record and the row is its current state — but no row is
 * ever removed, and the count only grows.
 *
 * At first run the ledger seeds from the repository's own `docs/gymnasium/`
 * (FR-12.6), so the improvement archive is continuous from the build phase into
 * the running system rather than starting empty on the day the product ships.
 */

export interface GymnasiumOptions {
  readonly agoraRoot: string
  /** The repo's build-phase archive, seeded at first run (FR-12.6). */
  readonly seedFrom: string
  /** Tokens gym work has spent this week, folded from the ledger (R3). */
  /**
   * Gym spend, attributed and sourced (M6.7). Returning the SOURCE beside the
   * number is what the M5 close-out asked for: the brief prints both.
   */
  gymSpend?(): { readonly tokens: number; readonly source: string }
  readonly slice?: { readonly tokensPerWeek: number }
  /**
   * Does this research brief exist in the archive? (FR-13.4)
   *
   * Wired to the Stoa. Absent means "no Stoa" and brief citations go
   * unchecked — a degradation of the check, not of the proposal: a company
   * with no research department has no briefs to mis-cite.
   */
  briefExists?(briefId: string): boolean
  /** `log` kind `gym` (SDD §4.3) — every transition. */
  onLogEvent?(draft: { kind: 'gym' } & Record<string, unknown>): void
  commitSoon?(subject: string): void
  onDegraded?(detail: string): void
  now?(): Date
}

export type ProposeOutcome =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reasons: readonly string[] }

export type VerdictOutcome =
  | { readonly ok: true; readonly id: string; readonly status: string }
  | { readonly ok: false; readonly reason: string }

export class Gymnasium {
  private readonly now: () => Date

  constructor(private readonly options: GymnasiumOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** `<agora>/gymnasium/LEDGER.md`, seeded from the repo at first read. */
  private ledgerPath(): string {
    return path.join(this.options.agoraRoot, 'gymnasium', 'LEDGER.md')
  }

  /**
   * The ledger markdown, seeding it from the repo's archive on first use.
   *
   * FR-12.6: the loop already exists in the repository, so the running system
   * inherits it rather than starting over. A missing seed is a degradation, not
   * a failure — the company can still improve itself, it just starts with no
   * history, and it says so.
   */
  private read(): string {
    const file = this.ledgerPath()
    if (existsSync(file)) return readFileSync(file, 'utf8')

    mkdirSync(path.dirname(file), { recursive: true })
    const seed = path.join(this.options.seedFrom, 'LEDGER.md')
    if (existsSync(seed)) {
      const text = readFileSync(seed, 'utf8')
      writeFileAtomic(file, text)
      // SDD §2 seeds `proposals/GYM-*.md` WITH the ledger — the rows link to
      // them, and a ledger whose every link is broken is half an archive
      // (M5 close-out audit, finding 4).
      const seedProposals = path.join(this.options.seedFrom, 'proposals')
      if (existsSync(seedProposals)) {
        const target = path.join(path.dirname(file), 'proposals')
        mkdirSync(target, { recursive: true })
        for (const name of readdirSync(seedProposals)) {
          if (!name.endsWith('.md')) continue
          writeFileAtomic(
            path.join(target, name),
            readFileSync(path.join(seedProposals, name), 'utf8')
          )
        }
      }
      this.options.onLogEvent?.({ kind: 'gym', event: 'seeded', from: seed })
      this.options.commitSoon?.('gymnasium: seed the ledger from the build-phase archive')
      return text
    }
    this.options.onDegraded?.(
      `gymnasium: no build-phase archive at ${seed}; the ledger starts empty`
    )
    const empty = EMPTY_LEDGER
    writeFileAtomic(file, empty)
    return empty
  }

  /** Every row on file, in ledger order (R2 — the ledger is total). */
  rows(): readonly GymRow[] {
    return parseLedger(this.read())
  }

  /**
   * Files one proposal (FR-12.2).
   *
   * Contract: the shape is enforced BEFORE any human is involved. A proposal
   * with no falsifiable metric or no rollback is refused here, and so is one
   * that would widen the Gymnasium's own authority — the second refusal does
   * not consult a verdict, because FR-12.3 does not make it conditional on one.
   */
  propose(message: Message): ProposeOutcome {
    const parsed = parseGymProposal(message.body)
    if (!parsed.ok) return this.refuse(message, parsed.reasons)

    // FR-13.4: a brief is evidence, and a proposal that says it descends from
    // one must cite a brief that exists. A citation to an unarchived RB id is
    // the uncited-finding problem wearing a different hat — it looks like
    // provenance and resolves to nothing.
    const cited = citedBriefIds(parsed.proposal.evidence)
    const missing = this.options.briefExists
      ? cited.filter((briefId) => !this.options.briefExists?.(briefId))
      : []
    if (missing.length > 0) {
      return this.refuse(
        message,
        missing.map(
          (briefId) =>
            `evidence cites ${briefId}, which is not in the Stoa archive; a proposal cites a brief that exists (FR-13.4)`
        )
      )
    }

    const widening = checkWidening(parsed.proposal)
    if (widening.refused) {
      // Logged as its own event: an attempt to widen authority is exactly the
      // thing a later reader will want to find (NFR-13).
      this.options.onLogEvent?.({
        kind: 'gym',
        event: 'refused-widening',
        by: message.from,
        title: parsed.proposal.title,
        because: [...widening.because]
      })
      return { ok: false, reasons: widening.because }
    }

    if (
      !withinSlice(this.options.gymSpend?.().tokens ?? 0, this.options.slice ?? DEFAULT_GYM_SLICE)
    ) {
      // R3: improvement is budgeted, not ambient.
      const reason = 'the Gymnasium budget slice for this week is spent (R3)'
      return this.refuse(message, [reason])
    }

    const at = this.now().toISOString()
    const rows = this.rows()
    const id = nextGymId(rows)
    const row: GymRow = {
      id,
      idCell: id,
      title: parsed.proposal.title,
      class: parsed.proposal.class,
      status: 'proposed',
      metric: `${parsed.proposal.metric.what} → ${parsed.proposal.metric.target}`,
      proposedBy: message.from,
      proposedAt: at,
      decidedBy: null,
      decidedAt: null,
      measured: null,
      outcome: null
    }
    this.append(row)
    this.writeProposal(id, parsed.proposal, message.from, at)
    this.options.onLogEvent?.({
      kind: 'gym',
      event: 'proposed',
      gymId: id,
      by: message.from,
      class: parsed.proposal.class,
      evidence: [...parsed.proposal.evidence],
      // Recorded on the event so the proof gate can count Stoa-seeded
      // proposals (SRS §6.9) from the log alone, without re-reading every
      // proposal document.
      briefs: cited
    })
    this.options.commitSoon?.(`gymnasium: ${id} proposed`)
    return { ok: true, id }
  }

  /**
   * Records the Architect's verdict (FR-12.3, R1).
   *
   * Contract: `decidedBy` is supplied by the CALLER, and the only caller that
   * may pass `architect` is the IPC handler, which knows it is the Architect
   * because the message came over the window bridge. Nothing here takes a
   * claimed identity from an agent.
   */
  verdict(id: string, verdict: VerdictName, decidedBy: string): VerdictOutcome {
    const rows = this.rows()
    const row = rows.find((candidate) => candidate.id === id)
    if (row === undefined) return { ok: false, reason: `no proposal ${id} on file` }

    const proposedBy = this.proposerOf(id)
    const check = checkVerdict(row, decidedBy, proposedBy)
    if (!check.allowed) {
      this.options.onLogEvent?.({
        kind: 'gym',
        event: 'verdict-refused',
        gymId: id,
        by: decidedBy,
        because: check.because
      })
      return { ok: false, reason: check.because }
    }

    const at = this.now().toISOString()
    this.append({ ...row, status: verdict, decidedBy, decidedAt: at })
    this.options.onLogEvent?.({ kind: 'gym', event: verdict, gymId: id, by: decidedBy })
    this.options.commitSoon?.(`gymnasium: ${id} ${verdict}`)
    return { ok: true, id, status: verdict }
  }

  /** Marks an approved proposal landed, so its metric check can be booked. */
  land(id: string): VerdictOutcome {
    const row = this.rows().find((candidate) => candidate.id === id)
    if (row === undefined) return { ok: false, reason: `no proposal ${id} on file` }
    if (row.status !== 'approved') {
      return { ok: false, reason: `${id} is ${row.status}, not approved` }
    }
    this.append({ ...row, status: 'landed' })
    this.options.onLogEvent?.({ kind: 'gym', event: 'landed', gymId: id })
    this.options.commitSoon?.(`gymnasium: ${id} landed`)
    return { ok: true, id, status: 'landed' }
  }

  /**
   * Records the measured outcome (FR-12.4).
   *
   * `null` means "could not be measured", which counts as a miss: a change
   * whose effect cannot be established is not a change that worked, and the
   * proposal's rollback is what happens next.
   */
  measure(id: string, measured: string | null): VerdictOutcome {
    const row = this.rows().find((candidate) => candidate.id === id)
    if (row === undefined) return { ok: false, reason: `no proposal ${id} on file` }
    if (row.status !== 'landed') {
      return { ok: false, reason: `${id} is ${row.status}, not landed` }
    }
    const status = measuredOutcome(measured)
    this.append({
      ...row,
      status,
      // The Measured cell flips from its "due …" note to the date the check
      // actually ran — the row tells its own history (ADR-0015 R2).
      measured: this.now().toISOString().slice(0, 10),
      outcome: measured ?? 'not measurable'
    })
    this.options.onLogEvent?.({
      kind: 'gym',
      event: status,
      gymId: id,
      measured,
      // FR-12.4: a regression rolls back per the proposal.
      rollback: status === 'regressed'
    })
    this.options.commitSoon?.(`gymnasium: ${id} ${status}`)
    return { ok: true, id, status }
  }

  /** One proposal document as filed, for the panel. Null when unknown. */
  proposalDoc(id: string): string | null {
    const dir = path.join(this.options.agoraRoot, 'gymnasium', 'proposals')
    if (!existsSync(dir)) return null
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${id}-`)) return readFileSync(path.join(dir, name), 'utf8')
    }
    return null
  }

  /**
   * What the standup brief reports about the slice (R3, FR-12.5).
   *
   * `spentTokens` is null only when nothing attributes gym spend at all —
   * reporting zero would claim a measurement nobody had taken (invariant §7).
   * Since M6.7 something does: `shared/attribution.ts` folds the DURABLE
   * ledger over the improvement roles, so the figure survives a restart
   * (invariant §11) and `source` names the agents it covers — a bare total
   * invites the reader to trust a scope they cannot see.
   */
  slice(): {
    readonly spentTokens: number | null
    readonly tokensPerWeek: number
    readonly source: string | null
  } {
    const spend = this.options.gymSpend
    return {
      spentTokens: spend ? spend().tokens : null,
      tokensPerWeek: (this.options.slice ?? DEFAULT_GYM_SLICE).tokensPerWeek,
      source: spend ? spend().source : null
    }
  }

  /**
   * Records a company-mode change on the ledger document (FR-14.5, UC-15).
   *
   * On the ledger and not merely in the log, because UC-15's postcondition
   * says every mode change is in both — and because the ledger is the document
   * a human opens to ask "how did this company come to be running itself?".
   *
   * It lives in its own section under the proposals table rather than as a row
   * in it: a mode change is not a proposal, and forcing it into eight columns
   * meant for one would corrupt the table the parser and the reader both rely
   * on. The Gymnasium writes it because the Gymnasium owns this file — one
   * writer, no second opinion about what the ledger says.
   */
  recordModeChange(change: {
    readonly from: string
    readonly to: string
    readonly by: string
    readonly reason: string
    readonly at: string
  }): void {
    const text = this.read().replace(/[\n]+$/, '')
    const line = `| ${change.at} | ${change.from} → ${change.to} | ${change.by} | ${change.reason} |`
    if (text.includes(MODE_HEADING)) {
      writeFileAtomic(this.ledgerPath(), `${text}\n${line}\n`)
      return
    }
    writeFileAtomic(
      this.ledgerPath(),
      [
        text,
        '',
        MODE_HEADING,
        '',
        'Every change of company mode (ADR-0018), with who made it and why.',
        'Append-only, like everything else here.',
        '',
        '| When | Change | By | Reason |',
        '|---|---|---|---|',
        line,
        ''
      ].join('\n')
    )
  }

  /**
   * Adds or updates a row, and rewrites the table.
   *
   * The FILE is append-only in the sense ADR-0015 means: no row is ever
   * removed, and a row's status advances in place along the documented flow.
   * The count is asserted never to shrink.
   */
  private append(row: GymRow): void {
    const existing = this.rows()
    const kept = existing.filter((candidate) => candidate.id !== row.id)
    const rows = [...kept, row].sort((a, b) => a.id.localeCompare(b.id))
    if (rows.length < existing.length) {
      throw new Error('gymnasium: a ledger write would have lost a row')
    }
    const lines = this.read().split('\n')
    const tableAt = lines.findIndex((line) => line.startsWith('| ID |'))
    const preamble =
      tableAt === -1 ? EMPTY_LEDGER.split('\n').slice(0, -3) : lines.slice(0, tableAt)
    // Everything BELOW the table survives the rewrite. The first version of
    // this function kept only the preamble, so any section a human — or the
    // mode recorder (FR-14.5) — added under the table was silently deleted by
    // the next proposal. The ledger is a document, and a document that eats
    // its own footer is not a record.
    let after = tableAt === -1 ? lines.length : tableAt
    while (after < lines.length && (lines[after] ?? '').startsWith('|')) after += 1
    const postamble = tableAt === -1 ? [] : lines.slice(after)
    const text = [
      ...preamble,
      '| ID | Title | Status | Success metric | Proposed | Decided | Measured | Outcome |',
      '|---|---|---|---|---|---|---|---|',
      ...rows.map(renderRow),
      ...(postamble.length > 0 ? postamble : [''])
    ].join('\n')
    writeFileAtomic(this.ledgerPath(), text)
  }

  /** The proposal file, written once and never revised (invariant §5). */
  private writeProposal(id: string, proposal: GymProposal, by: string, at: string): void {
    const dir = path.join(this.options.agoraRoot, 'gymnasium', 'proposals')
    mkdirSync(dir, { recursive: true })
    const slug = proposal.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)
    writeFileAtomic(
      path.join(dir, `${id}-${slug}.md`),
      [
        `# ${id} — ${proposal.title}`,
        '',
        `- class: ${proposal.class}`,
        `- proposed by: ${by}`,
        `- proposed: ${at}`,
        '',
        '## Evidence',
        '',
        ...proposal.evidence.map((ref) => `- ${ref}`),
        '',
        '## Change',
        '',
        proposal.change,
        '',
        '## Cost and risk',
        '',
        proposal.costRisk,
        '',
        '## Success metric',
        '',
        `${proposal.metric.what} → ${proposal.metric.target}`,
        `(measured within ${String(proposal.metric.windowDays)} day(s))`,
        '',
        '## Rollback',
        '',
        proposal.rollback,
        ''
      ].join('\n')
    )
  }

  /** Who filed a proposal, read back off its file. */
  private proposerOf(id: string): string {
    const dir = path.join(this.options.agoraRoot, 'gymnasium', 'proposals')
    if (!existsSync(dir)) return ''
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${id}-`)) continue
      const match = /^- proposed by: (.+)$/m.exec(readFileSync(path.join(dir, name), 'utf8'))
      return match?.[1]?.trim() ?? ''
    }
    return ''
  }

  private refuse(message: Message, reasons: readonly string[]): ProposeOutcome {
    this.options.onLogEvent?.({
      kind: 'gym',
      event: 'rejected',
      by: message.from,
      msgId: message.id,
      reasons: [...reasons]
    })
    return { ok: false, reasons }
  }
}

/** The heading the mode-change section lives under. */
const MODE_HEADING = '## Mode changes'

const EMPTY_LEDGER = [
  '# Gymnasium ledger — self-improvement record',
  '',
  'Rows are never deleted: rejected and regressed entries are the training data',
  'for better proposals (ADR-0015 R2).',
  '',
  '| ID | Title | Status | Success metric | Proposed | Decided | Measured | Outcome |',
  '|---|---|---|---|---|---|---|---|',
  ''
].join('\n')
