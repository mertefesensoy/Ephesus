import {
  CONSENT_TERMS_VERSION,
  decideConsent,
  type ConsentDisclosure,
  type ConsentGrantOutcome,
  type ConsentRecord,
  type ConsentVerdict,
  type ConsentView
} from '../shared/consent'
import type { DegradationCause } from '../shared/degradation'

/**
 * The consent gate's wiring (DD-6, M8.12) — the one thing standing between boot
 * and a company that spends money.
 *
 * ## Why this is a class and not four lines in `index.ts`
 *
 * `index.ts` boot wiring has produced three dead-code findings in this
 * repository's history — the Herald, M7.2's inert trigger, M7.7's silent
 * standup — every one of them behind a green suite, because nothing but the
 * real Electron boot could reach the code. A gate written inline there would be
 * a refusal nobody could test in the direction that matters (that it actually
 * refuses).
 *
 * So every effect is injected and the class is driven directly by
 * `test/main/consent-gate.test.ts`. `index.ts` keeps the construction and one
 * `boot()` call.
 *
 * ## What consent covers: the company starting work, not just the hire
 *
 * Recorded in DECISIONS-LOG 2026-09-07. A gate that only guarded
 * `artemis.start` would leave `scheduler.start()` one line below it, and
 * `triggers.json` on the Architect's own machine shows `standup`, `retro` and
 * `gym-metric-check` sharing a timestamp — the first tick fires all three
 * sixty seconds in. "The gate guards the hire" and "the gate guards the company
 * starting work" are different products, and the second is the one the register
 * asked for.
 *
 * The trigger clock is deliberately withheld WHOLE rather than per-trigger.
 * `Scheduler` skips a disabled trigger without stamping its clock, so gating
 * each cadence's `enabled()` would give the same behaviour with more places to
 * forget; and a trigger armed later by a restored activation (M8.8) would be
 * armed *unguarded*, which is the failure this class exists to prevent.
 *
 * ## Contract
 *
 * - `boot()` starts work only when consent is granted, and reports a visible
 *   degradation when it is not (invariant §7 — a withheld company must not look
 *   like an idle one).
 * - `grant()` is idempotent, persists BEFORE starting, and refuses to start on
 *   a grant it could not write down: work running under a consent the next boot
 *   will not find is worse than a click that reports why it failed.
 * - Work starts at most once per process, whichever path reaches it.
 */
export interface CompanyStartOptions {
  /**
   * The standing record. Read on every call rather than captured, so a grant
   * written this session is seen by the next `view()` without a second copy of
   * the truth living here.
   */
  record(): ConsentRecord | undefined
  /**
   * Persists a grant. Contract: throws if it could not be written — that throw
   * is the difference between a consent that survives a restart and one that
   * does not, so it must not be swallowed by the caller either.
   */
  save(record: ConsentRecord): void
  /**
   * What would happen if consent were granted, read off the live configuration
   * at ASK time. Never captured at construction: the engines register and the
   * triggers are added around this class, and a disclosure frozen before them
   * would describe a company that does not exist.
   */
  disclose(): ConsentDisclosure
  /** Hires the orchestrator (`artemis.start`). */
  hire(): void
  /** Starts the trigger clock (`scheduler.start`). */
  startSchedule(): void
  report(cause: DegradationCause, detail: string): void
  clear(cause: DegradationCause): void
  now?(): Date
  /** Overridable so a test can move the terms without editing the shipped one. */
  readonly termsVersion?: number
}

/** The one condition this gate reports. Stable, so a clear finds it again. */
export const CONSENT_WITHHELD: DegradationCause = 'consent/not-granted'

/** A grant that could not be written down. Distinct: this one IS a failure. */
export const CONSENT_UNWRITABLE: DegradationCause = 'consent/unwritable'

export class CompanyStart {
  /** Work starts at most once per process, whether from boot or from a grant. */
  private started = false
  private readonly now: () => Date
  private readonly termsVersion: number

  constructor(private readonly options: CompanyStartOptions) {
    this.now = options.now ?? (() => new Date())
    this.termsVersion = options.termsVersion ?? CONSENT_TERMS_VERSION
  }

  /** The current verdict, decided fresh from the record every time. */
  verdict(): ConsentVerdict {
    return decideConsent(this.options.record(), this.termsVersion)
  }

  view(): ConsentView {
    const verdict = this.verdict()
    const record = this.options.record()
    return {
      state: verdict.state,
      mayStartWork: verdict.mayStartWork,
      because: verdict.because,
      terms: this.termsVersion,
      grantedAt: record?.grantedAt ?? null,
      disclosure: this.options.disclose()
    }
  }

  /**
   * Boot's one question. Starts the company when consent is on file; otherwise
   * reports the withheld state and starts nothing.
   *
   * Returns the verdict so the caller can log what it decided — boot is the one
   * place where "nothing happened" and "nothing was supposed to happen" have to
   * be told apart in the book of record.
   */
  boot(): ConsentVerdict {
    const verdict = this.verdict()
    if (verdict.mayStartWork) {
      this.startWork()
      return verdict
    }
    this.options.report(
      CONSENT_WITHHELD,
      `the company is not working: ${verdict.because}. Grant it on the banner at the ` +
        'top of the app to hire the orchestrator and start the schedules'
    )
    return verdict
  }

  /**
   * The Architect says go.
   *
   * Persist first. A grant that started the company but failed to reach disk
   * would run agents this session and ask again at the next boot, with tokens
   * already spent against a consent nothing records — the one outcome worse
   * than a button that reports its own failure.
   */
  grant(): ConsentGrantOutcome {
    if (this.verdict().mayStartWork) {
      // Idempotent: a second click, a second window, or a grant racing boot.
      // Never re-writes `grantedAt` — the record says when consent was FIRST
      // given, and overwriting it would quietly erase how long the company has
      // been authorised.
      this.startWork()
      return { ok: true, reason: null, view: this.view() }
    }
    const record: ConsentRecord = {
      grantedAt: this.now().toISOString(),
      terms: this.termsVersion
    }
    try {
      this.options.save(record)
    } catch (err) {
      const because = err instanceof Error ? err.message.split('\n')[0] : String(err)
      this.options.report(
        CONSENT_UNWRITABLE,
        `consent could not be written to config.json, so the company has NOT started — ${
          because ?? 'unknown error'
        }`
      )
      return {
        ok: false,
        reason: `consent could not be recorded: ${because ?? 'unknown error'}`,
        view: this.view()
      }
    }
    this.options.clear(CONSENT_UNWRITABLE)
    this.options.clear(CONSENT_WITHHELD)
    this.startWork()
    return { ok: true, reason: null, view: this.view() }
  }

  private startWork(): void {
    if (this.started) return
    this.started = true
    this.options.hire()
    this.options.startSchedule()
  }
}
