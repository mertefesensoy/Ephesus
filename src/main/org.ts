import { mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './fsx'
import { compileRetro, renderRetro, type OrgInput, type RetroReport } from '../shared/org'
import type { Trigger } from './scheduler'

/**
 * The org layer's driver (FR-11.5, UC-12).
 *
 * It computes and it archives. It does not decide: no reassignment, no hire,
 * no fire, no nudge. UC-12's loop puts a human between the numbers and any
 * action, and this module is deliberately the half of that loop that cannot
 * act — which is what makes it safe to run on a schedule.
 *
 * Retros archive beside the other Odeon artifacts because they are the same
 * kind of thing: a dated record of what the company did, written once and never
 * revised (invariant §5).
 */

/** Weekly, per FR-11.5's "scheduled review/retro reports". */
export const RETRO_EVERY_MS = 7 * 24 * 60 * 60 * 1_000

export interface OrgOptions {
  readonly agoraRoot: string
  /** Everything the metrics may read: the log, the cost ledger, the roster. */
  gather(): OrgInput
  /** `log` kind `orchestrator` (SDD §4.3) — the org layer's events. */
  onLogEvent?(draft: { kind: 'orchestrator' } & Record<string, unknown>): void
  commitSoon?(subject: string): void
  onDegraded?(detail: string): void
  now?(): Date
}

export interface RetroRecord {
  readonly ref: string
  readonly generatedAt: string
  readonly markdown: string
}

export class OrgLayer {
  private readonly now: () => Date

  constructor(private readonly options: OrgOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** The scheduler trigger. The third client, after reflection and standup. */
  trigger(everyMs: number = RETRO_EVERY_MS): Trigger {
    return {
      id: 'retro',
      everyMs,
      run: () => {
        this.generate()
      }
    }
  }

  /** The metrics as the Org tab reads them — recomputed, never cached. */
  report(): RetroReport {
    return compileRetro(this.options.gather())
  }

  /**
   * Generates and archives one retro.
   *
   * Contract: returns the archived ref. Two retros in the same millisecond
   * would collide on the name, so the second is refused rather than
   * overwriting the first — the archive only ever grows.
   */
  generate():
    { readonly ok: true; readonly ref: string } | { readonly ok: false; readonly reason: string } {
    const at = this.now()
    let report: RetroReport
    try {
      report = this.report()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.options.onDegraded?.(`retro could not be generated: ${reason}`)
      return { ok: false, reason }
    }

    const dir = this.retroDir()
    mkdirSync(dir, { recursive: true })
    const name = `${at.toISOString().replace(/[:.]/g, '-')}.md`
    const file = path.join(dir, name)
    if (existsSync(file)) return { ok: false, reason: `a retro is already archived at ${name}` }

    writeFileAtomic(file, renderRetro(report, at.toISOString()))
    const ref = path.posix.join('odeon', 'retros', name)
    this.options.onLogEvent?.({
      kind: 'orchestrator',
      event: 'retro',
      retroRef: ref,
      agents: report.metrics.length,
      findings: report.findings.length,
      fromSeq: report.window.fromSeq,
      toSeq: report.window.toSeq
    })
    this.options.commitSoon?.(`odeon: retro ${name}`)
    return { ok: true, ref }
  }

  /** Every archived retro, newest first. */
  retros(): readonly RetroRecord[] {
    const dir = this.retroDir()
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort((a, b) => b.localeCompare(a))
      .map((name) => ({
        ref: path.posix.join('odeon', 'retros', name),
        generatedAt: name.replace(/\.md$/, ''),
        markdown: readFileSync(path.join(dir, name), 'utf8')
      }))
  }

  private retroDir(): string {
    return path.join(this.options.agoraRoot, 'odeon', 'retros')
  }
}
