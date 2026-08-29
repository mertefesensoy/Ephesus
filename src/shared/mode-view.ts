/**
 * What the renderer sees of the company mode (SDD §5 `gym: mode() setMode(m)`).
 *
 * Separate from `mode.ts` so `shared/ipc.ts` and the sandboxed preload stay
 * free of runtime dependencies (BUILD-PROMPT §10.4) — `mode.ts` imports zod.
 */

export interface ModeView {
  readonly mode: 'directed' | 'improving'
  /** Whether the proof gate would let `improving` be enabled right now. */
  readonly gateMet: boolean
  /** Exactly what evidence is still missing (FR-14.3). Empty when met. */
  readonly missing: readonly string[]
  /** Whether `improving` has ever been enabled — the gate is a FIRST-enable check. */
  readonly everEnabled: boolean
}

export type ModeSet =
  | { readonly ok: true; readonly mode: 'directed' | 'improving' }
  | { readonly ok: false; readonly reason: string; readonly missing: readonly string[] }
