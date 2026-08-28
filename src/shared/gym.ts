import { z } from 'zod'
import { agentIdSchema } from './agents'

/**
 * The Gymnasium (ADR-0015, FR-12, SDD §7.6, UC-13).
 *
 * The company's primary standing mission is to improve itself, and the reason
 * this file exists is that an *ungoverned* version of that is the classic
 * failure mode of autonomous systems: agents improving themselves into
 * unreviewable drift, gamed metrics, and safety regressions.
 *
 * ADR-0015's three hard rules are not advice here. They are the module:
 *
 * - **R1 — nothing self-approves.** The Architect is the approval authority for
 *   every Gymnasium class. Artemis may rank and pre-screen; she may not
 *   verdict, and no proposer may decide their own proposal.
 * - **R2 — the ledger is total.** Every proposal, rejection and measured
 *   outcome is a permanent row. Rejected and regressed rows are kept, because
 *   they are the training data for better proposals.
 * - **R3 — improvement is budgeted, not ambient**, so it can never starve the
 *   missions that pay for it.
 *
 * And the rule that guards the rules: **the Gymnasium may never widen its own
 * authority.** A proposal that would alter gym gating, an accepted ADR, or the
 * Watch's global maxima is refused mechanically — *regardless of who approves
 * it*, the Architect included. That is deliberate. A door that only opens from
 * the inside is not a door.
 */

export const GYM_SCHEMA_VERSION = 1

/**
 * The classes ADR-0015's authority table names. Every one of them is
 * Architect-approved; the class decides how much ceremony comes with it, not
 * whether a human is involved.
 */
export const GYM_CLASSES = [
  /** Playbooks, prompts, docs, tooling, tests. */
  'craft',
  /** Hire templates and role changes — routed through the org review (UC-12). */
  'org',
  /** Invariants, ADRs, gates, secrets, dependencies, the Gymnasium's own rules. */
  'constitutional'
] as const

export const gymClassSchema = z.enum(GYM_CLASSES)

export type GymClass = z.infer<typeof gymClassSchema>

export const GYM_STATUSES = [
  'proposed',
  'rejected',
  'approved',
  'landed',
  'validated',
  'regressed'
] as const

export const gymStatusSchema = z.enum(GYM_STATUSES)

export type GymStatus = z.infer<typeof gymStatusSchema>

export const gymIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^GYM-\d{3,}$/, 'a gym id like GYM-001')

/**
 * A proposal, as an agent files it.
 *
 * Every field here is required by FR-12.2, and each one is refused when absent
 * rather than defaulted — a proposal missing its metric or its rollback is
 * "invalid by construction", which only means anything if the construction
 * actually refuses it.
 */
export const gymProposalSchema = z
  .object({
    schemaVersion: z.literal(GYM_SCHEMA_VERSION),
    kind: z.literal('gym-proposal'),
    title: z.string().min(1).max(200),
    class: gymClassSchema,
    /**
     * FR-12.1: candidates derive only from recorded evidence. At least one ref,
     * because "no evidence, no proposal" is the first line of ADR-0015's loop.
     */
    evidence: z.array(z.string().min(1).max(128)).min(1).max(32),
    /** One scoped change. */
    change: z.string().min(1).max(20_000),
    costRisk: z.string().min(1).max(10_000),
    /**
     * The falsifiable part. A metric must say what is measured and what number
     * counts as success, or "measure the declared metric" has nothing to do.
     */
    metric: z
      .object({
        what: z.string().min(1).max(500),
        target: z.string().min(1).max(200),
        windowDays: z.number().int().min(1).max(365)
      })
      .strict(),
    rollback: z.string().min(1).max(10_000)
  })
  .strict()

export type GymProposal = z.infer<typeof gymProposalSchema>

export type GymParse =
  | { readonly ok: true; readonly proposal: GymProposal }
  | { readonly ok: false; readonly reasons: readonly string[] }

