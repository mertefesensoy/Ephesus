import { z } from 'zod'
import type { GymRow } from './gym'

/**
 * Company modes and the proof gate (ADR-0018, FR-14, SRS §6.9, SDD §9, UC-15).
 *
 * ADR-0015 answered *how* the company improves itself. This answers *when it is
 * allowed to start doing so on its own initiative* — and the answer is
 * deliberately not "whenever the Architect feels like it".
 *
 * - **`directed`** (the default): the Stoa and Gymnasium cadences run only on
 *   demand. The company improves itself when asked to.
 * - **`improving`**: those cadences fire autonomously. Gating is IDENTICAL —
 *   every proposal still reaches the Architect (FR-14.4). The mode governs
 *   *initiative*, never *approval*, and confusing the two is the failure this
 *   whole module exists to prevent.
 *
 * The first enable is **mechanically refused** until the company has proved, on
 * its own record, that the loop works (FR-14.3). Not argued — proved: three
 * proposals all the way through to measurement, two of them validated, one
 * seeded by outside evidence, and no proposal that ever landed without an
 * Architect verdict. The check reads the Gymnasium ledger and the event log and
 * nothing else, because a gate that consulted a computed cache would be a gate
 * measuring its own opinion.
 *
 * Reverting is always one ungated action (FR-14.2), and a rung-3 breaker stop
 * on gym/stoa work reverts it without asking (FR-14.5). The asymmetry is the
 * design: turning autonomy ON is hard and turning it OFF is trivial.
 */

export const COMPANY_MODES = ['directed', 'improving'] as const

export const companyModeSchema = z.enum(COMPANY_MODES)

export type CompanyMode = z.infer<typeof companyModeSchema>

/** The mode a company that has never been told otherwise runs in. */
export const DEFAULT_MODE: CompanyMode = 'directed'

/**
 * The roles autonomy itself creates (ADR-0019's profile vocabulary). A rung-3
 * breaker stop reverts the company mode ONLY when the stopped agent held one
 * of these roles (FR-14.5) — a stop on ordinary mission work must never
 * switch self-improvement off for reasons that had nothing to do with it.
 */
export const IMPROVEMENT_ROLES = ['researcher', 'improver'] as const

/**
 * Exact role equality, not a substring test: the old `includes('improv')`
 * heuristic lived untested in `index.ts` and would have counted a mission
 * hire named "process-improver-docs" as gym work (M5b close-out audit,
 * finding 12). Roles are the roster's vocabulary; when ADR-0019's profile
 * adds one, it is added HERE, visibly.
 */
export function isImprovementRole(role: string): boolean {
  return (IMPROVEMENT_ROLES as readonly string[]).includes(role.trim().toLowerCase())
}

/**
 * SRS §6.9's numbers, in one place and named.
 *
 * They live here rather than inline so the gate and its test read the same
 * figures, and so changing one is a visible edit to a constant the SRS names
 * rather than a number buried in a comparison.
 */
export const PROOF_GATE = {
  /** Proposals taken all the way through: proposed → verdict → landed → measured. */
  fullLoop: 3,
  /** …of which this many must have hit their declared metric. */
  validated: 2,
  /** …and this many must descend from outside evidence (a Stoa brief). */
  stoaSeeded: 1
} as const

export interface ProofGateResult {
  readonly met: boolean
  /** Exactly what is still missing (FR-14.3). Empty when the gate is met. */
  readonly missing: readonly string[]
  /** What the check actually counted, so a refusal can be argued with. */
  readonly counted: {
    readonly fullLoop: number
    readonly validated: number
    readonly stoaSeeded: number
    readonly gatingViolations: readonly string[]
  }
}

/** One `gym` event as the gate reads it — the log's own shape, narrowed. */
export interface GymLogEvent {
  readonly event?: unknown
  readonly gymId?: unknown
  readonly evidence?: unknown
}

/**
 * Contract: is the company allowed to enable `improving` for the first time?
 *
 * Reads ONLY the ledger rows and the `gym` log events (FR-14.3). Returns every
 * missing item at once, because the Architect's next question after a refusal
 * is "what else?" and answering it one round trip at a time is a bad way to
 * hold a gate.
 *
 * A "gating violation" is the one condition that cannot be fixed by waiting: a
 * proposal that reached `landed` or beyond with NO Architect verdict anywhere —
 * neither an `approved` event on the log nor a Decided date on its ledger row.
 * If that has ever happened the loop is not merely immature, it is broken, and
 * no amount of further evidence should open this gate.
 */
