/**
 * What the Gymnasium panel sees (SDD §5 `gym:`).
 *
 * Separate from `gym.ts` so the renderer and the preload can import these types
 * without pulling in zod — `shared/ipc.ts` and the sandboxed preload must stay
 * free of runtime dependencies (BUILD-PROMPT §10.4).
 */

/** One ledger row, as the panel lists it. */
export interface GymRowView {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly metric: string
  readonly proposedAt: string
  readonly decidedAt: string | null
  readonly outcome: string | null
}

export type GymDecided =
  | { readonly ok: true; readonly id: string; readonly status: string }
  | { readonly ok: false; readonly reason: string }
