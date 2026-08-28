import {
  DEFAULT_MODE,
  checkModeSetter,
  checkProofGate,
  gateApplies,
  type CompanyMode,
  type GymLogEvent,
  type ProofGateResult
} from '../shared/mode'
import type { GymRow } from '../shared/gym'

/**
 * The company mode driver (ADR-0018, FR-14, SDD §9, UC-15).
 *
 * The mode decides whether the Stoa and Gymnasium cadences fire on their own.
 * That makes this the switch with the largest blast radius in the system, and
 * the shape of the class follows from that:
 *
 * - **Only the Architect sets it** (FR-14.2). `setMode(m, by)` takes the actor
 *   from the caller and the only caller that may pass `architect` is the IPC
 *   handler — the `gym.verdict` pattern, for the third time and the sharpest
 *   reason: an agent that could enable `improving` could grant itself
 *   initiative.
 * - **Turning it on is hard; turning it off is trivial.** The first enable is
 *   refused until SRS §6.9's evidence is on the record. Reverting is never
 *   gated, never refused, and never asks a question.
 * - **The mode governs initiative, never approval.** Nothing here touches
 *   gating. Every proposal reaches the Architect in both modes (FR-14.4), and
 *   if that ever stops being true the mode has become something else.
 */

export interface ModesOptions {
  /** Reads the persisted mode; absent means `directed`. */
  read(): { readonly mode: CompanyMode | undefined; readonly everEnabled: boolean }
  /** Persists the mode. Atomic write is the config store's job, not this one's. */
  write(patch: { readonly mode: CompanyMode; readonly everEnabled: boolean }): void
  /** The Gymnasium ledger rows — one of the gate's two permitted inputs. */
  rows(): readonly GymRow[]
  /** The `gym` events from `log.jsonl` — the gate's other permitted input. */
  gymEvents(): readonly GymLogEvent[]
  /** `log` kind `gym` (SDD §4.3) — every mode change and every refusal. */
  onLogEvent?(draft: { kind: 'gym' } & Record<string, unknown>): void
  /** Writes the change to the Gymnasium ledger document (FR-14.5, UC-15). */
  recordOnLedger?(change: {
    readonly from: CompanyMode
    readonly to: CompanyMode
    readonly by: string
    readonly reason: string
    readonly at: string
  }): void
  /** Pushed so the status strip re-reads (FR-14.1 — visible at all times). */
  onChanged?(mode: CompanyMode): void
  now?(): Date
}

export type SetModeOutcome =
  | { readonly ok: true; readonly mode: CompanyMode }
  | { readonly ok: false; readonly reason: string; readonly missing: readonly string[] }

export class CompanyModes {
  private readonly now: () => Date

  constructor(private readonly options: ModesOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** The mode right now. Never throws; an unreadable config means `directed`. */
  mode(): CompanyMode {
    return this.options.read().mode ?? DEFAULT_MODE
  }

  /** What the gate would say if asked now — for the panel, before the click. */
  gate(): ProofGateResult {
    return checkProofGate(this.options.rows(), this.options.gymEvents())
  }

  /**
   * Sets the company mode (FR-14.2, FR-14.3).
   *
   * Contract: `by` comes from the caller and must be `architect`. Enabling
   * `improving` for the first time consults the proof gate and refuses with the
   * exact missing evidence; every other transition is unconditional.
   */
  setMode(to: CompanyMode, by: string): SetModeOutcome {
    const allowed = checkModeSetter(by)
    if (!allowed.allowed) {
      this.options.onLogEvent?.({
        kind: 'gym',
        event: 'mode-refused',
        by,
        to,
        because: allowed.because
      })
      return { ok: false, reason: allowed.because, missing: [] }
    }

    const current = this.options.read()
    const from = current.mode ?? DEFAULT_MODE
    if (from === to) return { ok: true, mode: to }

    if (gateApplies(from, to, current.everEnabled)) {
      const gate = this.gate()
      if (!gate.met) {
        // FR-14.3: refused with the missing evidence LISTED. A refusal that
        // said only "not yet" would leave the Architect guessing at a bar the
        // system can state exactly.
        this.options.onLogEvent?.({
          kind: 'gym',
          event: 'mode-refused',
          by,
          to,
          missing: [...gate.missing],
          counted: { ...gate.counted, gatingViolations: [...gate.counted.gatingViolations] }
        })
        return {
          ok: false,
          reason: 'the proof gate is not met (SRS §6.9)',
          missing: gate.missing
        }
      }
    }

    return this.commit(from, to, by, this.reasonFor(to, by))
  }

  /**
   * Reverts to `directed` after a rung-3 breaker stop (FR-14.5).
   *
   * Contract: automatic, unrefusable, and NOT an Architect action — the log and
   * the ledger say the breaker did it, so nobody later reads this as the
   * Architect having changed their mind. Only the Architect can restore
   * `improving` afterwards, and `everEnabled` is preserved so restoring it does
   * not re-run the gate: a safety stop is not a demotion.
   */
  revertOnBreaker(detail: string): SetModeOutcome {
    const current = this.options.read()
    const from = current.mode ?? DEFAULT_MODE
    if (from !== 'improving') return { ok: true, mode: from }
    return this.commit(from, 'directed', 'breaker', `rung-3 stop on gym/stoa work — ${detail}`)
  }

  private commit(from: CompanyMode, to: CompanyMode, by: string, reason: string): SetModeOutcome {
    const at = this.now().toISOString()
    this.options.write({
      mode: to,
      // Sticky: once the company has proved the loop works, it has proved it.
      everEnabled: this.options.read().everEnabled || to === 'improving'
    })
    this.options.onLogEvent?.({ kind: 'gym', event: 'mode-changed', from, to, by, reason })
    this.options.recordOnLedger?.({ from, to, by, reason, at })
    this.options.onChanged?.(to)
    return { ok: true, mode: to }
  }

  private reasonFor(to: CompanyMode, by: string): string {
    return to === 'improving'
      ? `${by} enabled autonomous initiative; the proof gate was met`
      : `${by} returned the company to directed work`
  }
}
