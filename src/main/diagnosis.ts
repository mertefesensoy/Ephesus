import path from 'node:path'
import { diagnose, renderDiagnosis, type DiagnosisInput } from '../shared/diagnosis'
import { writeFileAtomic } from './fsx'

/**
 * Writes `DIAGNOSIS.md` into the harness home (M8.13).
 *
 * ## Why the app writes it, and there is no CLI
 *
 * An offline `node scripts/diagnose.cjs` would be the obvious shape and it was
 * refused. `scripts/*.cjs` cannot import `src/shared/*.ts`, so it would have to
 * re-implement `parseLogLine` and the degradation vocabulary in plain JS — two
 * things that must agree, which is the defect class this repository names by
 * name. A TypeScript runner would be a new dependency, and BUILD-PROMPT §10
 * makes that a must-ask for what is a convenience.
 *
 * So the harness writes the file itself, often, and **the report states its own
 * age in its first line**. A stale report read as a current one would be a
 * degradation failing as good news, which is the one direction invariant §7
 * does not allow — so the fix is not to guarantee freshness, which no writer
 * can, but to make staleness impossible to miss.
 *
 * ## Contract
 *
 * `write()` NEVER throws. This runs at boot, on a trigger, and in the quit path;
 * a diagnostic that could crash the thing it is diagnosing would be worse than
 * no diagnostic, and the quit path in particular must not be blocked by a full
 * disk. A write that fails reports through the degradation channel — whose own
 * contract is that reporting cannot fail — and is otherwise skipped.
 *
 * The write is atomic (invariant §3): another process, or an agent, may be
 * reading this file at any moment, and a half-written report is a report that
 * lies.
 */
export interface DiagnosisWriterOptions {
  /** The harness home. The file lands at its root, beside `config.json`. */
  readonly home: string
  /** Everything the fold needs, gathered fresh on every write. */
  snapshot(): DiagnosisInput
  /** Best-effort disclosure of a write that failed. Must not throw. */
  onFailed(detail: string): void
}

/** The file an agent arriving cold is told to read first. */
export const DIAGNOSIS_FILE = 'DIAGNOSIS.md'

export class DiagnosisWriter {
  /**
   * Deliberately clockless. The report is rendered against the instant its own
   * snapshot was taken, so a clock here would be a second source of time that
   * had to agree with the first. An `at()` accessor existed briefly and had no
   * caller; the coverage floor is what noticed, which is the seam rule doing
   * exactly its job.
   */
  constructor(private readonly options: DiagnosisWriterOptions) {}

  /** Contract: never throws. Returns the path written, or null if it could not be. */
  write(): string | null {
    const target = path.join(this.options.home, DIAGNOSIS_FILE)
    try {
      const input = this.options.snapshot()
      // Rendered against the SAME instant it was taken, so the age line reads
      // "just now" at the moment of writing and grows honestly from there.
      const text = renderDiagnosis(diagnose(input), input.at)
      writeFileAtomic(target, text.endsWith('\n') ? text : `${text}\n`)
      return target
    } catch (err) {
      // Swallowed on purpose — see the contract. The condition still reaches
      // the Architect, through the one channel that promises it cannot fail.
      try {
        this.options.onFailed(
          `could not write ${DIAGNOSIS_FILE}: ${
            err instanceof Error ? err.message.split('\n')[0] : String(err)
          }`
        )
      } catch {
        /* a reporter that throws while reporting is not worth a second attempt */
      }
      return null
    }
  }

  /** The trigger id under which this runs on the scheduler. */
  static readonly TRIGGER_ID = 'diagnosis'

  /** How often it is rewritten while the company runs. */
  static readonly EVERY_MS = 60_000
}