/**
 * Contract: parses a proposal, or lists everything wrong with it.
 *
 * Every reason at once, because FR-12.2 has the harness reject before a human
 * ever sees it — so the proposer's only feedback is this list, and a list of
 * one wastes a round trip per missing field.
 */
export function parseGymProposal(body: string): GymParse {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return { ok: false, reasons: [`gym: body is not JSON — ${reason(err)}`] }
  }
  const parsed = gymProposalSchema.safeParse(raw)
  if (parsed.success) return { ok: true, proposal: parsed.data }
  return {
    ok: false,
    reasons: parsed.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : 'proposal'
      return `${where}: ${issue.message}`
    })
  }
}

/**
 * Things the Gymnasium may never change, whoever approves it.
 *
 * Matched against the proposal's own words, deliberately generously: a false
 * positive costs one proposal a rewrite, and a false negative is the company
 * quietly editing the rules that govern it.
 */
const FORBIDDEN = [
  'adr-00',
  'accepted adr',
  'invariant',
  'gym gating',
  'gymnasium authority',
  'authority table',
  'global maxima',
  'gate-policy',
  'authority.json',
  'widen',
  'self-approve',
  'check-invariants'
]

export interface WideningCheck {
  readonly refused: boolean
  readonly because: readonly string[]
}

/**
 * Contract: would this proposal widen the Gymnasium's own authority?
 *
 * **Refused regardless of approver.** FR-12.3 does not say "unless the
 * Architect says otherwise", and neither does this: the check runs before any
 * verdict is possible and its answer does not depend on who is asking. An
 * Architect who genuinely wants to change an invariant edits the document and
 * supersedes the ADR by hand — outside the loop, in the open, where it is
 * reviewable. That is the point.
 */
export function checkWidening(proposal: GymProposal): WideningCheck {
  const haystack = `${proposal.title} ${proposal.change} ${proposal.rollback}`.toLowerCase()
  const hits = FORBIDDEN.filter((needle) => haystack.includes(needle))
  return {
    refused: hits.length > 0,
    because: hits.map((needle) => `the proposal touches "${needle}", which the Gymnasium may not`)
  }
}

/** One permanent row of the ledger (R2 — the ledger is total). */
export interface GymRow {
  readonly id: string
  /**
   * The ID cell exactly as the ledger writes it. The build-phase archive
   * links each id to its proposal file — `[GYM-001](./proposals/…)` — and a
   * status change must not flatten that into bare text: the ledger is a
   * document a human reads, not only a table a machine appends to.
   */
  readonly idCell: string
  readonly title: string
  readonly class: GymClass
  readonly status: GymStatus
  readonly metric: string
  readonly proposedBy: string
  readonly proposedAt: string
  readonly decidedBy: string | null
  readonly decidedAt: string | null
  /**
   * The Measured cell verbatim — "due 2026-09-11" before the check, the
   * measurement date after. Dropped by the first `renderRow`, which emitted
   * seven cells under the eight-column header, so every rewrite silently
   * erased it and the Outcome beside it (M5 close-out audit, finding 1 —
   * ADR-0015 R2 was mechanically false).
   */
  readonly measured: string | null
  readonly outcome: string | null
}

export type VerdictName = 'approved' | 'rejected'

/**
 * Who may decide a Gymnasium proposal.
 *
 * The type has one inhabitant on purpose. R1 is not a runtime check bolted onto
 * a general "decider" — the only decider the Gymnasium has a word for is the
 * Architect, so a caller trying to express "Artemis approved it" has nothing to
 * write down.
 */
export type GymDecider = 'architect'

export interface VerdictCheck {
  readonly allowed: boolean
  readonly because: string
}

/**
 * Contract: may this verdict be recorded?
 *
 * Two refusals, and both are R1: a decider who is not the Architect, and a
 * proposer deciding their own proposal. The second is redundant while only the
 * Architect can decide — and it stays anyway, because the day somebody adds a
 * second decider is the day it stops being redundant, and that is exactly the
 * day nobody will remember to add it.
 */
