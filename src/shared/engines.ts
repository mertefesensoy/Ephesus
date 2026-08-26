import { z } from 'zod'

/**
 * Engine identity and hook-fidelity vocabulary (ADR-0009). These live in
 * src/shared/ because both planes need them: main keys its adapter registry by
 * `EngineId`, and the renderer's agent card displays the declared `HookSupport`
 * grade. Renderer code imports these as types only — the zod schemas here are
 * for main-side validation of untrusted input (BUILD-PROMPT §3.9).
 */

/** The engine roster fixed by ADR-0009. New engines are added here + an adapter. */
export const ENGINE_IDS = ['claude', 'codex', 'gemini', 'grok', 'opencode', 'custom'] as const

export const engineIdSchema = z.enum(ENGINE_IDS)

export type EngineId = z.infer<typeof engineIdSchema>

/**
 * Hook fidelity grade (ADR-0009): `native` > `wrapper` > `pty-heuristic`.
 * The grade is displayed on the agent card and scales down floor detail and
 * breaker sensitivity (SDD §3) — a degraded engine is honest about it (FR-2.3).
 */
export const HOOK_SUPPORTS = ['native', 'wrapper', 'pty-heuristic'] as const

export const hookSupportSchema = z.enum(HOOK_SUPPORTS)

export type HookSupport = z.infer<typeof hookSupportSchema>

/**
 * Numeric encoding of the ADR-0009 ordering, so "declared grade matches
 * demonstrated events" (TEST-STRATEGY §5 hook-grade honesty) is a comparison
 * rather than a hand-rolled switch in every caller. Higher = more faithful.
 */
export const HOOK_SUPPORT_RANK: Readonly<Record<HookSupport, number>> = {
  native: 2,
  wrapper: 1,
  'pty-heuristic': 0
}

/**
 * Contract: returns the `EngineId` for a well-known id, or null for anything
 * else. Never throws — callers decide whether an unknown id is a validation
 * error (IPC boundary) or a "no adapter installed" state (registry lookup).
 */
export function parseEngineId(raw: unknown): EngineId | null {
  const result = engineIdSchema.safeParse(raw)
  return result.success ? result.data : null
}
