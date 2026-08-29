/**
 * What the Stoa panel sees (SDD §5 `stoa:`).
 *
 * Separate from `stoa.ts` so the renderer and the preload can import these
 * types without pulling in zod — `shared/ipc.ts` and the sandboxed preload must
 * stay free of runtime dependencies (BUILD-PROMPT §10.4).
 */

/** One watchlist row, as the reading desk lists it. */
export interface SourceView {
  readonly id: string
  readonly url: string
  readonly kind: string
  readonly tags: readonly string[]
  readonly license: string
  /** Null means registered but not yet studiable (FR-13.2). */
  readonly pin: string | null
  readonly registeredAt: string
  readonly notes: string
  /** Retired rows are shown struck through, never hidden — nothing is deleted. */
  readonly retired: boolean
  /** Why this source cannot be studied yet, or null when it can. */
  readonly blocked: string | null
  /** Why pattern intake is refused, or null when the license permits it. */
  readonly intakeBlocked: string | null
}

/** One archived brief, as the desk lists it. */
export interface BriefView {
  readonly id: string
  readonly title: string
  readonly file: string
}

export type StoaCurated =
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: string }