export function checkVerdict(row: GymRow, decidedBy: string, proposedBy: string): VerdictCheck {
  if (decidedBy !== 'architect') {
    return {
      allowed: false,
      because: `only the Architect may decide a Gymnasium proposal; "${decidedBy}" may not (R1)`
    }
  }
  if (decidedBy === proposedBy) {
    return { allowed: false, because: 'nothing self-approves (R1)' }
  }
  if (row.status !== 'proposed') {
    return { allowed: false, because: `${row.id} is already ${row.status}` }
  }
  return { allowed: true, because: 'the Architect decided it' }
}

/** Contract: the next id, given the rows already on file. Never reuses one. */
export function nextGymId(rows: readonly GymRow[]): string {
  const highest = rows.reduce((high, row) => {
    const parsed = Number.parseInt(row.id.slice('GYM-'.length), 10)
    return Number.isNaN(parsed) ? high : Math.max(high, parsed)
  }, 0)
  return `GYM-${String(highest + 1).padStart(3, '0')}`
}

/**
 * Contract: did the landed change hit its declared target?
 *
 * `null` for "could not be measured", which FR-12.4 treats exactly like a miss:
 * a change whose effect cannot be established is not a change that worked. The
 * comparison is deliberately not clever — the metric names its own target in
 * words, and a human reads both.
 */
export function measuredOutcome(measured: string | null): GymStatus {
  return measured === null ? 'regressed' : 'validated'
}

/**
 * Contract: R3's budget slice — has Gymnasium work used up its share?
 *
 * A slice, not a cap on the company: `spentTokens` counts only what gym work
 * spent, so a busy week of mission work never squeezes improvement out, and a
 * runaway improvement week never eats the missions.
 */
export function withinSlice(
  spentTokens: number,
  slice: { readonly tokensPerWeek: number }
): boolean {
  return spentTokens < slice.tokensPerWeek
}

export const DEFAULT_GYM_SLICE = { tokensPerWeek: 200_000 } as const

/** The ledger row, rendered as one line of the markdown table (FR-12.6). */
export function renderRow(row: GymRow): string {
  return [
    '',
    row.idCell.length > 0 ? row.idCell : row.id,
    row.title,
    row.status,
    row.metric,
    row.proposedAt,
    row.decidedAt ?? '',
    row.measured ?? '',
    row.outcome ?? '',
    ''
  ]
    .join(' | ')
    .trim()
}

/**
 * Contract: parses the rows out of the ledger markdown.
 *
 * The ledger is a table a human reads and a machine appends to, and this is the
 * reader. It skips the header, the separator, and the placeholder row the seed
 * archive ships with — which is why `— |` rows never become proposals.
 */
export function parseLedger(markdown: string): readonly GymRow[] {
  const rows: GymRow[] = []
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    // ['', id, title, status, metric, proposed, decided, measured, outcome, '']
    const idCell = cells[1] ?? ''
    // The id may be bare (`GYM-001`) or a link to its proposal file
    // (`[GYM-001](./proposals/…)`). The build-phase archive uses the link
    // form, so reading only the bare one made a seeded ledger look EMPTY —
    // and the next mint would then collide with a row already on the page.
    const id = /^\[?(GYM-\d{3,})\]?/.exec(idCell)?.[1]
    if (id === undefined) continue
    const status = gymStatusSchema.safeParse(cells[3])
    rows.push({
      id,
      idCell,
      title: cells[2] ?? '',
      class: 'craft',
      status: status.success ? status.data : 'proposed',
      metric: cells[4] ?? '',
      proposedBy: '',
      proposedAt: cells[5] ?? '',
      decidedBy: null,
      decidedAt: cells[6] === '' ? null : (cells[6] ?? null),
      measured: cells[7] === '' ? null : (cells[7] ?? null),
      outcome: cells[8] === '' ? null : (cells[8] ?? null)
    })
  }
  return rows
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Re-exported so the endpoint can name a proposer without importing agents. */
export const proposerSchema = agentIdSchema