export function checkProofGate(
  rows: readonly GymRow[],
  gymEvents: readonly GymLogEvent[]
): ProofGateResult {
  const approved = new Set<string>()
  const stoaSeeded = new Set<string>()
  for (const entry of gymEvents) {
    const id = typeof entry.gymId === 'string' ? entry.gymId : null
    if (id === null) continue
    if (entry.event === 'approved') approved.add(id)
    if (entry.event === 'proposed' && citesBrief(entry.evidence)) stoaSeeded.add(id)
  }

  // "Through the full loop" means measured, and a row is only measured once it
  // has an outcome — `validated` or `regressed`. A regressed row counts: the
  // loop worked, the change did not, and ADR-0015 R2 keeps it precisely
  // because that is evidence the company can measure its own failures.
  const measured = rows.filter((row) => row.status === 'validated' || row.status === 'regressed')
  const validated = measured.filter((row) => row.status === 'validated')
  const seeded = measured.filter((row) => stoaSeeded.has(row.id))

  const landedOrBeyond = rows.filter(
    (row) => row.status === 'landed' || row.status === 'validated' || row.status === 'regressed'
  )
  // A verdict counts when EITHER the log carries the `approved` event or the
  // ledger row carries a Decided date. Both are permitted inputs (FR-14.3), and
  // requiring the log alone was wrong in a way only a live run could show: a
  // ledger seeded from the build-phase archive (FR-12.6) inherits rows that
  // WERE decided by the Architect — the archive records the date — while the
  // fresh log has no events for them at all. Every seeded row therefore read as
  // a gating violation, and since a violation is absorbing, the gate could
  // never open on any company that inherited an archive. That is every company.
  const gatingViolations = landedOrBeyond
    .filter((row) => !approved.has(row.id) && (row.decidedAt ?? '').trim() === '')
    .map((row) => `${row.id} reached ${row.status} with no Architect verdict on the ledger or log`)

  const missing: string[] = []
  if (measured.length < PROOF_GATE.fullLoop) {
    missing.push(
      `${String(PROOF_GATE.fullLoop)} proposals through the full loop (proposed → verdict → landed → measured); ${String(measured.length)} on the ledger`
    )
  }
  if (validated.length < PROOF_GATE.validated) {
    missing.push(
      `${String(PROOF_GATE.validated)} of them validated against their declared metric; ${String(validated.length)} so far`
    )
  }
  if (seeded.length < PROOF_GATE.stoaSeeded) {
    missing.push(
      `${String(PROOF_GATE.stoaSeeded)} measured proposal seeded by a Stoa brief (evidence citing an RB id); ${String(seeded.length)} so far`
    )
  }
  for (const violation of gatingViolations) {
    missing.push(`a gating violation is on the record and cannot be waited out — ${violation}`)
  }

  return {
    met: missing.length === 0,
    missing,
    counted: {
      fullLoop: measured.length,
      validated: validated.length,
      stoaSeeded: seeded.length,
      gatingViolations
    }
  }
}

/** Does this proposal's evidence cite a research brief? */
function citesBrief(evidence: unknown): boolean {
  return (
    Array.isArray(evidence) &&
    evidence.some((ref) => typeof ref === 'string' && /\bRB-\d{3,}\b/.test(ref))
  )
}

export interface ModeCheck {
  readonly allowed: boolean
  readonly because: string
}

/**
 * Contract: may this actor change the company mode? (FR-14.2)
 *
 * One inhabitant again — `architect` — and for the sharpest reason yet: this is
 * the switch that decides whether the company acts without being asked. An
 * agent that could set `improving` could grant itself initiative, which is the
 * authority problem in its purest form.
 */
export function checkModeSetter(who: string): ModeCheck {
  if (who !== 'architect') {
    return {
      allowed: false,
      because: `only the Architect may change the company mode; "${who}" may not (FR-14.2). No agent or harness path can enable improving.`
    }
  }
  return { allowed: true, because: 'the Architect set the mode' }
}

/**
 * Contract: is the proof gate consulted for this transition? (FR-14.3)
 *
 * Only when turning autonomy ON, and only the FIRST time — thereafter the
 * company has already proved it. Reverting is never gated: FR-14.2 makes
 * `directed` always one action away, and a gate on the way *out* would be a
 * gate that traps the Architect in autonomy.
 */
export function gateApplies(from: CompanyMode, to: CompanyMode, everEnabled: boolean): boolean {
  return to === 'improving' && from !== 'improving' && !everEnabled
}
