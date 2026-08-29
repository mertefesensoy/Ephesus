import type { CompanyMode } from '../shared/mode'

/**
 * The Stoa cadence tick (SDD §7.7, FR-14.4) — extracted so the SHIPPED body is
 * what the suites exercise (M5b close-out audit, finding 5: S-MODE and the
 * scheduler suite each rebuilt this trigger inline, so the production body was
 * exercised by nothing — the copy-of-the-wiring class the rig's own comments
 * warn about).
 *
 * Honest half-state, on the record (audit finding 1): in M5b the tick picks a
 * source, builds the study plan, and LOGS — the researcher-spawn leg that
 * turns a plan into a running study is M7's (IMPLEMENTATION), so in
 * `improving` today the cadence produces a visible heartbeat, not work. SDD
 * §7.7 carries the same note; when M7 wires the spawn, it lands here.
 */

export interface StoaCadenceDeps {
  /** The watchlist, as the Stoa reads it. */
  sources(): readonly { readonly id: string; readonly pin: string | null }[]
  /** Builds the read-only study plan for one source. */
  plan(sourceId: string): { readonly ok: boolean }
  /** The company mode at fire time (FR-14.1's tag). */
  mode(): CompanyMode
  /** `log.jsonl` kind `stoa` (SDD §4.3). */
  appendLog(draft: { kind: 'stoa' } & Record<string, unknown>): void
}

/** One cadence firing. Returns what it logged, for the record and the tests. */
export function stoaCadenceTick(deps: StoaCadenceDeps): {
  readonly fired: boolean
  readonly sourceId: string | null
} {
  const next = deps.sources().find((entry) => entry.pin !== null)
  if (next === undefined) {
    deps.appendLog({ kind: 'stoa', event: 'cadence-idle', because: 'no studiable source' })
    return { fired: false, sourceId: null }
  }
  const planned = deps.plan(next.id)
  deps.appendLog({
    kind: 'stoa',
    event: 'cadence-fired',
    sourceId: next.id,
    // FR-14.1: a record produced by autonomous initiative carries the mode it
    // ran under, so a later reader can tell what the company did because it
    // was asked from what it did on its own.
    mode: deps.mode(),
    planned: planned.ok
  })
  return { fired: true, sourceId: next.id }
}
